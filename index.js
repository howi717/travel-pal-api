/* eslint-disable no-console */
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Redis = require("ioredis");

// Google Play verify
const { google } = require("googleapis");

console.log("RUNNING BACKEND VERSION 1001");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   ENV
========================================================= */

const REDIS_URL = process.env.REDIS_URL;

const FREE_LIMIT_PER_DAY = Number(process.env.FREE_LIMIT_PER_DAY || 2);
const CREDITS_PER_TOPUP = Number(process.env.CREDITS_PER_TOPUP || 150);

const GOOGLE_PLAY_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME;

// service account JSON can be:
// 1) raw json string
// 2) base64-encoded json string
const GOOGLE_PLAY_SERVICE_ACCOUNT_JSON =
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;

const DEV_BYPASS_TOKEN = process.env.DEV_BYPASS_TOKEN || ""; // optional

/* =========================================================
   REDIS
========================================================= */

const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

// Use UTC date keys (stable and predictable)
function utcDayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function creditsKey(userId) {
  return `tp:credits:${userId}`;
}

function freeUsedKey(userId, dayKey) {
  return `tp:free_used:${userId}:${dayKey}`;
}

function purchaseKey(purchaseToken) {
  return `tp:purchase:${purchaseToken}`;
}

/* =========================================================
   OPENAI (Responses API)
========================================================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL_ANALYZE =
  process.env.OPENAI_MODEL_ANALYZE || "gpt-4.1-mini";
const OPENAI_MODEL_TRANSLATE =
  process.env.OPENAI_MODEL_TRANSLATE || "gpt-4.1-mini";
const OPENAI_MODEL_PERSON =
  process.env.OPENAI_MODEL_PERSON || "gpt-4.1-nano";

async function openaiResponsesCreate(body) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${raw}`);
  return JSON.parse(raw);
}

function extractOutputText(parsed) {
  if (typeof parsed?.output_text === "string") return parsed.output_text;

  if (Array.isArray(parsed?.output)) {
    for (const item of parsed.output) {
      if (item?.type === "message" && Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && typeof c?.text === "string") {
            return c.text;
          }
        }
      }
    }
  }

  return null;
}

/* =========================================================
   GOOGLE PLAY (Android Publisher)
========================================================= */

function parseServiceAccountJson() {
  if (!GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) return null;

  const raw = GOOGLE_PLAY_SERVICE_ACCOUNT_JSON.trim();

  // Try raw JSON first
  try {
    return JSON.parse(raw);
  } catch {}

  // Try base64
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (e) {
    console.error("Failed to parse GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:", e);
    return null;
  }
}

async function getAndroidPublisherClient() {
  const sa = parseServiceAccountJson();
  if (!sa) throw new Error("Missing/invalid GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");

  const auth = new google.auth.GoogleAuth({
    credentials: sa,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });

  const client = await auth.getClient();

  return google.androidpublisher({
    version: "v3",
    auth: client,
  });
}

/* =========================================================
   QUOTA / CREDITS ATOMIC (Lua)
========================================================= */

/**
 * consumeUsageScript:
 * If free used < limit -> INCR free_used and allow
 * else if credits > 0 -> DECR credits and allow
 * else deny
 *
 * KEYS:
 * 1 = freeUsedKey
 * 2 = creditsKey
 *
 * ARGV:
 * 1 = freeLimitPerDay
 *
 * RETURNS array:
 * [allowed(0/1), usedFree(0/1), freeUsedAfter, creditsAfter]
 */
const LUA_CONSUME_USAGE = `
local freeKey = KEYS[1]
local creditsKey = KEYS[2]
local freeLimit = tonumber(ARGV[1])

local freeUsed = tonumber(redis.call("GET", freeKey) or "0")
local credits = tonumber(redis.call("GET", creditsKey) or "0")

if freeUsed < freeLimit then
  freeUsed = redis.call("INCR", freeKey)
  return {1, 1, freeUsed, credits}
end

if credits > 0 then
  credits = redis.call("DECR", creditsKey)
  if credits < 0 then
    redis.call("SET", creditsKey, "0")
    credits = 0
  end
  return {1, 0, freeUsed, credits}
end

return {0, 0, freeUsed, credits}
`;

/**
 * addCreditsIfNewPurchase:
 * Idempotency: if purchaseKey exists -> return 0 (no-op)
 * else set purchaseKey=1 with TTL and INCR credits
 *
 * KEYS:
 * 1 = purchaseKey
 * 2 = creditsKey
 *
 * ARGV:
 * 1 = creditsToAdd
 * 2 = purchaseTtlSeconds
 *
 * RETURNS:
 * [didAdd(0/1), creditsAfter]
 */
const LUA_ADD_CREDITS_IF_NEW_PURCHASE = `
local pKey = KEYS[1]
local cKey = KEYS[2]
local add = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if redis.call("EXISTS", pKey) == 1 then
  local credits = tonumber(redis.call("GET", cKey) or "0")
  return {0, credits}
end

redis.call("SET", pKey, "1", "EX", ttl)
local creditsAfter = redis.call("INCRBY", cKey, add)
return {1, creditsAfter}
`;

async function getCreditsStatus(userId) {
  if (!redis) throw new Error("NO_REDIS");

  const day = utcDayKey();
  const [usedRaw, creditsRaw] = await redis.mget(
    freeUsedKey(userId, day),
    creditsKey(userId)
  );

  const used = Number(usedRaw || 0);
  const credits = Number(creditsRaw || 0);

  const freeRemaining = Math.max(0, FREE_LIMIT_PER_DAY - used);

  return {
    freeToday: {
      limit: FREE_LIMIT_PER_DAY,
      used,
      remaining: freeRemaining,
      day,
    },
    credits: { remaining: credits },
  };
}

/* =========================================================
   HELPERS
========================================================= */

function getUserId(req) {
  const userId = String(req.header("x-user-id") || "").trim();
  if (!userId) return null;
  return userId;
}

function isDevBypass(req) {
  if (!DEV_BYPASS_TOKEN) return false;
  const t = String(req.header("x-dev-bypass") || "").trim();
  return t && t === DEV_BYPASS_TOKEN;
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/credits", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-user-id" });

    const status = await getCreditsStatus(userId);
    return res.json(status);
  } catch (e) {
    return res.status(500).json({ error: e.message || "CREDITS_ERROR" });
  }
});

/**
 * Analyze:
 * - Requires x-user-id (unless dev bypass)
 * - Atomically consumes free/credit BEFORE OpenAI call
 * - Returns data + quota status
 */
app.post("/analyze", async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64)
      return res.status(400).json({ error: "Missing imageBase64" });

    const devBypass = isDevBypass(req);
    const userId = devBypass ? "dev_bypass" : getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-user-id" });
    if (!redis) return res.status(500).json({ error: "NO_REDIS" });

    // Consume quota atomically (unless bypass)
    let quotaSnapshot = null;

    if (!devBypass) {
      const day = utcDayKey();
      // Set TTL for freeUsedKey so it doesn't grow forever (e.g. 3 days)
      const freeKey = freeUsedKey(userId, day);
      const cKey = creditsKey(userId);

      const result = await redis.eval(
        LUA_CONSUME_USAGE,
        2,
        freeKey,
        cKey,
        String(FREE_LIMIT_PER_DAY)
      );

      const allowed = Number(result[0]) === 1;
      const freeUsedAfter = Number(result[2]);
      const creditsAfter = Number(result[3]);

      // Ensure free-used key expires (best-effort)
      await redis.expire(freeKey, 60 * 60 * 24 * 3).catch(() => {});

      const freeRemaining = Math.max(0, FREE_LIMIT_PER_DAY - freeUsedAfter);

      quotaSnapshot = {
        freeToday: {
          limit: FREE_LIMIT_PER_DAY,
          used: freeUsedAfter,
          remaining: freeRemaining,
          day,
        },
        credits: { remaining: creditsAfter },
      };

      if (!allowed) {
        return res.status(402).json({
          error: "PAYWALL",
          ...quotaSnapshot,
        });
      }
    }

    // OpenAI schema (IMPORTANT: additionalProperties: false required by OpenAI json_schema)
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        landmark: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            essentialInfo: { type: "string" },
            location: { type: "string" },
            relatedPersons: {
              type: "array",
              items: { type: "string" },
            },
            funFact: { type: "string" },
            kind: { type: "string" },
          },
          required: [
            "name",
            "essentialInfo",
            "location",
            "relatedPersons",
            "funFact",
            "kind",
          ],
        },
      },
      required: ["landmark"],
    };

    const prompt = `
Analyze the image and describe what you see.

Output in English.
Never include header words inside field values.
`.trim();

    const body = {
      model: OPENAI_MODEL_ANALYZE,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${imageBase64}`,
            },
          ],
        },
      ],
      max_output_tokens: 1000,
      text: {
        format: {
          type: "json_schema",
          name: "travel_pal_landmark_en",
          schema,
          strict: true,
        },
      },
    };

    const parsed = await openaiResponsesCreate(body);
    const outputText = extractOutputText(parsed);
    if (!outputText) return res.status(500).json({ error: "No output_text" });

    const data = JSON.parse(outputText);

    // If dev bypass, return actual status too if possible
    if (!quotaSnapshot && redis && userId && userId !== "dev_bypass") {
      quotaSnapshot = await getCreditsStatus(userId);
    }

    return res.json({
      data,
      ...(quotaSnapshot || {}),
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: err.message || "ANALYZE_ERROR" });
  }
});

/**
 * Translate:
 * - Requires x-user-id (for future quota, currently free)
 */
app.post("/translate", async (req, res) => {
  try {
    const userId = getUserId(req) || "anonymous";
    const { text, lang } = req.body || {};
    if (!text || !lang)
      return res.status(400).json({ error: "Missing text/lang" });

    const prompt = `
Translate the following text into ${lang}.
Keep the same structure and headers.
Do not add extra commentary.

TEXT:
${text}
`.trim();

    const body = {
      model: OPENAI_MODEL_TRANSLATE,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      max_output_tokens: 1200,
    };

    const parsed = await openaiResponsesCreate(body);
    const out = extractOutputText(parsed);
    if (!out) return res.status(500).json({ error: "No output_text" });

    return res.json({ text: out, userId });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: err.message || "TRANSLATE_ERROR" });
  }
});

/**
 * Verify purchase (topup)
 * Body: { productId, purchaseToken }
 * - Verifies with Google Play
 * - Consumes the purchase (so it can be bought again)
 * - Atomically increments credits (idempotent by purchaseToken)
 */
app.post("/verify-purchase", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ error: "Missing x-user-id" });
    if (!redis) return res.status(500).json({ error: "NO_REDIS" });

    const { productId, purchaseToken } = req.body || {};
    if (!productId || !purchaseToken) {
      return res.status(400).json({ error: "Missing productId/purchaseToken" });
    }

    if (!GOOGLE_PLAY_PACKAGE_NAME) {
      return res.status(500).json({ error: "Missing GOOGLE_PLAY_PACKAGE_NAME" });
    }

    const androidpublisher = await getAndroidPublisherClient();

    // 1) Verify purchase
    const getResp = await androidpublisher.purchases.products.get({
      packageName: GOOGLE_PLAY_PACKAGE_NAME,
      productId,
      token: purchaseToken,
    });

    const p = getResp.data || {};

    // purchaseState: 0 Purchased, 1 Canceled, 2 Pending
    const purchaseState = Number(p.purchaseState);
    if (purchaseState !== 0) {
      return res.status(402).json({
        error: "PURCHASE_NOT_COMPLETED",
        purchaseState,
      });
    }

    // 2) Consume for topup products
    await androidpublisher.purchases.products.consume({
      packageName: GOOGLE_PLAY_PACKAGE_NAME,
      productId,
      token: purchaseToken,
    });

    // 3) Atomically add credits if purchaseToken not used
    const ttlSeconds = 60 * 60 * 24 * 365; // 1 year idempotency
    const pKey = purchaseKey(purchaseToken);
    const cKey = creditsKey(userId);

    const r = await redis.eval(
      LUA_ADD_CREDITS_IF_NEW_PURCHASE,
      2,
      pKey,
      cKey,
      String(CREDITS_PER_TOPUP),
      String(ttlSeconds)
    );

    const didAdd = Number(r[0]) === 1;
    const creditsAfter = Number(r[1]);

    const status = await getCreditsStatus(userId);

    return res.json({
      ok: true,
      didAdd,
      creditsAfter,
      ...status,
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ error: err.message || "VERIFY_ERROR" });
  }
});

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});