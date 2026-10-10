import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { finalNote } from "./final-note.mjs";

const BASE_URL = (process.env.LLM_BASE_URL || "http://192.168.86.35:11434/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || "qwen3.5:9b";

const memory = new Map<string, string>();
let loaded = false;

function cachePath() {
  const dir = process.env.MOLE_DATA || path.join(process.cwd(), "data");
  return path.join(dir, "translations.jsonl");
}

function hashOf(text: string) {
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
        const row = JSON.parse(line) as { hash?: string; zh?: string };
        if (row.hash && row.zh) memory.set(row.hash, row.zh);
      } catch {
        // A broken line is skipped. The next translation still gets cached.
      }
    }
  } catch {
    // The cache file is created on the first translation.
  }
}

function remember(hash: string, zh: string) {
  memory.set(hash, zh);
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ hash, zh })}\n`);
}

function post(body: unknown): Promise<string> {
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
        timeout: 10 * 60 * 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`LLM ${status}: ${raw.replace(/\s+/g, " ").slice(0, 180)}`));
            return;
          }
          try {
            const payload = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
            resolve(String(payload?.choices?.[0]?.message?.content || ""));
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

async function translateOne(text: string): Promise<string> {
  const content = await post({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You translate financial research into Simplified Chinese. Keep ticker symbols, company names, and numbers unchanged. Output only the translation.",
      },
      { role: "user", content: text.slice(0, 16000) },
    ],
    temperature: 0.2,
    max_tokens: 4096,
    think: false,
    chat_template_kwargs: { enable_thinking: false },
  });
  return finalNote(content).trim();
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  if (workers === 0) return;
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

export async function translateZh(texts: string[]): Promise<string[]> {
  loadCache();
  const missing = [...new Set(texts.map((text) => text.trim()).filter((text) => text && !memory.has(hashOf(text))))];
  await pool(missing, 2, async (text) => {
    try {
      const zh = await translateOne(text);
      if (zh) remember(hashOf(text), zh);
    } catch {
      // Leave it uncached so the next open can try again.
    }
  });
  return texts.map((text) => {
    const trimmed = text.trim();
    if (!trimmed) return text;
    return memory.get(hashOf(trimmed)) || text;
  });
}
