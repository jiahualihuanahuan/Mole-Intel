import { findCompany } from "@/data/universe";
import { debateFromRecord, hitFromRecord, type ArchiveHit } from "@/lib/debate-archive";
import type { DebateResult, DeskBoards, FeedReport, Headline, Tape } from "@/lib/debate-types";
import { linkHost, normalizeYahooTicker, safeHttpUrl } from "@/lib/yahoo-ticker.mjs";
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
  const symbol = normalizeYahooTicker(ticker);
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
    stories: [],
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
    const stories = await readHeadlines(symbol);
    return {
      ticker: symbol,
      name: str(meta.shortName) || known?.name || symbol,
      price,
      previousClose,
      changePct: price != null && previousClose ? (price / previousClose - 1) * 100 : null,
      return3mPct: price != null && first ? (price / first - 1) * 100 : null,
      currency: str(meta.currency) || null,
      headlines: stories.map((item) => item.title),
      stories,
      asOf: new Date().toISOString(),
      note: "Price tape only. Multiples and wires are on the archived note.",
    };
  } catch {
    return empty;
  }
}

async function readHeadlines(ticker: string): Promise<Headline[]> {
  const rss = await readRss(ticker);
  if (rss.length) return rss;
  return readYahooSearch(ticker);
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;|'/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function xmlText(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match?.[1] ? decodeXml(match[1]) : "";
}

function dayFrom(value: string | number | null): string | null {
  if (value == null || value === "") return null;
  const date = typeof value === "number" ? new Date(value > 1e12 ? value : value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

async function readRss(ticker: string): Promise<Headline[]> {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const res = await fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: "application/rss+xml,application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const stories: Headline[] = [];
    for (const block of xml.split(/<item\b/i).slice(1)) {
      const title = xmlText(block, "title");
      if (!title || /yahoo! finance/i.test(title)) continue;
      const link = safeHttpUrl(xmlText(block, "link"));
      stories.push({
        title: title.slice(0, 300),
        source: linkHost(link),
        published: dayFrom(xmlText(block, "pubDate")),
        url: link,
      });
      if (stories.length >= 8) break;
    }
    return stories;
  } catch {
    return [];
  }
}

async function readYahooSearch(ticker: string): Promise<Headline[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=8`;
    const pulled = await getText(url, 8_000);
    if (!pulled.ok) return [];
    const body = JSON.parse(pulled.text) as { news?: { title?: string; link?: string; publisher?: string; providerPublishTime?: number }[] };
    const stories: Headline[] = [];
    for (const item of body.news ?? []) {
      const title = str(item.title);
      if (!title) continue;
      const link = safeHttpUrl(item.link);
      stories.push({
        title: title.slice(0, 300),
        source: str(item.publisher) || linkHost(link),
        published: dayFrom(item.providerPublishTime ?? null),
        url: link,
      });
      if (stories.length >= 8) break;
    }
    return stories;
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
  const symbol = normalizeYahooTicker(ticker);
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

export async function readBoards(): Promise<DeskBoards> {
  const { universe } = await import("@/data/universe");
  const { loadDeskBoards } = (await import("./boards.mjs")) as {
    loadDeskBoards: (input: {
      universe: { ticker: string; name: string }[];
      bullish: { ticker: string; name: string; conviction: number | null }[];
    }) => Promise<DeskBoards>;
  };
  const bullish = new Map<string, { ticker: string; name: string; conviction: number | null }>();
  for (const record of readArchiveRecords()) {
    const debate = debateFromRecord(record);
    if (!debate?.judge || debate.judge.call !== "bullish") continue;
    const known = findCompany(debate.ticker);
    bullish.set(debate.ticker, {
      ticker: debate.ticker,
      name: known?.name || debate.name || debate.ticker,
      conviction: debate.judge.conviction,
    });
  }
  return loadDeskBoards({ universe, bullish: [...bullish.values()] });
}

export async function readFeeds(ticker: string): Promise<FeedReport> {
  const symbol = normalizeYahooTicker(ticker);
  const job = (await import("./debate-job.mjs")) as {
    sourceReport: (ticker: string) => Promise<FeedReport>;
  };
  return job.sourceReport(symbol);
}

export async function runDebate(ticker: string): Promise<DebateResult> {
  const symbol = normalizeYahooTicker(ticker);
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
  debate.model = process.env.LLM_MODEL || "qwen3.5:9b";
  if (tape) {
    const archivedHeads = debate.tape.headlines;
    debate.tape = tape;
    if (archivedHeads.length) debate.tape.headlines = archivedHeads;
  } else debate.tape.name = debate.name;
  return debate;
}
