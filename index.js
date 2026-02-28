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
   REDIS (kept for person cache only)
========================================================= */

const REDIS_URL = process.env.REDIS_URL;
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

/* =========================================================
   OPENAI
========================================================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL_ANALYZE = process.env.OPENAI_MODEL_ANALYZE || "gpt-4.1-mini";
const OPENAI_MODEL_TRANSLATE = process.env.OPENAI_MODEL_TRANSLATE || "gpt-4.1-mini";
const OPENAI_MODEL_PERSON = process.env.OPENAI_MODEL_PERSON || "gpt-4.1-nano";

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

  if (!r.ok) {
    throw new Error(`OpenAI error ${r.status}: ${raw}`);
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
   ROUTES
========================================================= */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * TEMPORARY ANALYZE (NO CREDITS / NO QUOTA)
 */
app.post("/analyze", async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    const schema = {
      type: "object",
      properties: {
        landmark: {
          type: "object",
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

    if (!outputText) {
      return res.status(500).json({ error: "No output_text" });
    }

    const data = JSON.parse(outputText);

    return res.json({ data }); // NO QUOTA RETURNED
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * REMOVE /credits completely (temporary)
 */
app.get("/credits", (req, res) => {
  res.json({
    freeToday: { limit: 2, used: 0, remaining: 2 },
    credits: { remaining: 0 },
  });
});

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});