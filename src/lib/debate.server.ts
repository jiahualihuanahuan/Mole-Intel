import { findCompany } from "@/data/universe";
import { debateFromRecord, hitFromRecord, type ArchiveHit } from "@/lib/debate-archive";
import type { DebateResult, Tape } from "@/lib/debate-types";
import { readFileSync } from "node:fs";
import path from "node:path";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function getText(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    headers: {
      "user-agent": BROWSER_UA,
      accept: "application/json,text/html;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

export async function readTape(ticker: string): Promise<Tape> {
  const symbol = ticker.trim().toUpperCase();
  const known = findCompany(symbol);
  const empty: Tape = {
    ticker: symbol,
    name: known?.name ?? symbol,
    price: null,
    previousClose: null,
    changePct: null,
    return3mPct: null,
    currency: null,
    headlines: [],
    asOf: new Date().toISOString(),
    note: "The tape did not come back. Seats may only say the numbers are unknown.",
  };
  try {
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
    let pulled = await getText(chartUrl, 12_000);
    if (pulled.status === 429) {
      pulled = await getText(
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`,
        12_000,
      );
    }
    if (!pulled.ok) return empty;
    const body = JSON.parse(pulled.text) as {
      chart?: {
        result?: {
          meta?: Record<string, unknown>;
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };
    const result = body.chart?.result?.[0];
    const meta = result?.meta ?? {};
    const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    const price = finite(meta.regularMarketPrice) ?? closes.at(-1) ?? null;
    const previousClose = finite(meta.previousClose) ?? closes.at(-2) ?? null;
    const first = closes[0] ?? null;
    const headlines = await readHeadlines(symbol);
    return {
      ticker: symbol,
      name: str(meta.shortName) || known?.name || symbol,
      price,
      previousClose,
      changePct: price != null && previousClose ? (price / previousClose - 1) * 100 : null,
      return3mPct: price != null && first ? (price / first - 1) * 100 : null,
      currency: str(meta.currency) || null,
      headlines,
      asOf: new Date().toISOString(),
      note: "Price tape only. Multiples and wires are on the archived note.",
    };
  } catch {
    return empty;
  }
}

async function readHeadlines(ticker: string): Promise<string[]> {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const res = await fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: "application/rss+xml,application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const titles: string[] = [];
    for (const match of xml.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)) {
      const title = match[1].replace(/\s+/g, " ").trim();
      if (!title || /yahoo! finance/i.test(title)) continue;
      titles.push(title.slice(0, 220));
      if (titles.length >= 12) break;
    }
    return titles;
  } catch {
    return [];
  }
}

export function archiveFile(): string {
  const dir = process.env.MOLE_DATA || path.join(process.cwd(), "data");
  return path.join(dir, "debates.jsonl");
}

function readArchiveRecords(): unknown[] {
  let text = "";
  try {
    text = readFileSync(archiveFile(), "utf8");
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip a torn line
    }
  }
  return records;
}

export function listArchive(): ArchiveHit[] {
  const latest = new Map<string, ArchiveHit>();
  for (const record of readArchiveRecords()) {
    const hit = hitFromRecord(record);
    if (hit) latest.set(hit.ticker, hit);
  }
  return [...latest.values()].sort((a, b) => (a.asOf < b.asOf ? 1 : -1));
}

export function loadArchived(ticker: string): DebateResult | null {
  const symbol = ticker.trim().toUpperCase();
  let found: unknown = null;
  for (const record of readArchiveRecords()) {
    const hit = hitFromRecord(record);
    if (hit?.ticker === symbol) found = record;
  }
  if (!found) return null;
  const debate = debateFromRecord(found);
  if (!debate) return null;
  const known = findCompany(symbol);
  debate.name = known?.name ?? symbol;
  debate.sector = debate.company?.sector || known?.sector || "Unlisted";
  debate.indexName = known?.index ?? "Tape";
  debate.tape.name = debate.name;
  return debate;
}

export async function runDebate(ticker: string): Promise<DebateResult> {
  const symbol = ticker.trim().toUpperCase();
  const job = (await import("./debate-job.mjs")) as {
    debateOne: (ticker: string) => Promise<unknown>;
    archive: (result: unknown) => void;
  };
  const [record, tape] = await Promise.all([
    job.debateOne(symbol),
    readTape(symbol).catch(() => null),
  ]);
  const debate = debateFromRecord(record);
  if (!debate) throw new Error("The desk wrote a note the page could not read.");
  try {
    job.archive(record);
  } catch (error) {
    debate.errors.push(`archive: ${error instanceof Error ? error.message : "could not write debates.jsonl"}`);
  }
  const known = findCompany(symbol);
  debate.name = known?.name ?? tape?.name ?? symbol;
  debate.sector = debate.company?.sector || known?.sector || "Unlisted";
  debate.indexName = known?.index ?? "Tape";
  debate.source = "desk";
  debate.model = process.env.LLM_MODEL || "qwen3.5-9b";
  if (tape) {
    const archivedHeads = debate.tape.headlines;
    debate.tape = tape;
    if (archivedHeads.length) debate.tape.headlines = archivedHeads;
  } else debate.tape.name = debate.name;
  return debate;
}
