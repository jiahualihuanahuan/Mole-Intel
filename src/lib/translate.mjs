// @ts-nocheck
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { finalNote } from "./final-note.mjs";

const BASE_URL = (process.env.LLM_BASE_URL || "http://192.168.86.35:11434/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || "qwen3.5:9b";
const CHUNK = 1000;
const MAX_OUTPUT = 512;

const memory = new Map();
let loaded = false;

function cachePath() {
  const dir = process.env.MOLE_DATA || path.join(process.cwd(), "data");
  return path.join(dir, "translations.jsonl");
}

function hashOf(text) {
  return createHash("sha256").update(text).digest("hex");
}

function loadCache() {
  if (loaded) return;
  loaded = true;
  try {
    const text = fs.readFileSync(cachePath(), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.hash && row.zh) memory.set(row.hash, row.zh);
      } catch {
        // A broken line is skipped.
      }
    }
  } catch {
    // The cache file is created on the first translation.
  }
}

function remember(hash, zh) {
  memory.set(hash, zh);
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ hash, zh })}\n`);
}

export function splitChunks(text, size = CHUNK) {
  const clean = String(text || "").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const parts = [];
  let rest = clean;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n\n", size);
    if (cut < size * 0.4) cut = rest.lastIndexOf(". ", size);
    if (cut < size * 0.4) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.4) cut = size;
    if (rest.slice(cut, cut + 2) === ". ") cut += 2;
    const piece = rest.slice(0, cut).trim();
    if (piece) parts.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function post(body) {
  const target = new URL(`${BASE_URL}/chat/completions`);
  const payload = JSON.stringify(body);
  const lib = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 5 * 60 * 1000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`LLM ${status}: ${raw.replace(/\s+/g, " ").slice(0, 180)}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            resolve(String(parsed?.choices?.[0]?.message?.content || ""));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("translation timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function translateChunk(text) {
  const content = await post({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You translate one short piece of financial research into Simplified Chinese. Keep ticker symbols, company names, and numbers unchanged. Output only the translation.",
      },
      { role: "user", content: text },
    ],
    temperature: 0.2,
    max_tokens: MAX_OUTPUT,
    think: false,
    chat_template_kwargs: { enable_thinking: false },
  });
  return finalNote(content).trim();
}

export async function translateText(text) {
  const source = String(text || "").trim();
  if (!source) return "";
  loadCache();
  const out = [];
  for (const chunk of splitChunks(source)) {
    const hash = hashOf(chunk);
    const cached = memory.get(hash);
    if (cached) {
      out.push(cached);
      continue;
    }
    const zh = await translateChunk(chunk);
    if (!zh) throw new Error("empty translation");
    remember(hash, zh);
    out.push(zh);
  }
  return out.join("\n\n");
}
