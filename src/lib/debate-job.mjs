// The job is the existing engine, checked by running it, not by checkJs.
// @ts-nocheck
/**
 * Debate job used by the Mole Intel desk.
 * One ticker: yfinance, FRED, SearXNG, and Finnhub build the packet, six seats
 * write notes on vLLM, then the judge lists the disagreements. The page archives
 * the result to MOLE_DATA/debates.jsonl.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = (process.env.LLM_BASE_URL || "http://127.0.0.1:8000/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || "qwen3.5-9b";
const DATA_DIR = process.env.MOLE_DATA || path.join(process.cwd(), "data");
const PYTHON = process.env.PYTHON || "python3";
const FRED_KEY = process.env.FRED_API_KEY || "";
const SEARXNG_URL = (process.env.SEARXNG_URL || "http://192.168.86.35:8099").replace(/\/$/, "");
const SEARXNG_TIMEOUT = Number(process.env.SEARXNG_TIMEOUT || 15000);
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const EARNINGS_CALLS = Math.max(1, Math.min(6, Number(process.env.EARNINGS_CALLS || 3)));

const AGENTS = {
  bull: { role: "Bull analyst", system: "You are the bull analyst. Argue FOR owning this stock. Use only facts in the packet. Reply with one JSON object: {thesis, evidence[<=4], catalysts[<=3], confidence 0-1}." },
  bear: { role: "Bear analyst", system: "You are the bear analyst. Argue AGAINST owning this stock. Use only facts in the packet. Reply with one JSON object: {thesis, evidence[<=4], risks[<=3], confidence 0-1}." },
  valuation: { role: "Valuation analyst", system: "You are the valuation analyst. Interpret the multiples in the packet. Reply with one JSON object: {summary, metrics, verdict, confidence 0-1}. Missing fields are unknown, not zero." },
  macro: { role: "Macro analyst", system: "You are the macro analyst. Say if the rate, inflation, and growth backdrop helps or hurts this sector. Reply with one JSON object: {summary, backdrop, verdict, confidence 0-1}." },
  earnings: { role: "Earnings-call analyst", system: "You are the earnings-call analyst. The most recent call is the priority. Reply with one JSON object: {most_recent, trend_vs_prior, risks_flagged, confidence 0-1}. If none, say so." },
  analyst: { role: "Analyst-ratings analyst", system: "You are the analyst-ratings analyst. Read ratings, price targets, and insider trades. Reply with one JSON object: {summary, consensus, target_implied_upside_pct, insider_signal, verdict, confidence 0-1}." },
  judge: { role: "Judge", system: "You are the judge on a six-seat desk. Do NOT force agreement. Reply with one JSON object: {call(bullish|bearish|neutral|mixed), conviction 0-1, summary, bull_points[<=3], bear_points[<=3], disagreements[{topic,bull_view,bear_view}], open_questions[<=3]}." },
};

async function chat(system, user, { temperature = 0.2, maxTokens = 1800 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${raw.replace(/\s+/g, " ").slice(0, 240)}`);
  const payload = JSON.parse(raw);
  return payload?.choices?.[0]?.message?.content || "";
}

function stripThink(raw) {
  return String(raw || "").replace(/<think>[\s\S]*?<\/think>/gi, " ").replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ").replace(/<think>[\s\S]*$/i, " ").trim();
}

function extractJson(raw) {
  const text = stripThink(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function ask(agentKey, packet) {
  const { system } = AGENTS[agentKey];
  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    parsed = extractJson(await chat(system, JSON.stringify(packet), { maxTokens: agentKey === "judge" ? 2200 : 1400 }));
  }
  return parsed ? { agent: agentKey, ok: true, note: parsed } : { agent: agentKey, ok: false, error: "model did not return valid JSON" };
}

async function runPython(code) {
  return await new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`python failed: ${stderr.slice(0, 300)}`)));
  });
}

async function yf(ticker) {
  const code = `import json, math, yfinance as yf
def n(v):
    try:
        v=float(v)
        return None if math.isnan(v) or math.isinf(v) else v
    except Exception:
        return None
t=yf.Ticker(${JSON.stringify(ticker)})
info=t.info or {}
keys=["trailingPE","forwardPE","priceToBook","enterpriseToEbitda","returnOnEquity","freeCashflow","marketCap","currentPrice","sector","industry","fiftyTwoWeekHigh","fiftyTwoWeekLow","targetMeanPrice"]
out={k:n(info.get(k)) for k in keys}
try:
    hist=t.history(period="3mo")
    if hist is not None and not hist.empty:
        last=float(hist.iloc[-1]["Close"])
        prev=float(hist.iloc[-2]["Close"]) if len(hist)>1 else last
        out["price_last"]=last
        out["price_change_pct_1d"]=(last/prev-1)*100 if prev else None
        if len(hist)>=22: out["return_1m_pct"]=(last/float(hist.iloc[-22]["Close"])-1)*100
        if len(hist)>=63: out["return_3m_pct"]=(last/float(hist.iloc[-63]["Close"])-1)*100
        out["hist_52w_high"]=float(hist["High"].max())
        out["hist_52w_low"]=float(hist["Low"].min())
except Exception:
    pass
print(json.dumps(out))
`;
  return await runPython(code);
}

async function fred(seriesId) {
  if (!FRED_KEY) return null;
  try {
    const res = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`, { signal: AbortSignal.timeout(20_000) });
    const j = await res.json();
    const v = j?.observations?.[0]?.value;
    return v && v !== "." ? Number(v) : null;
  } catch { return null; }
}

async function finnhub(apiPath) {
  if (!FINNHUB_KEY) return null;
  const url = `https://finnhub.io/api/v1${apiPath}${apiPath.includes("?") ? "&" : "?"}token=${FINNHUB_KEY}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function finnhubData(ticker) {
  if (!FINNHUB_KEY) return { ratings: null, targets: null, insider: null };
  const [ratings, targets, insider] = await Promise.all([
    finnhub(`/stock/recommendation?symbol=${ticker}`),
    finnhub(`/stock/price-target?symbol=${ticker}`),
    finnhub(`/stock/insider-transactions?symbol=${ticker}`),
  ]);
  let ratingsSummary = null;
  if (Array.isArray(ratings) && ratings.length) {
    const latest = ratings[0];
    ratingsSummary = { latest_period: latest.period, strong_buy: latest.strongBuy, buy: latest.buy, hold: latest.hold, sell: latest.sell, strong_sell: latest.strongSell };
  }
  const targetsSummary = targets && typeof targets === "object" ? { high: targets.targetHigh, low: targets.targetLow, mean: targets.targetMean, median: targets.targetMedian } : null;
  let insiderSummary = null;
  if (Array.isArray(insider) && insider.length) {
    const recent = insider.slice(0, 10);
    insiderSummary = {
      open_market_buys: recent.filter((tx) => tx.transactionCode === "P").length,
      open_market_sells: recent.filter((tx) => tx.transactionCode === "S").length,
    };
  }
  return { ratings: ratingsSummary, targets: targetsSummary, insider: insiderSummary };
}

const NEWS_CACHE = new Map();
async function searxng(query, limit) {
  const out = [];
  const seen = new Set();
  try {
    const res = await fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=news`, { signal: AbortSignal.timeout(SEARXNG_TIMEOUT) });
    if (!res.ok) return out;
    const body = await res.json();
    for (const row of body?.results || []) {
      const title = String(row.title || "").trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      out.push({ title: title.slice(0, 300), source: String(row.engine || "").slice(0, 80), published: row.publishedDate || null, excerpt: String(row.content || "").slice(0, 400) });
      if (out.length >= limit) break;
    }
  } catch { /* best effort */ }
  return out;
}

async function searxngNews(ticker) {
  const hit = NEWS_CACHE.get(ticker);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.headlines;
  const a = await searxng(`${ticker} stock news`, 8);
  const b = await searxng(`${ticker} earnings`, 4);
  const headlines = [];
  const seen = new Set();
  for (const row of [...a, ...b]) {
    if (seen.has(row.title)) continue;
    seen.add(row.title);
    headlines.push(row);
    if (headlines.length >= 10) break;
  }
  NEWS_CACHE.set(ticker, { at: Date.now(), headlines });
  return headlines;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function companySnapshot(row) {
  const f = row && typeof row === "object" ? row : {};
  const price = finite(f.currentPrice) ?? finite(f.price_last);
  const marketCap = finite(f.marketCap);
  const fcf = finite(f.freeCashflow);
  return {
    price,
    marketCap,
    trailingPe: finite(f.trailingPE),
    forwardPe: finite(f.forwardPE),
    priceToBook: finite(f.priceToBook),
    evEbitda: finite(f.enterpriseToEbitda),
    roe: finite(f.returnOnEquity),
    fcfYield: fcf != null && marketCap ? fcf / marketCap : null,
    sector: typeof f.sector === "string" ? f.sector : "",
    industry: typeof f.industry === "string" ? f.industry : "",
    targetMean: finite(f.targetMeanPrice) ?? finite(f.avg_price_target),
    high52: finite(f.fiftyTwoWeekHigh) ?? finite(f.hist_52w_high),
    low52: finite(f.fiftyTwoWeekLow) ?? finite(f.hist_52w_low),
    dayPct: finite(f.price_change_pct_1d),
    return1mPct: finite(f.return_1m_pct),
    return3mPct: finite(f.return_3m_pct),
  };
}

async function buildPacket(ticker) {
  const [yfRaw, fed, cpi, unemp, teny, news, street, calls] = await Promise.all([
    yf(ticker).catch((e) => JSON.stringify({ error: e.message })),
    fred("FEDFUNDS"),
    fred("CPIAUCSL"),
    fred("UNRATE"),
    fred("GS10"),
    searxngNews(ticker).catch(() => []),
    finnhubData(ticker).catch(() => ({ ratings: null, targets: null, insider: null })),
    searxng(`${ticker} earnings call transcript`, EARNINGS_CALLS).catch(() => []),
  ]);
  let financials = {};
  try { financials = JSON.parse(yfRaw); } catch { financials = {}; }
  if (financials.freeCashflow && financials.marketCap) financials.fcf_yield = financials.freeCashflow / financials.marketCap;
  if (financials.currentPrice && street.targets?.mean) {
    financials.avg_price_target = street.targets.mean;
    financials.target_vs_price_pct = (street.targets.mean / financials.currentPrice - 1) * 100;
  }
  return {
    ticker,
    as_of: new Date().toISOString(),
    financials,
    macro: { fed_funds: fed, cpi_index: cpi, unemployment: unemp, ten_year_yield: teny },
    news,
    analyst: street,
    earnings_calls: calls,
  };
}

async function debateOne(ticker) {
  const packet = await buildPacket(ticker);
  const [bull, bear, valuation, macro, earnings, analyst] = await Promise.all([
    ask("bull", packet), ask("bear", packet), ask("valuation", packet), ask("macro", packet), ask("earnings", packet), ask("analyst", packet),
  ]);
  const judge = await ask("judge", {
    ticker,
    packet_summary: { financials: packet.financials, macro: packet.macro, news_count: packet.news.length },
    agents: { bull, bear, valuation, macro, earnings, analyst },
  });
  return {
    ticker,
    as_of: packet.as_of,
    model: MODEL,
    company: companySnapshot(packet.financials),
    news: packet.news,
    agents: { bull, bear, valuation, macro, earnings, analyst },
    judge,
  };
}

function archive(result) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(DATA_DIR, "debates.jsonl"), JSON.stringify(result) + "\n");
}

export { debateOne, archive };
