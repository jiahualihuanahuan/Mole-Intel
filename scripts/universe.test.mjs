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
