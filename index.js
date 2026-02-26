/* eslint-disable no-console */
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Redis = require("ioredis");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

/* =========================================================
   REDIS
========================================================= */

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.warn("⚠️ REDIS_URL is missing. Quota/cache will not work correctly.");
}
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

/* =========================================================
   OPENAI
========================================================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Models (env override friendly)
const OPENAI_MODEL_ANALYZE = process.env.OPENAI_MODEL_ANALYZE || "gpt-4.1-mini";
const OPENAI_MODEL_TRANSLATE = process.env.OPENAI_MODEL_TRANSLATE || "gpt-4.1-mini";
const OPENAI_MODEL_PERSON = process.env.OPENAI_MODEL_PERSON || "gpt-4.1-nano";

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY is missing. OpenAI routes will fail.");
}

/* =========================================================
   APP ENV (FREE LIMIT / TOPUP CREDITS)
========================================================= */

const FREE_LIMIT_PER_DAY = Number(process.env.FREE_LIMIT_PER_DAY || 2);
const CREDITS_PER_TOPUP = Number(process.env.CREDITS_PER_TOPUP || 150);

/* =========================================================
   QUOTA + DEV BYPASS
========================================================= */

function todayKeyUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function secondsUntilTomorrowUTC() {
  const now = new Date();
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  );
  const diffMs = tomorrow.getTime() - now.getTime();
  return Math.max(60, Math.floor(diffMs / 1000));
}

function getUserId(req) {
  const h = req.headers["x-user-id"];
  if (!h) return "anonymous";
  return String(h).trim() || "anonymous";
}

function devBypassOk(req) {
  const bypassToken = process.env.DEV_BYPASS_TOKEN;
  if (!bypassToken) return false;
  const incoming = req.headers["x-dev-bypass"];
  if (!incoming) return false;
  return String(incoming) === String(bypassToken);
}

async function checkAndConsumeQuota({ userId, limitPerDay }) {
  if (!redis) {
    return { ok: true, used: 0, remaining: limitPerDay, limit: limitPerDay };
  }

  const day = todayKeyUTC();
  const key = `quota:${userId}:${day}`;
  const ttl = secondsUntilTomorrowUTC();

  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, ttl);

  const ok = used <= limitPerDay;
  return {
    ok,
    used,
    remaining: Math.max(0, limitPerDay - used),
    limit: limitPerDay,
  };
}

/* =========================================================
   REDIS JSON CACHE HELPERS
========================================================= */

async function redisGetJSON(key) {
  if (!redis) return null;
  const v = await redis.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function redisSetJSON(key, value, ttlSeconds) {
  if (!redis) return;
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
}

function normKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

/* =========================================================
   CREDITS HELPERS
========================================================= */

async function getCreditsRemaining(userId) {
  if (!redis) return 0;
  const key = `credits:${userId}`;
  const v = await redis.get(key);
  return Math.max(0, Number(v || 0));
}

async function addCredits(userId, amount) {
  if (!redis) return 0;
  const key = `credits:${userId}`;
  const next = await redis.incrby(key, Number(amount || 0));
  return Math.max(0, Number(next || 0));
}

/* =========================================================
   OPENAI (Responses API)
========================================================= */

async function openaiResponsesCreate(body) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing on server");
  }

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await r.text();

  if (!r.ok) {
    const err = new Error(`OpenAI error ${r.status}: ${raw}`);
    err.status = r.status;
    err.raw = raw;
    throw err;
  }

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
   LANGUAGE HELPERS
========================================================= */

function normalizeLang(code) {
  const c = String(code || "en").toLowerCase();
  if (c === "en" || c === "fr" || c === "de" || c === "es") return c;
  return "en";
}

function languageName(code) {
  const c = normalizeLang(code);
  return (
    {
      en: "English",
      fr: "French",
      de: "German",
      es: "Spanish",
    }[c] || "English"
  );
}

/* =========================================================
   SANITY CLEANERS
========================================================= */

const HEADER_RE = /(Landmark Name|Essential Info|Location|Related Persons|Fun Fact|Name|Born|Died)\s*:?/gi;

function stripHeaders(v) {
  return String(v || "")
    .replace(/\r/g, "")
    .replace(HEADER_RE, "")
    .replace(
      /^\s*(Landmark Name|Essential Info|Location|Related Persons|Fun Fact|Name|Born|Died)\s*:\s*$/gim,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeHeaderOrEmpty(v) {
  const s = String(v || "").trim();
  if (!s) return true;
  const low = s.toLowerCase();
  const bad = [
    "landmark name",
    "essential info",
    "location",
    "related persons",
    "fun fact",
    "name",
    "born",
    "died",
  ];
  if (bad.some((b) => low === b || low === b + ":" || low.includes(b + ":"))) return true;
  return false;
}

function ensureCompleteSentence(v, { maxSentences = 3, fallback = "" } = {}) {
  let s = stripHeaders(v);
  if (!s) return fallback;

  const parts = s.match(/[^.!?]+[.!?]+/g);
  if (parts && parts.length) return parts.slice(0, maxSentences).join("").trim();

  if (s.length > 320) s = s.slice(0, 320).trim();
  s = s.replace(/[\s,;:]+$/, "").trim();
  return s.endsWith(".") || s.endsWith("!") || s.endsWith("?") ? s : s + ".";
}

function normalizeKind(v) {
  const k = String(v || "").toLowerCase();
  const ok = ["monument", "building", "town", "district", "landscape", "media", "person", "other"];
  return ok.includes(k) ? k : "other";
}

function normalizeLocation(v) {
  const s = stripHeaders(v);
  if (!s) return "Unknown";
  if (looksLikeHeaderOrEmpty(s)) return "Unknown";
  if (s.length > 90) return "Unknown";
  return s;
}

function normalizeNameGeneric(v) {
  const s = stripHeaders(v);
  if (!s) return "Unknown";
  if (looksLikeHeaderOrEmpty(s)) return "Unknown";
  if ((s.match(/[.!?]/g) || []).length >= 2) return "Unknown";
  if (s.length > 80) return "Unknown";
  return s;
}

// Media titles often include punctuation/year/pipes etc.
function normalizeMediaTitle(v) {
  const s0 = stripHeaders(v);
  if (!s0) return "Unknown";
  if (looksLikeHeaderOrEmpty(s0)) return "Unknown";

  const sentenceCount = (s0.match(/[.!?]/g) || []).length;
  if (sentenceCount >= 2) return "Unknown";

  let s = s0.trim();
  if (s.length > 140) s = s.slice(0, 140).trim();

  if (/\b(depicts|shows|appears|scene|image)\b/i.test(s) && s.length > 60) {
    return "Unknown";
  }

  return s || "Unknown";
}

function normalizeRelatedPersons(arr) {
  const a = Array.isArray(arr) ? arr : [];
  const cleaned = a.map((x) => stripHeaders(x)).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const n of cleaned) {
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.slice(0, 2);
}

/* =========================================================
   PERSON DISAMBIGUATION HINTS (fix known collisions)
========================================================= */

const PERSON_HINTS = {
  "anne hathaway":
    "Use the modern American actress (born 1982), known for film roles such as The Princess Diaries, not Shakespeare's wife.",
};

function personHintFor(name) {
  const k = normKey(name);
  return PERSON_HINTS[k] || "";
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * GET /credits
 * Returns: { freeToday: {limit, used, remaining}, credits: {remaining} }
 */
app.get("/credits", async (req, res) => {
  try {
    const userId = getUserId(req);

    const day = todayKeyUTC();
    const quotaKey = `quota:${userId}:${day}`;

    let used = 0;
    if (redis) {
      const raw = await redis.get(quotaKey);
      used = Number(raw || 0);
    }

    const freeToday = {
      limit: FREE_LIMIT_PER_DAY,
      used,
      remaining: Math.max(0, FREE_LIMIT_PER_DAY - used),
    };

    const credits = {
      remaining: await getCreditsRemaining(userId),
    };

    return res.json({ freeToday, credits });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: err?.message || "Unknown error" });
  }
});

/**
 * POST /analyze
 * Body: { imageBase64: string }
 */
app.post("/analyze", async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Missing imageBase64" });
    }

    const userId = getUserId(req);

    const bypass = devBypassOk(req);
    let quota = {
      ok: true,
      used: 0,
      remaining: FREE_LIMIT_PER_DAY,
      limit: FREE_LIMIT_PER_DAY,
      bypass: !!bypass,
    };

    if (!bypass) {
      quota = await checkAndConsumeQuota({ userId, limitPerDay: FREE_LIMIT_PER_DAY });
      if (!quota.ok) {
        return res.status(403).json({
          error: "FREE_LIMIT_REACHED",
          message: "Daily free limit used. Upgrade to premium.",
          quota,
        });
      }
    }

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
            relatedPersons: { type: "array", items: { type: "string" } },
            funFact: { type: "string" },
            kind: { type: "string" },
          },
          required: ["name", "essentialInfo", "location", "relatedPersons", "funFact", "kind"],
        },
      },
      required: ["landmark"],
    };

    const prompt = `
Analyze the image and describe what you see.

First: READ ANY VISIBLE TEXT in the image (on-screen titles, captions, YouTube UI, posters, signage, subtitles).
If text helps identify a movie/TV show, place, or landmark, USE IT.

Classify into one "kind":
- monument, building, town, district, landscape, media, person, other

CRITICAL RULE (real people):
- Do NOT identify real people from the image. Do NOT guess names of celebrities or private individuals.

MEDIA RULE:
- If kind="media" and you can identify the title from visible text OR very strong context cues,
  set name to the title (e.g., "The Princess Diaries").
- You may include up to 2 "notable people associated with the title" (lead actors/director) ONLY when the title is identified.
  Phrase as association (e.g., "The film stars ..."), NOT identification.
- For location on media: if the title is identified, you may put the best-known setting/filming location
  (e.g., "San Francisco, California") when it is widely associated; otherwise "Unknown".

PERSON RULE:
- If kind="person": name must be "Person" (or "People"), location usually "Unknown".
  Write richer essentialInfo (concert/interview/portrait) without naming the person.

Output in English.
Never include header words inside field values.

Field rules:
- essentialInfo: 2–3 COMPLETE sentences. If media: start with "Not a landmark."
- funFact: EXACTLY 1 COMPLETE sentence. No cutoffs.
- relatedPersons:
   - [] for town/district/person/other
   - up to 2 for monument/building/landscape (historical figures only if confident)
   - up to 2 for media ONLY if title is identified (associated notable people)
`.trim();

    const body = {
      model: OPENAI_MODEL_ANALYZE,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: `data:image/jpeg;base64,${imageBase64}` },
          ],
        },
      ],
      max_output_tokens: 1100,
      text: {
        format: {
          type: "json_schema",
          name: "travel_pal_landmark_en",
          schema,
          strict: true,
        },
      },
    };

    const t0 = Date.now();
    const parsed = await openaiResponsesCreate(body);
    const ms = Date.now() - t0;
    console.log(`[analyze] OpenAI latency: ${ms}ms (model=${OPENAI_MODEL_ANALYZE})`);

    const outputText = extractOutputText(parsed);
    if (!outputText) {
      return res.status(500).json({ error: "SERVER_ERROR", message: "OpenAI returned no output_text" });
    }

    let data;
    try {
      data = JSON.parse(outputText);
    } catch (e) {
      return res.status(500).json({
        error: "SERVER_ERROR",
        message: "Failed to parse model JSON output",
        raw: outputText,
      });
    }

    const l = data?.landmark;
    if (l) {
      l.kind = normalizeKind(l.kind);

      if (l.kind === "person") l.name = "Person";
      else if (l.kind === "media") l.name = normalizeMediaTitle(l.name);
      else if (l.kind === "other") l.name = "Unknown";
      else l.name = normalizeNameGeneric(l.name);

      if (l.kind === "person" || l.kind === "other") {
        l.location = "Unknown";
      } else {
        l.location = normalizeLocation(l.location);
      }

      if (l.kind === "town" || l.kind === "district" || l.kind === "person" || l.kind === "other") {
        l.relatedPersons = [];
      } else if (l.kind === "media") {
        const titleOk = l.name && l.name !== "Unknown";
        l.relatedPersons = titleOk ? normalizeRelatedPersons(l.relatedPersons) : [];
      } else {
        l.relatedPersons = normalizeRelatedPersons(l.relatedPersons);
      }

      l.essentialInfo = ensureCompleteSentence(l.essentialInfo, {
        maxSentences: 3,
        fallback:
          l.kind === "media"
            ? "Not a landmark. The image appears to show a scene from media content on a screen."
            : l.kind === "person"
              ? "The image appears to show a person as the main subject, possibly in a performance or indoor setting."
              : "The image does not show an identifiable landmark or place.",
      });

      l.funFact = ensureCompleteSentence(l.funFact, {
        maxSentences: 1,
        fallback:
          l.kind === "media"
            ? "Not a landmark. On-screen UI text often helps identify films, trailers, or clips."
            : l.kind === "person"
              ? "Live performance photos often capture motion blur and dramatic lighting effects."
              : "No identifiable landmark is visible in this image.",
      });

      if (l.kind === "media" && (l.name === "Unknown" || !l.name)) {
        l.location = "Unknown";
      }
    }

    return res.json({ data, quota });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: err?.message || "Unknown error" });
  }
});

/**
 * POST /translate
 */
app.post("/translate", async (req, res) => {
  try {
    const text = req.body?.text;
    const lang = normalizeLang(req.body?.lang || "en");

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Missing text" });
    }

    if (lang === "en") return res.json({ text, lang });

    const langName = languageName(lang);

    const prompt =
      `Translate the CONTENT of the following text into ${langName}.\n\n` +
      `CRITICAL RULES:\n` +
      `- DO NOT translate section headers.\n` +
      `- Headers MUST remain EXACTLY:\n` +
      `  Landmark Name:\n` +
      `  Essential Info:\n` +
      `  Location:\n` +
      `  Related Persons:\n` +
      `  Fun Fact:\n` +
      `- Translate ONLY the text UNDER each header.\n` +
      `- Output ONLY the final text.\n\n` +
      `TEXT:\n${text}`;

    const body = {
      model: OPENAI_MODEL_TRANSLATE,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      max_output_tokens: 900,
      text: { format: { type: "text" } },
    };

    const parsed = await openaiResponsesCreate(body);
    const out = extractOutputText(parsed);

    if (!out) {
      return res.status(500).json({ error: "SERVER_ERROR", message: "OpenAI returned no output_text" });
    }

    return res.json({ text: out.trim(), lang });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: err?.message || "Unknown error" });
  }
});

/**
 * POST /person
 * NOTE: This endpoint is for user-selected names (from relatedPersons).
 */
app.post("/person", async (req, res) => {
  try {
    const name = req.body?.name;
    const lang = normalizeLang(req.body?.lang || "en");

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Missing name" });
    }

    const hint = personHintFor(name);

    const cacheKey = `person:v5:${normKey(name)}:${lang}:${normKey(hint)}`;
    const cached = await redisGetJSON(cacheKey);
    if (cached?.text) {
      return res.json({ text: cached.text, lang, cached: true });
    }

    const langName = languageName(lang);

    const prompt = `
You are writing a short factual bio for the person name: "${name}".

DISAMBIGUATION (CRITICAL):
- Many people can share the same name. Choose the most internationally well-known person associated with that exact name.
- Prefer the modern public figure when the name is strongly associated with a contemporary actor/singer/athlete/politician.
- If you are unsure, do NOT guess details; use "Unknown" rather than inventing.

${hint ? `DISAMBIGUATION HINT: ${hint}` : ""}

CRITICAL FORMAT RULES:
- Output MUST use the EXACT headers below (do NOT translate headers).
- Write the CONTENT under each header in ${langName}.
- Output ONLY the final text.

Headers (must be exact):
Name:
Essential Info:
Born:
Died:
Fun Fact:

Content rules:
- Essential Info: exactly 2 complete factual sentences.
- Born: "Month Day, Year — City, Country" or "Unknown".
- Died: if living, write "Living"; otherwise "Month Day, Year — City, Country" or "Unknown".
- Fun Fact: exactly 1 complete sentence (no cutoff).
`.trim();

    const body = {
      model: OPENAI_MODEL_PERSON,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      max_output_tokens: 650,
      text: { format: { type: "text" } },
    };

    const t0 = Date.now();
    const parsed = await openaiResponsesCreate(body);
    const ms = Date.now() - t0;
    console.log(`[person] OpenAI latency: ${ms}ms (model=${OPENAI_MODEL_PERSON})`);

    const out = extractOutputText(parsed);

    if (!out) {
      return res.status(500).json({ error: "SERVER_ERROR", message: "OpenAI returned no output_text" });
    }

    const finalText = out.trim();
    await redisSetJSON(cacheKey, { text: finalText }, 60 * 60 * 24 * 30);

    return res.json({ text: finalText, lang, cached: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: err?.message || "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});