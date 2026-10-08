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
});

test("news seat is sent to the model and shown on the page", () => {
  const job = fs.readFileSync(new URL("../src/lib/debate-job.mjs", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../src/components/desk-page.tsx", import.meta.url), "utf8");
  const archive = fs.readFileSync(new URL("../src/lib/debate-archive.ts", import.meta.url), "utf8");
  assert.match(job, /ask\("news", newsPacket\)/);
  assert.match(job, /packet\.fundamentals/);
  assert.match(job, /QuantTrio\/Qwen3\.5-4B-AWQ/);
  assert.match(job, /enable_thinking: true/);
  assert.equal(job.includes("one JSON object"), false);
  assert.match(job, /max_tokens: maxTokens/);
  assert.equal(job.includes("ask(\"bull\", packet)"), false);
  assert.match(page, /news: "News"/);
  assert.match(page, /Seven seats/);
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
