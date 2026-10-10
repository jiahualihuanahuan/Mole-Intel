import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const universe = fs.readFileSync(new URL("../src/data/universe.ts", import.meta.url), "utf8");
const desk = fs.readFileSync(new URL("./desk.sh", import.meta.url), "utf8");
const tickers = [...universe.matchAll(/ticker:\s*"([A-Z0-9][A-Z0-9.-]{0,16})"/g)].map((m) => m[1]);

test("developed-world universe is the MSCI World Yahoo list", () => {
  assert.ok(tickers.length >= 1200);
  assert.equal(new Set(tickers).size, tickers.length);
  for (const symbol of ["NVDA", "BRK-B", "SHOP.TO", "7203.T", "ROP.SW", "RO.SW", "ROP", "NOVO-B.CO", "0001.HK", "SHEL.L"]) {
    assert.ok(tickers.includes(symbol), symbol);
  }
  assert.equal(tickers.includes("HOLX"), false);
});

test("desk waits for 11pm and does not set a power limit", () => {
  assert.match(desk, /23:00/);
  assert.equal(desk.includes("nvidia-smi"), false);
  assert.equal(desk.includes("tomorrow 00:00"), false);
});

test("desk image includes the ticker module the job imports", () => {
  const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /yahoo-ticker\.mjs/);
  assert.match(docker, /final-note\.mjs/);
  assert.match(docker, /translate\.mjs/);
});

test("news seat is sent to the model and shown on the page", () => {
  const job = fs.readFileSync(new URL("../src/lib/debate-job.mjs", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../src/components/desk-page.tsx", import.meta.url), "utf8");
  const archive = fs.readFileSync(new URL("../src/lib/debate-archive.ts", import.meta.url), "utf8");
  assert.match(job, /ask\("news", newsPacket\)/);
  assert.match(job, /packet\.fundamentals/);
  assert.match(job, /qwen3\.5:9b/);
  assert.match(job, /192\.168\.86\.35:11434/);
  assert.match(job, /65536/);
  assert.match(job, /const MAX_OUTPUT = 4096/);
  assert.match(fs.readFileSync(new URL("../README.md", import.meta.url), "utf8"), /192\.168\.86\.35:11434/);
  assert.match(job, /timeout: LLM_WAIT_MS/);
  assert.match(job, /LLM_CONCURRENCY \|\| 1/);
  assert.equal(job.includes("one JSON object"), false);
  assert.match(job, /max_tokens: fitted\.output/);
  assert.match(job, /truncated to fit the context window/);
  assert.equal(job.includes("ask(\"bull\", packet)"), false);
  const i18n = fs.readFileSync(new URL("../src/lib/i18n.tsx", import.meta.url), "utf8");
  assert.match(i18n, /news: "新闻"/);
  assert.match(i18n, /Six seats/);
  assert.match(page, /setLang\(lang === "en" \? "zh" : "en"\)/);
  assert.match(page, /translateSectionFn/);
  assert.equal(job.includes("ask(\"macro\""), false);
  assert.equal(page.includes("Thinking</summary>"), false);
  assert.match(archive, /"news"/);
  assert.match(archive, /fundamental_impact/);
});

test("desk runs the whole universe each night", () => {
  assert.match(desk, /whole universe/);
  assert.equal(desk.includes("BATCH_LIMIT:-500"), false);
  assert.equal(desk.includes("--limit \"${BATCH_LIMIT:-500}\""), false);
  const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.equal(compose.includes("BATCH_LIMIT"), false);
});
