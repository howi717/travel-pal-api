import express from "express";
import cors from "cors";
import "dotenv/config";
import Redis from "ioredis";

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" })); // base64 kan bli stor; juster ved behov

// --- Redis (Upstash) ---
const redis = new Redis(process.env.REDIS_URL);

// --- Utils ---
function todayKey() {
  const d = new Date();
  // YYYY-MM-DD i UTC (enkelt + stabilt)
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function requireFreeQuota(userId) {
  const key = `usage:${userId}:${todayKey()}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60 * 60 * 30); // ~30t

  const FREE_DAILY = 2;
  if (count > FREE_DAILY) {
    return { ok: false, remaining: 0, used: count - 1, limit: FREE_DAILY };
  }
  return { ok: true, remaining: FREE_DAILY - count, used: count, limit: FREE_DAILY };
}

function stripDataPrefix(b64) {
  // tillat både "data:image/jpeg;base64,...." og ren base64
  const idx = b64.indexOf("base64,");
  return idx >= 0 ? b64.slice(idx + 7) : b64;
}

// --- OpenAI call (Responses API) ---
async function openaiAnalyze({ imageBase64, lang = "en" }) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      landmark: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          location: { type: "string" },
          essentialInfo: { type: "string" },
          funFact: { type: "string" },
          relatedPersons: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                essentialInfo: { type: "string" },
                born: { type: "string" },
                died: { type: "string" },
                funFact: { type: "string" }
              },
              required: ["name", "essentialInfo", "born", "died", "funFact"]
            }
          }
        },
        required: ["name", "location", "essentialInfo", "funFact", "relatedPersons"]
      },
      // For å drepe oversettelses-kallene:
      // serveren returnerer ferdig tekst i flere språk (eller bare valgt språk).
      translations: {
        type: "object",
        additionalProperties: false,
        properties: {
          en: { type: "string" },
          fr: { type: "string" },
          de: { type: "string" },
          es: { type: "string" }
        },
        required: ["en", "fr", "de", "es"]
      }
    },
    required: ["landmark", "translations"]
  };

  const prompt = `
You are Travel Pal. Analyze the landmark in the image.
Return factual info. If uncertain, say "Unknown" rather than guessing.

Generate:
1) A structured JSON object (see schema).
2) Also produce translations in EN/FR/DE/ES for the same content.
Keep translations concise.

Language hint from user: ${lang}
`.trim();

  const body = {
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    max_output_tokens: 650,
 text: {
  format: {
    type: "json_schema",
    name: "travel_pal_landmark",
    schema,
    strict: true
  }
},

    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: `data:image/jpeg;base64,${stripDataPrefix(imageBase64)}`
          }
        ]
      }
    ]
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${errText}`);
  }

  const json = await resp.json();

  // Responses API: vi forventer at modellen returnerer JSON i output_text
  // Denne parsing-metoden er robust nok for strict schema-svar:
  const outputText =
    json.output?.flatMap(o => o.content || [])
      ?.find(c => c.type === "output_text")?.text;

  if (!outputText) throw new Error("Missing output_text from OpenAI response");

  return JSON.parse(outputText);
}

// --- Routes ---
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/analyze", async (req, res) => {
  try {
    const userId = req.header("x-user-id");
    if (!userId) return res.status(400).json({ error: "Missing x-user-id header" });

    const { imageBase64, lang } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: "Missing imageBase64" });

    // Freemium gate (premium senere)
    const quota = await requireFreeQuota(userId);
    if (!quota.ok) {
      return res.status(402).json({
        error: "FREE_LIMIT_REACHED",
        message: "Free limit reached (2/day). Upgrade to premium.",
        quota
      });
    }

    const data = await openaiAnalyze({ imageBase64, lang });
    res.json({ data, quota });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "SERVER_ERROR", message: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on ${port}`));
