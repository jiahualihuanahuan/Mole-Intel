/**
 * Nightly six-seat batch. Imports the same job the web app uses.
 *   node scripts/debate-batch.mjs [--limit N]
 * No limit (the 11pm default) checks every name in the universe once,
 * from the top of the list. A positive --limit or BATCH_LIMIT walks only
 * that many names. The cursor in $MOLE_DATA/batch-cursor.json continues
 * a capped run the next night instead of restarting at the first ticker.
 */
import fs from "node:fs";
import path from "node:path";
import { archive, debateOne } from "../src/lib/debate-job.mjs";

const DATA_DIR = process.env.MOLE_DATA || path.join(process.cwd(), "data");
const UNIVERSE = path.join(process.cwd(), "src/data/universe.ts");

function args() {
  let limit = Number(process.env.BATCH_LIMIT || 0);
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) limit = Number(argv[++i]) || 0;
  }
  return { limit: limit > 0 ? limit : 0 };
}

function loadTickers() {
  const txt = fs.readFileSync(UNIVERSE, "utf8");
  const tickers = [...txt.matchAll(/ticker:\s*"([A-Z0-9][A-Z0-9.-]{0,16})"/g)].map((m) => m[1]);
  return [...new Set(tickers)];
}

function cursorPath() {
  return path.join(DATA_DIR, "batch-cursor.json");
}

function readCursor() {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorPath(), "utf8"));
    return Number(raw.offset) || 0;
  } catch {
    return 0;
  }
}

function writeCursor(offset) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(cursorPath(), JSON.stringify({ offset, at: new Date().toISOString() }) + "\n");
}

async function main() {
  const { limit } = args();
  const universe = loadTickers();
  if (!universe.length) throw new Error("No tickers in src/data/universe.ts");
  const offset = limit > 0 ? readCursor() % universe.length : 0;
  const count = limit > 0 ? Math.min(limit, universe.length) : universe.length;
  const slice = [];
  for (let i = 0; i < count; i++) slice.push(universe[(offset + i) % universe.length]);
  console.error(`Desk batch: ${slice.length} of ${universe.length}, starting at ${slice[0]}`);
  let ok = 0;
  let fail = 0;
  for (const ticker of slice) {
    const started = Date.now();
    try {
      const result = await debateOne(ticker);
      archive(result);
      ok++;
      console.error(`OK  ${ticker} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      fail++;
      console.error(`ERR ${ticker}: ${error instanceof Error ? error.message : error}`);
    }
  }
  writeCursor(limit > 0 ? (offset + slice.length) % universe.length : 0);
  console.error(`Done. ok=${ok} fail=${fail}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
