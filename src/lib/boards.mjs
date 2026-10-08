// @ts-nocheck
/**
 * Main-page boards. Public pages only: market caps, recent upgrades, headlines.
 * The judge's bullish notes, when the desk has written them, go first.
 */
import { linkHost, safeHttpUrl, tryNormalizeYahooTicker } from "./yahoo-ticker.mjs";

const LIMIT = 8;
const NEWS_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const NAME_STOP = new Set([
  "target", "group", "energy", "capital", "general", "national", "first", "united",
  "holdings", "financial", "markets", "global", "international", "resources",
  "industries", "technology", "health", "materials", "utilities", "services",
  "partners", "properties", "realty", "power", "water", "steel", "motors", "motor",
  "bank", "banks", "insurance", "trust", "fund", "funds",
]);

const TICKER_STOP = new Set([
  "AI", "US", "UK", "EU", "ETF", "IPO", "CEO", "CFO", "GDP", "CPI", "FED", "SEC",
  "FDA", "DOW", "OIL", "THE", "FOR", "AND", "EPS", "YOY", "ATH", "OTC", "ADR",
  "USD", "EUR", "GBP", "NYSE", "NASDAQ", "AMEX", "TSX", "LSE", "ASX", "QOQ", "YTD",
]);

const AMP = "&" + "amp;";
const LT = "&" + "lt;";
const GT = "&" + "gt;";
const QUOT = "&" + "quot;";
const APOS = "&" + "apos;";
const NBSP = "&" + "nbsp;";

export function decodeEntities(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .split(AMP).join("&")
    .split(LT).join("<")
    .split(GT).join(">")
    .split(QUOT).join('"')
    .split(APOS).join("'")
    .split(NBSP).join(" ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMarketCap(value) {
  const text = decodeEntities(value).replace(/[$,\s]/g, "").toUpperCase();
  const match = text.match(/^(\d+(?:\.\d+)?)([TBMK])?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2] || "";
  const scale = unit === "T" ? 1e12 : unit === "B" ? 1e9 : unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1;
  return amount * scale;
}

export function formatCap(value) {
  if (value == null || !Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toFixed(0)}`;
}

function companyKey(name) {
  return decodeEntities(name)
    .toLowerCase()
    .replace(/\b(class [a-z]|common stock|ordinary shares|inc|incorporated|corp|corporation|ltd|limited|plc|company|co|nv|sa|ag|se)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function symbolOf(raw) {
  const text = decodeEntities(raw).trim();
  if (!text) return null;
  return tryNormalizeYahooTicker(text) || tryNormalizeYahooTicker(text.replace(".", "-"));
}

function dedupeCompanies(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = companyKey(row.name) || row.ticker;
    if (seen.has(key) || seen.has(row.ticker)) continue;
    seen.add(key);
    seen.add(row.ticker);
    out.push(row);
  }
  return out;
}

export function rowsFromBiggestHtml(html) {
  const rows = [];
  for (const part of String(html).split("<tr")) {
    const name = part.match(/title="([^"]+)"/);
    const ticker = part.match(/text-xs text-faded">([A-Z0-9][A-Z0-9.-]{0,12})</);
    const cap = part.match(/text-right font-semibold text-default[^"]*">([^<]+)</);
    if (!name || !ticker || !cap) continue;
    const symbol = symbolOf(ticker[1]);
    const amount = parseMarketCap(cap[1]);
    if (!symbol || amount == null) continue;
    rows.push({ ticker: symbol, name: decodeEntities(name[1]), cap: amount });
  }
  return dedupeCompanies(rows);
}

export function rowsFromUpgradesHtml(html) {
  const rows = [];
  const re = /data-boxover-ticker="([A-Z0-9][A-Z0-9.-]{0,12})" data-boxover-company="([^"]*)"/g;
  let match;
  while ((match = re.exec(String(html)))) {
    const symbol = symbolOf(match[1]);
    if (!symbol) continue;
    rows.push({ ticker: symbol, name: decodeEntities(match[2]) || symbol });
  }
  return dedupeCompanies(rows);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function coreName(name) {
  let tokens = decodeEntities(name).split(/\s+/).filter(Boolean);
  const drop = /^(class|[a-z]|inc|incorporated|corp|corporation|ltd|limited|plc|co|company|nv|sa|ag|se|group)$/i;
  while (tokens.length > 1 && drop.test(tokens[tokens.length - 1].replace(/[.,]+$/g, ""))) tokens.pop();
  if (tokens.length >= 2 && /^class$/i.test(tokens[tokens.length - 2]) && /^[a-z]$/i.test(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -2);
  }
  const core = tokens.join(" ").replace(/\.[a-z]+$/i, "");
  return core;
}

export function buildNameIndex(universe) {
  const byTicker = new Map();
  const buckets = new Map();
  const add = (phrase, ticker) => {
    const key = phrase.toLowerCase().trim();
    if (key.length < 5 || NAME_STOP.has(key)) return;
    const bucket = buckets.get(key) || new Set();
    bucket.add(ticker);
    buckets.set(key, bucket);
  };
  for (const row of universe || []) {
    const ticker = symbolOf(row.ticker) || String(row.ticker || "").toUpperCase();
    if (!ticker) continue;
    const name = decodeEntities(row.name || ticker);
    byTicker.set(ticker, name);
    const core = coreName(name);
    add(core, ticker);
  }
  const phrases = [];
  for (const [phrase, tickers] of buckets) {
    if (tickers.size !== 1) continue;
    phrases.push({ phrase, ticker: [...tickers][0] });
  }
  phrases.sort((a, b) => b.phrase.length - a.phrase.length);
  return { byTicker, phrases };
}

function phraseHit(text, phrase) {
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(phrase)}(?:$|[^a-z0-9])`, "i");
  return re.test(text);
}

export function tickerFromHeadline(title, index) {
  const text = decodeEntities(title);
  const tagged = text.match(/\b(?:NASDAQ|NYSE|NYSEAMERICAN|AMEX|TSX|TSE|LSE|ASX)\s*:\s*([A-Z][A-Z0-9.-]{0,8})\b/i);
  if (tagged) {
    const symbol = symbolOf(tagged[1]);
    if (symbol) return symbol;
  }
  const caps = text.match(/\b[A-Z]{2,5}\b/g) || [];
  for (const token of caps) {
    if (TICKER_STOP.has(token)) continue;
    if (index.byTicker.has(token)) return token;
  }
  const lower = text.toLowerCase();
  for (const row of index.phrases) {
    if (phraseHit(lower, row.phrase)) return row.ticker;
  }
  return null;
}

function headlineTitle(raw) {
  const text = decodeEntities(raw);
  const cut = text.lastIndexOf(" - ");
  if (cut > 20) return { title: text.slice(0, cut).trim(), source: text.slice(cut + 3).trim() };
  return { title: text, source: "" };
}

function parseWhen(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function rowsFromNewsXml(xml, index, now = Date.now()) {
  const rows = [];
  for (const block of String(xml).split(/<item\b/i).slice(1)) {
    const titleRaw = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const linkRaw = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || "";
    const whenRaw = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || "";
    const parsed = headlineTitle(titleRaw);
    if (!parsed.title || parsed.title === "Google News") continue;
    const when = parseWhen(decodeEntities(whenRaw));
    if (when && now - when.getTime() > NEWS_MAX_AGE_MS) continue;
    const ticker = tickerFromHeadline(parsed.title, index);
    if (!ticker) continue;
    const url = safeHttpUrl(decodeEntities(linkRaw).split(AMP).join("&"));
    rows.push({
      ticker,
      name: index.byTicker.get(ticker) || ticker,
      title: parsed.title,
      source: parsed.source || linkHost(url),
      url,
      at: when ? when.getTime() : 0,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.ticker)) continue;
    seen.add(row.ticker);
    out.push(row);
    if (out.length >= LIMIT) break;
  }
  return out;
}

function convictionLabel(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Desk · bullish";
  const pct = value <= 1 ? Math.round(value * 100) : Math.round(value);
  return `Desk · ${pct}`;
}

function shownName(name) {
  return coreName(name).replace(/[.,&]+$/g, "").replace(/\s+/g, " ").trim();
}

export function composeBoards({ largest, upgrades, news, bullish, index }) {
  const names = index?.byTicker || new Map();
  const biggest = (largest || []).slice(0, LIMIT).map((row) => ({
    ticker: row.ticker,
    name: shownName(row.name || names.get(row.ticker) || row.ticker),
    detail: formatCap(row.cap),
    url: null,
  }));
  const bull = [];
  const seenBull = new Set();
  const notes = [...(bullish || [])].sort((a, b) => (b.conviction ?? -1) - (a.conviction ?? -1));
  for (const note of notes) {
    const ticker = symbolOf(note.ticker);
    if (!ticker || seenBull.has(ticker)) continue;
    seenBull.add(ticker);
    bull.push({
      ticker,
      name: shownName(names.get(ticker) || note.name || ticker),
      detail: convictionLabel(note.conviction),
      url: null,
    });
    if (bull.length >= LIMIT) break;
  }
  for (const row of upgrades || []) {
    if (bull.length >= LIMIT) break;
    if (seenBull.has(row.ticker)) continue;
    seenBull.add(row.ticker);
    bull.push({
      ticker: row.ticker,
      name: shownName(row.name || names.get(row.ticker) || row.ticker),
      detail: "Upgraded",
      url: null,
    });
  }
  const wires = (news || []).slice(0, LIMIT).map((row) => ({
    ticker: row.ticker,
    name: shownName(row.name || names.get(row.ticker) || row.ticker),
    detail: row.title,
    url: row.url || null,
  }));
  return {
    asOf: new Date().toISOString(),
    largest: biggest,
    bullish: bull,
    news: wires,
  };
}

async function getText(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const NEWS_QUERIES = [
  "when:1d (shares jump OR shares fall OR shares rise OR stock jumps OR stock falls)",
  "when:1d (upgraded OR downgraded OR price target) (stock OR shares)",
  "when:1d (earnings) (beats OR misses OR guidance)",
];

let cache = null;

export async function loadDeskBoards({ universe, bullish }) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const index = buildNameIndex(universe);
  const headers = { "user-agent": UA, accept: "text/html,application/rss+xml,application/xml,*/*" };
  const [largestHtml, upgradeHtml, ...feeds] = await Promise.all([
    getText("https://stockanalysis.com/list/biggest-companies/", headers).catch(() => ""),
    getText("https://finviz.com/screener.ashx?v=111&s=n_upgrades&ft=4", headers).catch(() => ""),
    ...NEWS_QUERIES.map((query) =>
      getText(
        `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
        headers,
      ).catch(() => ""),
    ),
  ]);
  const news = [];
  const seen = new Set();
  for (const xml of feeds) {
    for (const row of rowsFromNewsXml(xml, index)) {
      if (seen.has(row.ticker)) continue;
      seen.add(row.ticker);
      news.push(row);
    }
  }
  news.sort((a, b) => b.at - a.at);
  const value = composeBoards({
    largest: rowsFromBiggestHtml(largestHtml),
    upgrades: rowsFromUpgradesHtml(upgradeHtml),
    news: news.slice(0, LIMIT),
    bullish,
    index,
  });
  if (value.largest.length || value.bullish.length || value.news.length) {
    cache = { at: Date.now(), value };
  }
  return value;
}

export function clearBoardCache() {
  cache = null;
}
