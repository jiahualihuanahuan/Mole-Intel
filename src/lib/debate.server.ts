import { findCompany } from "@/data/universe";
import { debateFromRecord, hitFromRecord, type ArchiveHit } from "@/lib/debate-archive";
import type { DebateResult, Disagreement, JudgeNote, SeatNote, Tape } from "@/lib/debate-types";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BASE_URL = (process.env.LLM_BASE_URL || "http://127.0.0.1:8000/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || "qwen2.5-7b";

const SEATS: { key: string; title: string; system: string }[] = [
  {
    key: "bull",
    title: "Bull",
    system:
      "You are the bull on a six-seat investment desk. Write the case FOR owning the stock. Walk the price path, then each headline that helps, then what would have to be true for the case to fail. Use only the tape. Never invent a figure, a multiple, a rating, or a macro print.",
  },
  {
    key: "bear",
    title: "Bear",
    system:
      "You are the bear on a six-seat investment desk. Write the case AGAINST owning the stock. Walk the price path, then each headline that hurts or is too thin to trust, then what the bull is skipping. Use only the tape. Never invent a figure.",
  },
  {
    key: "valuation",
    title: "Valuation",
    system:
      "You are the valuation seat. The tape has price and returns, not multiples, unless a headline states one. Say what the move implies and what you cannot price. Do not estimate a missing multiple. Name every gap.",
  },
  {
    key: "macro",
    title: "Macro",
    system:
      "You are the macro seat. Rates, inflation, and growth are unknown unless a headline states them. Read only what the wires actually say about the backdrop. If they say nothing, write that the seat cannot take a side, and say what a real macro read would need.",
  },
  {
    key: "earnings",
    title: "Earnings",
    system:
      "You are the earnings seat. A headline is someone else's wording, not a transcript or a filing. Go through the wires one by one: what each one claims, what it does not say, and whether the set is enough to judge the last quarter.",
  },
  {
    key: "analyst",
    title: "Analysts",
    system:
      "You are the analyst-ratings seat. There is no ratings feed. Count only headlines that name a firm and an action. Quote those. Ignore the rest. If the set is one note or none, say the seat is thin and do not invent a target, an upgrade, or an insider trade.",
  },
];

const MEMO =
  "Reply with one JSON object and nothing else: {summary, argument, points, verdict, confidence}. summary is two sentences. argument is three paragraphs separated by newline characters, each three to five sentences, written as a desk memo. points is five full sentences, each tied to one tape fact. verdict is one line. confidence is 0 to 1. Do not pad with facts that are not in the tape.";

const JUDGE =
  "You are the judge. Read the six seats. Do not force agreement. Reply with one JSON object and nothing else: {call:bullish|bearish|neutral|mixed, conviction:0-1, summary, bull_points, bear_points, disagreements, open_questions}. summary is three paragraphs separated by newline characters: what the tape shows, where the seats agree, where they do not. bull_points and bear_points are up to five sentences each. disagreements is up to five items of {topic, bull_view, bear_view}, and each view is a short paragraph, not a slogan. open_questions is up to four sentences naming what the tape still cannot settle.";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function points(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const line = [str(row.topic), str(row.view)].filter(Boolean).join(": ");
      if (line) out.push(line);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, " ").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function chat(system: string, user: string, maxTokens: number): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.LLM_API_KEY?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(8 * 60 * 1000),
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "did not connect";
    throw new Error(`vLLM at ${BASE_URL} did not answer (${MODEL}). ${detail}`);
  }
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`vLLM at ${BASE_URL} returned ${res.status} for ${MODEL}. ${detail}`);
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

function seatFrom(title: string, raw: string): SeatNote | null {
  const parsed = extractJson(raw);
  if (!parsed) return null;
  return {
    title,
    summary: str(parsed.summary ?? parsed.thesis),
    argument: str(parsed.argument),
    points: points(parsed.points ?? parsed.evidence ?? parsed.risks, 6),
    verdict: str(parsed.verdict),
    confidence: num(parsed.confidence),
  };
}

function judgeFrom(raw: string): JudgeNote | null {
  const parsed = extractJson(raw);
  if (!parsed) return null;
  const callRaw = str(parsed.call).toLowerCase();
  const call: JudgeNote["call"] =
    callRaw === "bullish" || callRaw === "bearish" || callRaw === "neutral" || callRaw === "mixed"
      ? callRaw
      : "mixed";
  const disagreements: Disagreement[] = [];
  if (Array.isArray(parsed.disagreements)) {
    for (const item of parsed.disagreements) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const topic = str(row.topic);
      const bull = str(row.bull_view ?? row.bullView);
      const bear = str(row.bear_view ?? row.bearView);
      if (!topic && !bull && !bear) continue;
      disagreements.push({ topic: topic || "Open point", bull, bear });
      if (disagreements.length >= 5) break;
    }
  }
  return {
    call,
    conviction: num(parsed.conviction),
    summary: str(parsed.summary),
    bullPoints: points(parsed.bull_points ?? parsed.bullPoints, 5),
    bearPoints: points(parsed.bear_points ?? parsed.bearPoints, 5),
    disagreements,
    openQuestions: points(parsed.open_questions ?? parsed.openQuestions, 4),
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
      note: "Price tape only. No multiples, ratings, or macro series are in this packet.",
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
  debate.sector = known?.sector ?? "Unlisted";
  debate.indexName = known?.index ?? "Tape";
  debate.tape.name = debate.name;
  return debate;
}

function rememberedNote(note: SeatNote | null): Record<string, unknown> | null {
  if (!note) return null;
  return {
    summary: note.summary,
    argument: note.argument,
    points: note.points,
    verdict: note.verdict,
    confidence: note.confidence,
  };
}

function appendArchive(result: DebateResult) {
  const agents: Record<string, unknown> = {};
  for (const [key, note] of Object.entries(result.seats)) {
    const body = rememberedNote(note);
    agents[key] = body
      ? { agent: key, ok: true, note: body }
      : { agent: key, ok: false, error: "did not write a note" };
  }
  const record = {
    ticker: result.ticker,
    as_of: result.asOf,
    model: result.model,
    agents,
    judge: result.judge
      ? {
          agent: "judge",
          ok: true,
          note: {
            call: result.judge.call,
            conviction: result.judge.conviction,
            summary: result.judge.summary,
            bull_points: result.judge.bullPoints,
            bear_points: result.judge.bearPoints,
            disagreements: result.judge.disagreements.map((row) => ({
              topic: row.topic,
              bull_view: row.bull,
              bear_view: row.bear,
            })),
            open_questions: result.judge.openQuestions,
          },
        }
      : { agent: "judge", ok: false, error: result.errors.join("; ") || "did not write a note" },
  };
  const file = archiveFile();
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export async function runDebate(ticker: string): Promise<DebateResult> {
  const symbol = ticker.trim().toUpperCase();
  const known = findCompany(symbol);
  const tape = await readTape(symbol);
  const packet = JSON.stringify({
    ticker: tape.ticker,
    name: tape.name,
    sector: known?.sector ?? "Unknown",
    price: tape.price,
    previous_close: tape.previousClose,
    change_pct_1d: tape.changePct,
    return_3m_pct: tape.return3mPct,
    currency: tape.currency,
    headlines: tape.headlines,
    limits: tape.note,
  });
  const errors: string[] = [];
  const seats: Record<string, SeatNote | null> = {};
  const settled = await Promise.all(
    SEATS.map(async (seat) => {
      try {
        const raw = await chat(`${seat.system} ${MEMO}`, packet, 1600);
        return { key: seat.key, note: seatFrom(seat.title, raw) };
      } catch (error) {
        return {
          key: seat.key,
          note: null,
          error: error instanceof Error ? error.message : "That seat did not answer.",
        };
      }
    }),
  );
  for (const item of settled) {
    seats[item.key] = item.note;
    if (!item.note && "error" in item && item.error) errors.push(`${item.key}: ${item.error}`);
  }
  let judge: JudgeNote | null = null;
  try {
    const raw = await chat(
      JUDGE,
      JSON.stringify({ tape: packet, seats }),
      2000,
    );
    judge = judgeFrom(raw);
    if (!judge) errors.push("judge: the model did not return a readable note.");
  } catch (error) {
    errors.push(`judge: ${error instanceof Error ? error.message : "did not answer"}`);
  }
  const result: DebateResult = {
    ticker: symbol,
    name: tape.name,
    sector: known?.sector ?? "Unlisted",
    indexName: known?.index ?? "Tape",
    asOf: tape.asOf,
    model: MODEL,
    source: "desk",
    tape,
    seats,
    judge,
    errors,
  };
  try {
    appendArchive(result);
  } catch (error) {
    result.errors.push(`archive: ${error instanceof Error ? error.message : "could not write debates.jsonl"}`);
  }
  return result;
}
