// The job is the existing engine, checked by running it, not by checkJs.
// @ts-nocheck
/**
 * Debate job used by the Mole Intel desk.
 * One ticker: public prints first (NY Fed, BLS, Treasury, Nasdaq, Yahoo,
 * AlphaStreet). SearXNG is used when the homelab search box answers.
 * FRED and Finnhub are fallbacks only, and only for fields the public
 * sources missed. Finnhub's free plan has no price targets and no transcripts.
 * Six seats write notes on Ollama, then the judge lists the disagreements.
 * The news seat is the only one that receives the headlines.
 *
 * Env: LLM_BASE_URL, LLM_MODEL, MOLE_DATA, PYTHON, FRED_API_KEY, SEARXNG_URL,
 * SEARXNG_TIMEOUT, FINNHUB_API_KEY, EARNINGS_CALLS.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkHost, normalizeYahooTicker, safeHttpUrl } from "./yahoo-ticker.mjs";

function loadDeskSecrets() {
  const candidates = [
    path.join(process.cwd(), ".secrets", "desk.env"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".secrets", "desk.env"),
  ];
  for (const file of candidates) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && value && !process.env[key]) process.env[key] = value;
    }
    return;
  }
}

loadDeskSecrets();

const BASE_URL = (process.env.LLM_BASE_URL || "http://192.168.86.35:11434/v1").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || "qwen3.5:9b";
const DATA_DIR = process.env.MOLE_DATA || path.join(process.cwd(), "data");
const PYTHON = process.env.PYTHON || "python3";
const FRED_KEY = process.env.FRED_API_KEY || "";
const SEARXNG_URL = (process.env.SEARXNG_URL || "http://192.168.86.35:8099").replace(/\/$/, "");
const SEARXNG_TIMEOUT = Number(process.env.SEARXNG_TIMEOUT || 15000);
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "";
const EARNINGS_CALLS = Math.max(1, Math.min(6, Number(process.env.EARNINGS_CALLS || 3)));

const WRITE =
  "Think through the packet first, then write the note in plain prose. Take as much length as the evidence needs. Do not use JSON or a fixed schema. Use only facts in the packet. Never invent numbers. If something is missing, say it is unknown.";

const AGENTS = {
  bull: {
    role: "Bull analyst",
    system: `You are the bull analyst. Argue the case FOR owning this stock, including what would have to be true and what would break the case. ${WRITE}`,
  },
  bear: {
    role: "Bear analyst",
    system: `You are the bear analyst. Argue the case AGAINST owning this stock, including what would have to go wrong and what would weaken the case. ${WRITE}`,
  },
  valuation: {
    role: "Valuation analyst",
    system: `You are the valuation analyst. Interpret the multiples in the packet (P/E, P/B, EV/EBITDA, FCF yield, ROE, margins) and the analyst price targets against the current price. Say what looks stretched or cheap. Treat a missing field as unknown, not zero. ${WRITE}`,
  },
  judge: {
    role: "Judge",
    system: `You are the judge. There is no macro seat. Read macro in this packet yourself: fed_funds is the NY Fed effective rate, fed_target is the target range, cpi_yoy is the BLS year-over-year percent (not the index), unemployment, ten_year is the Treasury yield, and payroll_change. A null field is unknown. Do not call the backdrop unavailable when those numbers are present. Weigh that backdrop with the seat notes, including the news seat on how the headlines change the fundamentals. Write a long final note. Say whether the call is bullish, bearish, neutral, or mixed, and do not force the seats to agree. Spell out every disagreement that is still open. ${WRITE}`,
  },
  earnings: {
    role: "Earnings-call analyst",
    system: `You are the earnings-call analyst. Read earnings_calls (transcript excerpts, most recent first) and earnings_results (reported EPS versus consensus, which is not a transcript). Cover guidance, management tone, what was asked, and what changed versus the prior call. If earnings_calls is empty, say so and use earnings_results only. Do not invent quotes. ${WRITE}`,
  },
  analyst: {
    role: "Analyst-ratings analyst",
    system: `You are the analyst-ratings analyst. Read packet.analyst. The source field is finnhub or nasdaq. Use only that source's ratings, price targets, and insider prints. Say whether the street is upgrading or downgrading, whether the average target is above or below the current price, and whether insiders are buying or selling. A missing field is unknown, not zero. If source is none, say the analyst tape was not available. ${WRITE}`,
  },
  news: {
    role: "News analyst",
    system: `You are the news analyst. You are the only seat who reads the headlines. Digest packet.news. Say what the stories report, then how that news changes this company's fundamentals: revenue, margins, demand, costs, balance sheet, or guidance. Use only those headlines and packet.fundamentals. Never invent stories that are not in the packet. If packet.news is empty, say no headlines were retrieved and that the fundamental impact is unknown. ${WRITE}`,
  },
}

// Sequence cap. Ollama must be started with a context at least this long.
// Two sequences at a time, so a 4096-token reply fits --gpu-memory-utilization 0.9 on a 10GB 3080.
const CONTEXT = Number(process.env.LLM_CONTEXT || 65536);
const MAX_OUTPUT = 4096;
const LLM_WAIT_MS = 30 * 60 * 1000;
const LLM_CONCURRENCY = Math.max(1, Number(process.env.LLM_CONCURRENCY || 2));

function llmPost(url, body) {
  const target = new URL(url);
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
        timeout: LLM_WAIT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("LLM request timed out"), { code: "TIMEOUT" })));
    req.on("error", reject);
    req.end(payload);
  });
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 2);
}

function fitCall(system, user, maxTokens) {
  const margin = 512;
  let output = Math.min(maxTokens, MAX_OUTPUT, CONTEXT - 2048);
  let body = String(user || "");
  const fixed = estimateTokens(system) + margin + 32;
  let room = CONTEXT - output - fixed;
  if (room < 2000) {
    output = Math.max(512, CONTEXT - fixed - 2000);
    room = CONTEXT - output - fixed;
  }
  const charBudget = Math.max(2000, room * 2);
  if (body.length > charBudget) body = `${body.slice(0, charBudget)}\n[truncated to fit the context window]`;
  const left = CONTEXT - fixed - estimateTokens(body);
  output = Math.max(256, Math.min(output, left));
  return { body, output };
}

async function chat(system, user, { maxTokens = MAX_OUTPUT } = {}) {
  let fitted = fitCall(system, user, maxTokens);
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await llmPost(`${BASE_URL}/chat/completions`, {
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: fitted.body },
        ],
        temperature: 0.6,
        top_p: 0.95,
        top_k: 20,
        max_tokens: fitted.output,
        chat_template_kwargs: { enable_thinking: true },
      });
    } catch (error) {
      const cause = error?.cause;
      const detail = cause?.code || cause?.message || error?.message || "fetch failed";
      throw new Error(`LLM unreachable at ${BASE_URL} (${detail})`);
    }
    const raw = res.text;
    if (res.ok) {
      const payload = JSON.parse(raw);
      const message = payload?.choices?.[0]?.message || {};
      return splitThink(message.content || "", message.reasoning || message.reasoning_content || "");
    }
    const tooLong = res.status === 400 && /maximum context length|reduce the length/i.test(raw);
    if (tooLong && attempt < 2) {
      fitted = fitCall(system, fitted.body.slice(0, Math.floor(fitted.body.length * 0.6)), Math.max(512, Math.floor(fitted.output / 2)));
      continue;
    }
    throw new Error(`LLM ${res.status}: ${raw.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  throw new Error("LLM request did not fit the context window");
}

function splitThink(content, sideReasoning) {
  const blocks = [];
  const answer = String(content || "")
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_, body) => {
      blocks.push(String(body || "").trim());
      return " ";
    })
    .replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_, body) => {
      blocks.push(String(body || "").trim());
      return " ";
    })
    .replace(/<think>([\s\S]*)$/i, (_, body) => {
      blocks.push(String(body || "").trim());
      return " ";
    })
    .trim();
  const thinking = [String(sideReasoning || "").trim(), ...blocks].filter(Boolean).join("\n\n");
  if (answer) return { answer, thinking };
  return { answer: thinking, thinking: "" };
}

function stripThink(raw) {
  return splitThink(raw, "").answer;
}

function extractJson(raw) {
  const text = stripThink(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function ask(agentKey, packet) {
  const { system } = AGENTS[agentKey];
  const { answer } = await chat(system, packetText(packet), { maxTokens: MAX_OUTPUT });
  const parsed = extractJson(answer);
  const shaped =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    ["summary", "thesis", "call", "argument", "fundamental_impact", "verdict"].some((key) => parsed[key]);
  if (shaped) return { agent: agentKey, ok: true, note: parsed };
  if (!answer) return { agent: agentKey, ok: false, error: "model returned nothing" };
  return { agent: agentKey, ok: true, note: { argument: answer } };
}

// ---------- Data layer ----------

async function yf(ticker) {
  const code = `
import json, yfinance as yf
t = yf.Ticker(${JSON.stringify(ticker)})
info = t.info or {}
keys = ["trailingPE","forwardPE","priceToBook","enterpriseToEbitda","profitMargins","grossMargins","returnOnEquity","freeCashflow","totalRevenue","sector","industry","marketCap","currentPrice","fiftyTwoWeekHigh","fiftyTwoWeekLow","earningsTimestamp","earningsDate","recommendationKey","numberOfAnalystOpinions","targetMeanPrice","targetHighPrice","targetLowPrice"]
out = {k: info.get(k) for k in keys}
try:
    cf = t.cashflow
    if cf is not None and not cf.empty:
        row = cf.iloc[:,0]
        out["operatingCashFlow"] = float(row.get("Operating Cash Flow", float("nan")))
        out["capex"] = float(row.get("Capital Expenditure", float("nan")))
except Exception:
    pass
try:
    hist = t.history(period="3mo")
    if hist is not None and not hist.empty:
        last = hist.iloc[-1]
        prev = hist.iloc[-2] if len(hist) > 1 else last
        out["price_last"] = float(last["Close"])
        out["price_prev_close"] = float(prev["Close"])
        out["price_change_pct_1d"] = float((last["Close"]/prev["Close"]-1)*100)
        if len(hist) >= 22:
            out["return_1m_pct"] = float((last["Close"]/hist.iloc[-22]["Close"]-1)*100)
        if len(hist) >= 63:
            out["return_3m_pct"] = float((last["Close"]/hist.iloc[-63]["Close"]-1)*100)
        out["hist_52w_high"] = float(hist["High"].max())
        out["hist_52w_low"] = float(hist["Low"].min())
except Exception:
    pass
try:
    def clean(value):
        try:
            number = float(value)
        except Exception:
            return None
        if number != number or number in (float("inf"), float("-inf")):
            return None
        return number
    def line(frame, names):
        try:
            if frame is None or frame.empty:
                return None
            column = frame.iloc[:, 0]
            lookup = {str(label).strip().lower(): label for label in column.index}
            for name in names:
                key = lookup.get(name.lower())
                if key is not None:
                    return clean(column.loc[key])
        except Exception:
            return None
        return None
    income = t.income_stmt
    balance = t.balance_sheet
    price = clean(out.get("currentPrice")) or clean(out.get("price_last"))
    cap = clean(out.get("marketCap"))
    net = line(income, ["Net Income", "Net Income Common Stockholders"])
    equity = line(balance, ["Stockholders Equity", "Common Stock Equity", "Total Equity Gross Minority Interest"])
    ebit = line(income, ["EBIT", "Operating Income"])
    ebitda = line(income, ["EBITDA", "Normalized EBITDA"])
    if ebitda is None and ebit is not None:
        amort = line(cf if "cf" in dir() else None, ["Depreciation And Amortization", "Depreciation Amortization Depletion", "Depreciation"])
        ebitda = ebit + abs(amort or 0)
    debt = line(balance, ["Total Debt"])
    cash = line(balance, ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"])
    if not clean(out.get("trailingPE")) and cap and net and net > 0:
        out["trailingPE"] = cap / net
    if not clean(out.get("priceToBook")) and cap and equity and equity > 0:
        out["priceToBook"] = cap / equity
    if not clean(out.get("enterpriseToEbitda")) and cap and ebitda and ebitda > 0:
        enterprise = cap + (debt or 0) - (cash or 0)
        if enterprise > 0:
            out["enterpriseToEbitda"] = enterprise / ebitda
    if not clean(out.get("forwardPE")) and price:
        estimate = t.get_earnings_estimate()
        if estimate is not None and not estimate.empty and "0y" in estimate.columns and "avg" in estimate.index:
            forward_eps = clean(estimate.loc["avg", "0y"])
            if forward_eps and forward_eps > 0:
                out["forwardPE"] = price / forward_eps
except Exception:
    pass
print(json.dumps({k: (None if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))) else v) for k, v in out.items()}))
`;
  return await runPython(code);
}

async function runPython(code) {
  return await new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 25_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`python failed: ${stderr.slice(0, 300)}`));
      else resolve(stdout.trim());
    });
  });
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const BLS_UA = "Mozilla/5.0 (compatible; MoleDesk/1.0; +https://www.bls.gov)";
const NASDAQ_HEADERS = {
  accept: "application/json",
  origin: "https://www.nasdaq.com",
  referer: "https://www.nasdaq.com/",
  "user-agent": BROWSER_UA,
};

const MACRO_CACHE = { at: 0, value: null };
const MACRO_TTL_MS = 6 * 60 * 60 * 1000;
const NEWS_CACHE = new Map();
const NEWS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseNasdaqAmount(raw) {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text || text === "--" || /^n\/?a$/i.test(text)) return null;
  const paren = /^\(.*\)$/.test(text);
  text = text.replace(/[$,%\s]/g, "").replace(/[()]/g, "");
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return paren ? -Math.abs(value) : value;
}

function monthStamp(name, year) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.findIndex((month) => String(name).toLowerCase().startsWith(month));
  if (index < 0 || !year) return `${name} ${year}`.trim();
  return `${year}-${String(index + 1).padStart(2, "0")}`;
}

export function parseBlsLatest(xml) {
  const text = String(xml)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const unemployment = text.match(/Unemployment Rate:\s*([0-9.]+)%\s*in\s+([A-Za-z]+)\s+(\d{4})/);
  const cpi = text.match(/Consumer Price Index \(CPI\):\s*([+-]?[0-9.]+)%\s*in\s+([A-Za-z]+)\s+(\d{4})/);
  const payroll = text.match(/Payroll Employment:\s*([+-]?[0-9,]+)/);
  return {
    unemployment: unemployment ? Number(unemployment[1]) : null,
    unemployment_as_of: unemployment ? monthStamp(unemployment[2], unemployment[3]) : null,
    cpi_mom: cpi ? Number(cpi[1]) : null,
    cpi_mom_as_of: cpi ? monthStamp(cpi[2], cpi[3]) : null,
    payroll_change: payroll ? Number(payroll[1].replace(/,/g, "")) : null,
  };
}

export function cpiYoyFromBls(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("CUUR0000SA0")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    if (!/^M(0[1-9]|1[0-2])$/.test(parts[2])) continue;
    const value = Number(parts[3]);
    const year = Number(parts[1]);
    if (!Number.isFinite(value) || !Number.isFinite(year)) continue;
    rows.push({ year, month: Number(parts[2].slice(1)), value });
  }
  const last = rows.at(-1);
  if (!last) return null;
  const prev = rows.find((row) => row.year === last.year - 1 && row.month === last.month);
  if (!prev?.value) return null;
  return {
    cpi_yoy: Math.round((last.value / prev.value - 1) * 1000) / 10,
    cpi_index: last.value,
    cpi_as_of: `${last.year}-${String(last.month).padStart(2, "0")}`,
  };
}

export function tenYearFromTreasuryCsv(csv) {
  const lines = String(csv)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map((cell) => cell.replace(/"/g, "").trim());
  const index = header.findIndex((cell) => cell === "10 Yr");
  if (index < 0) return null;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((cell) => cell.replace(/"/g, "").trim());
    const value = Number(cols[index]);
    if (!Number.isFinite(value)) continue;
    const [mm, dd, yyyy] = (cols[0] || "").split("/");
    const as_of = yyyy && mm && dd ? `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}` : cols[0] || null;
    return { ten_year: value, ten_year_as_of: as_of };
  }
  return null;
}

export function effrFromNyFed(body) {
  const row = (body?.refRates || []).find((item) => item?.type === "EFFR" && Number.isFinite(Number(item.percentRate)));
  if (!row) return null;
  const from = Number(row.targetRateFrom);
  const to = Number(row.targetRateTo);
  return {
    fed_funds: Number(row.percentRate),
    fed_funds_as_of: typeof row.effectiveDate === "string" ? row.effectiveDate : null,
    fed_target: Number.isFinite(from) && Number.isFinite(to) ? `${from.toFixed(2)}-${to.toFixed(2)}` : null,
  };
}

export function fiscalRank(title) {
  const match = String(title).match(/Q([1-4])\s+(\d{4})/i);
  if (!match) return 0;
  return Number(match[2]) * 10 + Number(match[1]);
}

function decodeHtml(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;|&#0*38;/g, "&")
    .replace(/&lt;|&#0*60;/g, "<")
    .replace(/&gt;|&#0*62;/g, ">")
    .replace(/&quot;|&#0*34;/g, '"')
    .replace(/&#8217;|&#039;|&#39;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, "-")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

async function getText(url, timeoutMs, headers) {
  const res = await fetch(url, {
    headers: { "user-agent": BROWSER_UA, accept: "application/json,text/html,text/plain,*/*", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function fredLatest(seriesId) {
  if (!FRED_KEY) return null;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=14`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const body = await res.json();
    const observations = body?.observations || [];
    const numbers = observations
      .map((row) => ({ date: row.date, value: row.value && row.value !== "." ? Number(row.value) : null }))
      .filter((row) => Number.isFinite(row.value));
    return numbers;
  } catch {
    return null;
  }
}

async function readMacro() {
  if (MACRO_CACHE.value && Date.now() - MACRO_CACHE.at < MACRO_TTL_MS) return MACRO_CACHE.value;
  const macro = {
    fed_funds: null,
    fed_funds_as_of: null,
    fed_target: null,
    cpi_yoy: null,
    cpi_index: null,
    cpi_as_of: null,
    cpi_mom: null,
    unemployment: null,
    unemployment_as_of: null,
    ten_year: null,
    ten_year_as_of: null,
    ten_year_yield: null,
    payroll_change: null,
    sources: {},
  };
  const [ny, treasury, blsRss, cpiFile] = await Promise.all([
    getText("https://markets.newyorkfed.org/api/rates/all/latest.json", 15_000).catch(() => null),
    getText(
      "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&page&_format=csv",
      15_000,
    ).catch(() => null),
    getText("https://www.bls.gov/feed/bls_latest.rss", 15_000, { "user-agent": BLS_UA, accept: "application/rss+xml,application/xml,text/xml" }).catch(
      () => null,
    ),
    getText("https://download.bls.gov/pub/time.series/cu/cu.data.1.AllItems", 40_000, { "user-agent": BLS_UA, accept: "text/plain" }).catch(
      () => null,
    ),
  ]);
  if (ny?.ok) {
    try {
      const parsed = effrFromNyFed(JSON.parse(ny.text));
      if (parsed) {
        Object.assign(macro, parsed);
        macro.sources.fed_funds = "NY Fed EFFR";
      }
    } catch {
      // ignore a torn payload
    }
  }
  if (treasury?.ok) {
    const parsed = tenYearFromTreasuryCsv(treasury.text);
    if (parsed) {
      macro.ten_year = parsed.ten_year;
      macro.ten_year_as_of = parsed.ten_year_as_of;
      macro.sources.ten_year = "US Treasury yield curve";
    }
  }
  if (blsRss?.ok) {
    const parsed = parseBlsLatest(blsRss.text);
    macro.unemployment = parsed.unemployment;
    macro.unemployment_as_of = parsed.unemployment_as_of;
    macro.cpi_mom = parsed.cpi_mom;
    macro.payroll_change = parsed.payroll_change;
    if (parsed.unemployment != null) macro.sources.unemployment = "BLS latest numbers";
  }
  if (cpiFile?.ok) {
    const parsed = cpiYoyFromBls(cpiFile.text);
    if (parsed) {
      macro.cpi_yoy = parsed.cpi_yoy;
      macro.cpi_index = parsed.cpi_index;
      macro.cpi_as_of = parsed.cpi_as_of;
      macro.sources.cpi = "BLS CPI-U CUUR0000SA0";
    }
  }
  const missing =
    macro.fed_funds == null || macro.unemployment == null || macro.ten_year == null || macro.cpi_yoy == null;
  if (FRED_KEY && missing) {
    const [fredFunds, fredCpi, fredUnemp, fredTen] = await Promise.all([
      macro.fed_funds == null ? fredLatest("FEDFUNDS") : null,
      macro.cpi_yoy == null ? fredLatest("CPIAUCSL") : null,
      macro.unemployment == null ? fredLatest("UNRATE") : null,
      macro.ten_year == null ? fredLatest("GS10") : null,
    ]);
    if (macro.fed_funds == null && fredFunds?.[0]) {
      macro.fed_funds = fredFunds[0].value;
      macro.fed_funds_as_of = fredFunds[0].date;
      macro.sources.fed_funds = "FRED FEDFUNDS";
    }
    if (macro.unemployment == null && fredUnemp?.[0]) {
      macro.unemployment = fredUnemp[0].value;
      macro.unemployment_as_of = fredUnemp[0].date;
      macro.sources.unemployment = "FRED UNRATE";
    }
    if (macro.ten_year == null && fredTen?.[0]) {
      macro.ten_year = fredTen[0].value;
      macro.ten_year_as_of = fredTen[0].date;
      macro.sources.ten_year = "FRED GS10";
    }
    if (macro.cpi_yoy == null && fredCpi && fredCpi.length >= 13) {
      const latest = fredCpi[0].value;
      const yearAgo = fredCpi[12].value;
      if (latest && yearAgo) {
        macro.cpi_yoy = Math.round((latest / yearAgo - 1) * 1000) / 10;
        macro.cpi_index = latest;
        macro.cpi_as_of = fredCpi[0].date;
        macro.sources.cpi = "FRED CPIAUCSL";
      }
    }
  }
  macro.ten_year_yield = macro.ten_year;
  const filled = [macro.fed_funds, macro.cpi_yoy, macro.unemployment, macro.ten_year].filter((value) => value != null).length;
  MACRO_CACHE.at = filled >= 2 ? Date.now() : Date.now() - MACRO_TTL_MS + 60_000;
  MACRO_CACHE.value = macro;
  return macro;
}

async function finnhub(path) {
  if (!FINNHUB_KEY) return { ok: false, status: 0, json: null, reason: "no_key" };
  const url = `https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${FINNHUB_KEY}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json, reason: res.ok ? "ok" : "http" };
  } catch {
    return { ok: false, status: 0, json: null, reason: "error" };
  }
}

function finnhubStatus(calls) {
  if (!FINNHUB_KEY) return "no_key";
  if (calls.some((call) => call.reason === "error")) return "error";
  if (calls.some((call) => call.status === 401 || call.status === 403)) return "rejected";
  return "empty";
}

async function finnhubData(ticker) {
  if (!FINNHUB_KEY) {
    return { ratings: null, targets: null, insider: null, earnings: null, status: "no_key" };
  }
  const symbols = nasdaqSymbols(ticker);
  let ratings = null;
  let targets = null;
  let insider = null;
  let earnings = null;
  let calls = [];
  for (const symbol of symbols) {
    const batch = await Promise.all([
      finnhub(`/stock/recommendation?symbol=${encodeURIComponent(symbol)}`),
      finnhub(`/stock/price-target?symbol=${encodeURIComponent(symbol)}`),
      finnhub(`/stock/insider-transactions?symbol=${encodeURIComponent(symbol)}`),
      finnhub(`/stock/earnings?symbol=${encodeURIComponent(symbol)}`),
    ]);
    calls = batch;
    const [rec, target, insiderCall, earn] = batch;
    if (Array.isArray(rec.json) && rec.json.length) ratings = rec.json;
    if (target.json && typeof target.json === "object" && target.json.targetMean != null) targets = target.json;
    const insiderRows = Array.isArray(insiderCall.json)
      ? insiderCall.json
      : Array.isArray(insiderCall.json?.data)
        ? insiderCall.json.data
        : null;
    if (insiderRows?.length) insider = insiderRows;
    if (Array.isArray(earn.json) && earn.json.length) earnings = earn.json;
    if (ratings || targets || insider) break;
  }
  let ratingsSummary = null;
  if (Array.isArray(ratings) && ratings.length) {
    const latest = ratings[0];
    const prev = ratings[1] || null;
    ratingsSummary = {
      latest_period: latest.period,
      strong_buy: latest.strongBuy,
      buy: latest.buy,
      hold: latest.hold,
      sell: latest.sell,
      strong_sell: latest.strongSell,
      trend: prev
        ? {
            strong_buy_delta: latest.strongBuy - prev.strongBuy,
            buy_delta: latest.buy - prev.buy,
            sell_delta: latest.sell - prev.sell,
            strong_sell_delta: latest.strongSell - prev.strongSell,
          }
        : null,
    };
  }
  let targetsSummary = null;
  if (targets && typeof targets === "object") {
    targetsSummary = {
      high: targets.targetHigh,
      low: targets.targetLow,
      mean: targets.targetMean,
      median: targets.targetMedian,
      last_updated: targets.lastUpdated,
    };
  }
  let insiderSummary = null;
  if (Array.isArray(insider) && insider.length) {
    const recent = insider.slice(0, 10);
    let buys = 0;
    let sells = 0;
    for (const tx of recent) {
      const code = String(tx.transactionCode || "");
      if (code === "P") buys += 1;
      else if (code === "S") sells += 1;
    }
    insiderSummary = {
      recent_count: recent.length,
      open_market_buys: buys,
      open_market_sells: sells,
      latest: recent.slice(0, 3).map((tx) => ({
        name: tx.name,
        code: tx.transactionCode,
        shares: tx.share,
        date: tx.transactionDate,
      })),
    };
  }
  const earningsSummary = Array.isArray(earnings)
    ? earnings.slice(0, 4).map((row) => ({
        period: row.period,
        actual: row.actual,
        estimate: row.estimate,
        surprise_pct: row.surprisePercent,
      }))
    : null;
  const status = ratingsSummary || targetsSummary || insiderSummary ? "ok" : finnhubStatus(calls);
  return { ratings: ratingsSummary, targets: targetsSummary, insider: insiderSummary, earnings: earningsSummary, status };
}

function nasdaqSymbols(ticker) {
  const raw = String(ticker || "").toUpperCase();
  const base = raw.split(".")[0].replace("/", "-");
  return [...new Set([base, raw].filter(Boolean))];
}

async function nasdaqJson(path) {
  try {
    const res = await fetch(`https://api.nasdaq.com${path}`, {
      headers: NASDAQ_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.data || body.data.symbol == null && body?.status?.rCode >= 400) return null;
    return body.data;
  } catch {
    return null;
  }
}

function tableRow(table, label) {
  return (table?.rows || []).find((row) => String(row?.value1 || "").trim().toLowerCase() === label.toLowerCase()) || null;
}

export function multiplesFromFigures(input) {
  const row = input || {};
  const sane = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 10000 ? value : null);
  const marketCap = finite(row.marketCap);
  const price = finite(row.price);
  const netIncome = finite(row.netIncome);
  const equity = finite(row.equity);
  const ebit = finite(row.ebit);
  const depreciation = finite(row.depreciation);
  const trailing = sane(row.actualPe) ?? (marketCap != null && netIncome != null && netIncome > 0 ? marketCap / netIncome : null);
  const forward = sane(row.forwardPe) ?? (price != null && finite(row.forwardEps) != null && row.forwardEps > 0 ? price / row.forwardEps : null);
  const book = marketCap != null && equity != null && equity > 0 ? marketCap / equity : null;
  const ebitda = ebit == null ? null : ebit + Math.abs(depreciation || 0);
  const cash = finite(row.cash) || 0;
  const debt = (finite(row.shortDebt) || 0) + (finite(row.longDebt) || 0);
  const enterprise = marketCap == null ? null : marketCap + debt - cash;
  return {
    trailingPE: sane(trailing),
    forwardPE: sane(forward),
    priceToBook: sane(book),
    enterpriseToEbitda: ebitda != null && ebitda > 0 && enterprise != null && enterprise > 0 ? sane(enterprise / ebitda) : null,
  };
}

function pePoints(peg) {
  const chart = peg?.per?.peRatioChart;
  if (!Array.isArray(chart)) return { actualPe: null, forwardPe: null };
  const actual = [...chart].reverse().find((point) => /actual/i.test(String(point?.x || "")));
  const estimate = chart.find((point) => /estimate/i.test(String(point?.x || "")));
  return {
    actualPe: finite(Number(actual?.y)),
    forwardPe: finite(Number(estimate?.y)),
  };
}

const SNAPSHOT_CACHE = new Map();
const TRANSCRIPT_INDEX = new Map();
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

async function nasdaqSnapshot(ticker) {
  const key = nasdaqSymbols(ticker).join("|");
  const cached = SNAPSHOT_CACHE.get(key);
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
  const value = await loadNasdaqSnapshot(ticker);
  SNAPSHOT_CACHE.set(key, { at: Date.now(), value });
  return value;
}

async function loadNasdaqSnapshot(ticker) {
  for (const symbol of nasdaqSymbols(ticker)) {
    const [info, summary, targets, ratings, insider, earnings, financials, peg, forecast] = await Promise.all([
      nasdaqJson(`/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`),
      nasdaqJson(`/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`),
      nasdaqJson(`/api/analyst/${encodeURIComponent(symbol)}/targetprice`),
      nasdaqJson(`/api/analyst/${encodeURIComponent(symbol)}/ratings`),
      nasdaqJson(`/api/company/${encodeURIComponent(symbol)}/insider-trades?limit=10`),
      nasdaqJson(`/api/company/${encodeURIComponent(symbol)}/earnings-surprise`),
      nasdaqJson(`/api/company/${encodeURIComponent(symbol)}/financials?frequency=1`),
      nasdaqJson(`/api/analyst/${encodeURIComponent(symbol)}/peg-ratio`),
      nasdaqJson(`/api/analyst/${encodeURIComponent(symbol)}/earnings-forecast`),
    ]);
    if (!info?.symbol && !summary?.symbol) continue;
    const consensus = targets?.consensusOverview || {};
    const analystCount = String(ratings?.ratingsSummary || "").match(/(\d+)\s+analysts/i);
    const tradeRows = insider?.numberOfTrades?.rows || [];
    const trade = (label) => {
      const row = tradeRows.find((item) => String(item.insiderTrade || "").toLowerCase() === label.toLowerCase());
      return row ? parseNasdaqAmount(row.months3) : null;
    };
    const ratios = financials?.financialRatiosTable;
    const income = financials?.incomeStatementTable;
    const balance = financials?.balanceSheetTable;
    const cash = financials?.cashFlowTable;
    const ratio = (label) => {
      const amount = parseNasdaqAmount(tableRow(ratios, label)?.value2);
      return amount == null ? null : amount / 100;
    };
    const dollars = (table, label) => {
      const amount = parseNasdaqAmount(tableRow(table, label)?.value2);
      return amount == null ? null : amount * 1000;
    };
    const revenue = dollars(income, "Total Revenue");
    const operatingCash = dollars(cash, "Net Cash Flow-Operating");
    const capex = dollars(cash, "Capital Expenditures");
    const marketCap = parseNasdaqAmount(summary?.summaryData?.MarketCap?.value);
    const price = parseNasdaqAmount(info?.primaryData?.lastSalePrice);
    const yearly = forecast?.yearlyForecast?.rows?.[0];
    const multiples = multiplesFromFigures({
      marketCap,
      price,
      netIncome: dollars(income, "Net Income-Cont. Operations") ?? dollars(cash, "Net Income"),
      equity: dollars(balance, "Total Equity"),
      ebit: dollars(income, "Earnings Before Interest and Tax"),
      depreciation: dollars(cash, "Depreciation"),
      cash: dollars(balance, "Cash and Cash Equivalents"),
      shortDebt: dollars(balance, "Short-Term Debt / Current Portion of Long-Term Debt"),
      longDebt: dollars(balance, "Long-Term Debt"),
      ...pePoints(peg),
      forwardEps: finite(Number(yearly?.consensusEPSForecast)),
    });
    const surpriseRows = earnings?.earningsSurpriseTable?.rows || [];
    return {
      symbol: info?.symbol || summary?.symbol || symbol,
      listing_note: (info?.symbol || symbol) === String(ticker).toUpperCase() ? null : `Nasdaq listing ${info?.symbol || symbol}`,
      price,
      marketCap,
      trailingPE: multiples.trailingPE,
      forwardPE: multiples.forwardPE,
      priceToBook: multiples.priceToBook,
      enterpriseToEbitda: multiples.enterpriseToEbitda,
      sector: summary?.summaryData?.Sector?.value || "",
      industry: summary?.summaryData?.Industry?.value || "",
      grossMargins: ratio("Gross Margin"),
      profitMargins: ratio("Profit Margin"),
      returnOnEquity: ratio("After Tax ROE"),
      totalRevenue: revenue,
      operatingCashFlow: operatingCash,
      capex,
      freeCashflow: operatingCash != null && capex != null ? operatingCash + capex : null,
      analyst: {
        source: "nasdaq",
        symbol: info?.symbol || symbol,
        consensus: ratings?.meanRatingType || null,
        analysts: analystCount ? Number(analystCount[1]) : null,
        summary: ratings?.ratingsSummary || null,
        targets: {
          high: finite(Number(consensus.highPriceTarget)) ? Number(consensus.highPriceTarget) : null,
          low: finite(Number(consensus.lowPriceTarget)) ? Number(consensus.lowPriceTarget) : null,
          mean: finite(Number(consensus.priceTarget)) ? Number(consensus.priceTarget) : null,
          buy: consensus.buy ?? null,
          hold: consensus.hold ?? null,
          sell: consensus.sell ?? null,
        },
        insider: {
          open_market_buys_3m: trade("Number of Open Market Buys"),
          sells_3m: trade("Number of Sells"),
        },
      },
      earnings: surpriseRows.slice(0, 4).map((row) => ({
        fiscal_quarter_end: row.fiscalQtrEnd,
        date: row.dateReported,
        eps: finite(Number(row.eps)) ? Number(row.eps) : parseNasdaqAmount(row.eps),
        consensus: parseNasdaqAmount(row.consensusForecast),
        surprise_pct: parseNasdaqAmount(row.percentageSurprise),
      })),
    };
  }
  return null;
}

function analystLine(block) {
  if (!block || block.source === "none") return "No analyst tape.";
  const mean = block.targets?.mean;
  const count = block.ratings?.analysts || block.analysts;
  const consensus = block.consensus || block.ratings?.consensus || block.summary;
  const parts = [block.source === "finnhub" ? "Finnhub" : "Nasdaq"];
  if (typeof consensus === "string" && consensus) parts.push(consensus.split(".")[0]);
  if (count) parts.push(`${count} analysts`);
  if (mean != null) parts.push(`target $${Number(mean).toFixed(0)}`);
  return parts.join(" · ");
}

export function transcriptLinksFromHtml(html) {
  const found = [];
  const seen = new Set();
  const pattern = /<a[^>]+href="(https:\/\/news\.alphastreet\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html)))) {
    const url = match[1].replace(/&amp;/g, "&");
    const title = decodeHtml(match[2].replace(/<[^>]+>/g, " "));
    if (!/earnings call transcript/i.test(title)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ url, title, rank: fiscalRank(title) });
  }
  return found.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
}

function transcriptExcerpt(html) {
  let text = String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const article = text.match(/<article[\s\S]*?<\/article>/i);
  text = decodeHtml((article ? article[0] : text).replace(/<[^>]+>/g, " "));
  const start = text.search(/\b(Presentation|Corporate Participants|Operator)\b/);
  const body = start >= 0 ? text.slice(start) : text;
  return body.slice(0, 3200);
}

async function alphaStreetCalls(ticker, withBodies) {
  const base = nasdaqSymbols(ticker)[0].toLowerCase();
  let links = TRANSCRIPT_INDEX.get(base);
  if (!links || Date.now() - links.at > SNAPSHOT_TTL_MS) {
    const indexUrl = `https://news.alphastreet.com/ticker/${encodeURIComponent(base)}/transcripts/`;
    let index;
    try {
      index = await getText(indexUrl, 15_000, { accept: "text/html" });
    } catch {
      return [];
    }
    if (!index.ok) return [];
    links = { at: Date.now(), rows: transcriptLinksFromHtml(index.text).slice(0, EARNINGS_CALLS) };
    TRANSCRIPT_INDEX.set(base, links);
  }
  if (!withBodies) {
    return links.rows.map((link) => ({
      title: link.title,
      source: "AlphaStreet",
      url: link.url,
      kind: "transcript",
      excerpt: "",
    }));
  }
  const calls = [];
  for (const link of links.rows) {
    try {
      const page = await getText(link.url, 15_000, { accept: "text/html" });
      if (!page.ok) continue;
      const dated = page.text.match(/dated\s+([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})/i);
      calls.push({
        title: link.title,
        source: "AlphaStreet",
        url: link.url,
        published: dated ? dated[1] : null,
        kind: "transcript",
        excerpt: transcriptExcerpt(page.text),
      });
    } catch {
      // one missed call should not drop the rest
    }
  }
  return calls;
}

async function earningsTranscripts(ticker) {
  const direct = await alphaStreetCalls(ticker, true);
  if (direct.length) return direct;
  const queries = [`${ticker} earnings call transcript Q`, `${ticker} earnings call highlights guidance`];
  const snippets = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json&categories=news`;
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(SEARXNG_TIMEOUT, 4000)) });
      if (!res.ok) continue;
      const body = await res.json();
      for (const row of body?.results || []) {
        const title = String(row.title || "").trim();
        const content = String(row.content || "").trim();
        const key = title.slice(0, 80);
        if (!title || seen.has(key)) continue;
        seen.add(key);
        snippets.push({
          title: title.slice(0, 300),
          source: String(row.engine || "searxng").slice(0, 120),
          published: row.publishedDate || null,
          url: safeHttpUrl(row.url),
          kind: "search_snippet",
          excerpt: content.slice(0, 600),
        });
        if (snippets.length >= EARNINGS_CALLS) break;
      }
    } catch {
      // homelab search is optional
    }
    if (snippets.length >= EARNINGS_CALLS) break;
  }
  return snippets;
}

async function yahooHeadlines(ticker) {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const res = await fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: "application/rss+xml,application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const stories = [];
    for (const block of xml.split(/<item\b/i).slice(1)) {
      const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
      const title = decodeHtml(titleMatch?.[1] || "");
      if (!title || /yahoo! finance/i.test(title)) continue;
      const link = safeHttpUrl(decodeHtml(linkMatch?.[1] || ""));
      stories.push({
        title: title.slice(0, 300),
        source: linkHost(link) || "Yahoo Finance",
        published: dateMatch ? decodeHtml(dateMatch[1]) : null,
        url: link,
      });
      if (stories.length >= 8) break;
    }
    return stories;
  } catch {
    return [];
  }
}

async function searxngNews(ticker) {
  const cached = NEWS_CACHE.get(ticker);
  if (cached && Date.now() - cached.at < NEWS_CACHE_TTL_MS && cached.headlines.length) return cached;
  const queries = [`${ticker} stock news`, `${ticker} earnings`];
  const headlines = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(q)}&format=json&categories=news`;
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(SEARXNG_TIMEOUT, 4000)) });
      if (!res.ok) continue;
      const body = await res.json();
      for (const row of body?.results || []) {
        const title = String(row.title || "").trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        headlines.push({
          title: title.slice(0, 300),
          source: linkHost(row.url) || String(row.engine || "").slice(0, 120),
          published: row.publishedDate || null,
          url: safeHttpUrl(row.url),
        });
        if (headlines.length >= 10) break;
      }
    } catch {
      // best-effort
    }
    if (headlines.length >= 10) break;
  }
  let source = "searxng";
  if (!headlines.length) {
    const yahoo = await yahooHeadlines(ticker);
    headlines.push(...yahoo);
    source = yahoo.length ? "yahoo" : "none";
  }
  const pack = { at: Date.now(), headlines, source };
  NEWS_CACHE.set(ticker, pack);
  return pack;
}

async function yahooChart(ticker) {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=3mo`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=3mo`,
  ];
  for (const url of urls) {
    try {
      const pulled = await getText(url, 12_000);
      if (!pulled.ok) continue;
      const body = JSON.parse(pulled.text);
      const result = body?.chart?.result?.[0];
      const meta = result?.meta || {};
      const closes = (result?.indicators?.quote?.[0]?.close || []).filter((value) => typeof value === "number" && Number.isFinite(value));
      const price = finite(meta.regularMarketPrice) ?? closes.at(-1) ?? null;
      const previous = finite(meta.chartPreviousClose) ?? finite(meta.previousClose) ?? closes.at(-2) ?? null;
      const monthAgo = closes.length >= 22 ? closes[closes.length - 22] : null;
      const first = closes[0] ?? null;
      return {
        currentPrice: price,
        price_last: price,
        price_prev_close: previous,
        price_change_pct_1d: price != null && previous ? (price / previous - 1) * 100 : null,
        return_1m_pct: price != null && monthAgo ? (price / monthAgo - 1) * 100 : null,
        return_3m_pct: price != null && first ? (price / first - 1) * 100 : null,
        fiftyTwoWeekHigh: finite(meta.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: finite(meta.fiftyTwoWeekLow),
        currency: typeof meta.currency === "string" ? meta.currency : null,
      };
    } catch {
      // try the other host
    }
  }
  return null;
}

function fillMissing(target, extra) {
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null || value === "") continue;
    if (target[key] == null || target[key] === "") target[key] = value;
  }
  return target;
}

async function yfinanceInstalled() {
  try {
    await runPython("import yfinance\nprint('ok')");
    return true;
  } catch {
    return false;
  }
}

function emptyMacro() {
  return {
    fed_funds: null,
    fed_funds_as_of: null,
    fed_target: null,
    cpi_yoy: null,
    cpi_as_of: null,
    cpi_mom: null,
    unemployment: null,
    unemployment_as_of: null,
    ten_year: null,
    ten_year_as_of: null,
    payroll_change: null,
  };
}

function reportFrom(ticker, parts) {
  const macro = parts.macro || emptyMacro();
  const analystSource = parts.analyst?.source === "finnhub" || parts.analyst?.source === "nasdaq" ? parts.analyst.source : "none";
  const transcriptSource = parts.transcripts?.[0]?.source || (parts.transcriptCount ? "AlphaStreet" : "none");
  const report = {
    ticker,
    macro: {
      fed_funds: finite(macro.fed_funds),
      fed_funds_as_of: macro.fed_funds_as_of || null,
      fed_target: macro.fed_target || null,
      cpi_yoy: finite(macro.cpi_yoy),
      cpi_as_of: macro.cpi_as_of || null,
      cpi_mom: finite(macro.cpi_mom),
      unemployment: finite(macro.unemployment),
      unemployment_as_of: macro.unemployment_as_of || null,
      ten_year: finite(macro.ten_year),
      ten_year_as_of: macro.ten_year_as_of || null,
      payroll_change: finite(macro.payroll_change),
    },
    finnhub: parts.finnhub || "no_key",
    analyst: analystSource,
    analyst_line: analystLine(parts.analyst),
    transcripts: {
      count: parts.transcriptCount ?? (parts.transcripts?.length || 0),
      source: transcriptSource === "none" ? "none" : transcriptSource,
      latest: parts.transcripts?.[0]?.title || null,
    },
    fundamentals: parts.fundamentals || "none",
    news: parts.news || "none",
    note: "",
  };
  const bits = [];
  if (report.finnhub === "unused") {
    bits.push("Finnhub is saved as a fallback and was not called. Its free plan has no price targets and no transcripts.");
  } else if (report.finnhub === "no_key") bits.push("Finnhub has no API key.");
  else if (report.finnhub === "ok") bits.push("Nasdaq had no analyst tape, so Finnhub filled ratings and insider prints. Price targets are not on the free Finnhub plan.");
  else if (report.finnhub === "rejected") bits.push("Finnhub rejected the key.");
  else bits.push(`Finnhub: ${report.finnhub}.`);
  if (report.analyst === "none") bits.push("No analyst tape.");
  else bits.push(`Analyst tape: ${report.analyst_line}.`);
  if (report.transcripts.count) bits.push(`Transcripts: ${report.transcripts.count} from ${report.transcripts.source}.`);
  else bits.push("No earnings transcript was retrieved.");
  if (report.news === "yahoo") bits.push("SearXNG at 192.168.86.35:8099 did not answer from this host, so the wires are Yahoo.");
  else if (report.news === "searxng") bits.push("Wires are from the homelab search box.");
  else bits.push("No wires.");
  bits.push(`Fundamentals: ${report.fundamentals}.`);
  if ([report.macro.fed_funds, report.macro.cpi_yoy, report.macro.unemployment, report.macro.ten_year].some((value) => value == null)) {
    bits.push("One or more macro prints did not load.");
  } else bits.push("Macro is public: NY Fed, BLS, and Treasury. FRED is not called while those four print.");
  report.note = bits.join(" ");
  return report;
}

function publicAnalyst(nasdaq) {
  const block = nasdaq?.analyst;
  if (!block) return null;
  if (block.targets?.mean == null && !block.consensus) return null;
  return block;
}

async function analystTape(ticker, nasdaq) {
  const ready = publicAnalyst(nasdaq);
  if (ready) {
    return {
      analyst: ready,
      hub: { status: FINNHUB_KEY ? "unused" : "no_key", ratings: null, targets: null, insider: null, earnings: null },
    };
  }
  const hub = await finnhubData(ticker);
  const analyst = hub.status === "ok"
    ? { source: "finnhub", ratings: hub.ratings, targets: hub.targets, insider: hub.insider, consensus: null }
    : { source: "none", ratings: null, targets: null, insider: null };
  return { analyst, hub };
}

async function sourceReport(ticker) {
  const symbol = normalizeYahooTicker(ticker);
  const [macro, nasdaq, calls, wires, yfinanceReady] = await Promise.all([
    readMacro(),
    nasdaqSnapshot(symbol),
    alphaStreetCalls(symbol, false),
    searxngNews(symbol),
    yfinanceInstalled(),
  ]);
  const { analyst, hub } = await analystTape(symbol, nasdaq);
  return reportFrom(symbol, {
    macro,
    finnhub: hub.status,
    analyst,
    transcripts: calls,
    transcriptCount: calls.length,
    fundamentals: yfinanceReady ? "yfinance, Nasdaq if a field is missing" : nasdaq ? "Nasdaq statements (yfinance is not installed)" : "none",
    news: wires.source,
  });
}

async function buildPacket(ticker) {
  const [yfRaw, macro, newsPack, nasdaq, transcripts, chart] = await Promise.all([
    yf(ticker).catch((error) => JSON.stringify({ error: error.message })),
    readMacro(),
    searxngNews(ticker),
    nasdaqSnapshot(ticker),
    earningsTranscripts(ticker),
    yahooChart(ticker),
  ]);
  let financials = {};
  let fundamentals = "none";
  try {
    financials = JSON.parse(yfRaw);
  } catch {
    financials = { error: "yfinance parse failed" };
  }
  const yfinanceOk = financials && !financials.error && (financials.currentPrice != null || financials.trailingPE != null || financials.marketCap != null);
  if (yfinanceOk) fundamentals = "yfinance";
  else financials = {};
  if (chart) fillMissing(financials, chart);
  if (!yfinanceOk && chart?.currentPrice != null) fundamentals = "yahoo chart";
  if (nasdaq) {
    fillMissing(financials, {
      currentPrice: nasdaq.price,
      marketCap: nasdaq.marketCap,
      sector: nasdaq.sector,
      industry: nasdaq.industry,
      grossMargins: nasdaq.grossMargins,
      profitMargins: nasdaq.profitMargins,
      returnOnEquity: nasdaq.returnOnEquity,
      totalRevenue: nasdaq.totalRevenue,
      operatingCashFlow: nasdaq.operatingCashFlow,
      capex: nasdaq.capex,
      freeCashflow: nasdaq.freeCashflow,
      trailingPE: nasdaq.trailingPE,
      forwardPE: nasdaq.forwardPE,
      priceToBook: nasdaq.priceToBook,
      enterpriseToEbitda: nasdaq.enterpriseToEbitda,
    });
    if (!yfinanceOk && (nasdaq.marketCap != null || nasdaq.profitMargins != null)) {
      fundamentals = chart?.currentPrice != null ? "yahoo chart + Nasdaq statements" : "Nasdaq statements";
    }
    if (nasdaq.listing_note) financials.listing_note = nasdaq.listing_note;
  }
  if (financials.freeCashflow && financials.marketCap) {
    financials.fcf_yield = financials.freeCashflow / financials.marketCap;
  }
  const { analyst, hub } = await analystTape(ticker, nasdaq);
  const targetMean = analyst.targets?.mean;
  if (financials.currentPrice && targetMean) {
    financials.avg_price_target = targetMean;
    financials.target_vs_price_pct = (targetMean / financials.currentPrice - 1) * 100;
    financials.targetMeanPrice = financials.targetMeanPrice ?? targetMean;
  }
  const earningsResults = nasdaq?.earnings?.length ? nasdaq.earnings : hub.earnings || [];
  const report = reportFrom(ticker, {
    macro,
    finnhub: hub.status,
    analyst,
    transcripts,
    fundamentals,
    news: newsPack.source,
  });
  return {
    ticker,
    as_of: new Date().toISOString(),
    financials,
    macro,
    news: newsPack.headlines,
    analyst,
    earnings_calls: transcripts,
    earnings_results: earningsResults,
    report,
  };
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
    fcfYield: fcf != null && marketCap ? fcf / marketCap : finite(f.fcf_yield),
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

// ---------- Debate ----------

function shrinkStrings(value, maxLen) {
  if (typeof value === "string") return value.length > maxLen ? value.slice(0, maxLen) : value;
  if (Array.isArray(value)) return value.map((item) => shrinkStrings(item, maxLen));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = shrinkStrings(item, maxLen);
    return out;
  }
  return value;
}

function packetText(packet) {
  let text = JSON.stringify(packet);
  let cap = 6000;
  while (text.length > 48000 && cap >= 500) {
    text = JSON.stringify(shrinkStrings(packet, cap));
    cap = Math.floor(cap / 2);
  }
  if (text.length > 48000) text = `${text.slice(0, 48000)}\n[truncated to fit the context window]`;
  return text;
}

async function runPool(tasks, limit = LLM_CONCURRENCY) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  }
  const workers = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function noteForJudge(seat) {
  if (!seat || seat.ok === false) return { ok: false, error: seat?.error || "no note" };
  const note = seat.note && typeof seat.note === "object" ? seat.note : {};
  const text = [note.argument, note.summary, note.thesis, note.fundamental_impact, note.verdict]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n\n");
  return { ok: true, note: text.slice(0, 6000) || "This seat did not write a note." };
}

async function debateOne(ticker) {
  const symbol = normalizeYahooTicker(ticker);
  const packet = await buildPacket(symbol);
  const { news: headlines, ...deskPacket } = packet;
  const newsPacket = {
    ticker: packet.ticker,
    as_of: packet.as_of,
    fundamentals: companySnapshot(packet.financials),
    news: (headlines || []).map((item) => ({
      title: item?.title || "",
      source: item?.source || "",
      published: item?.published || null,
    })),
  };
  // Agents run in parallel — they don't see each other.
  // Only the news seat gets the headlines.
  const [bull, bear, valuation, earnings, analyst, news] = await runPool([
    () => ask("bull", deskPacket),
    () => ask("bear", deskPacket),
    () => ask("valuation", deskPacket),
    () => ask("earnings", deskPacket),
    () => ask("analyst", deskPacket),
    () => ask("news", newsPacket),
  ]);
  const judge = await ask("judge", {
    ticker: symbol,
    packet_summary: {
      ticker: packet.ticker,
      financials: companySnapshot(packet.financials),
      macro: packet.macro,
      news_count: (headlines || []).length,
      earnings_calls_found: (packet.earnings_calls || []).length,
      earnings_results: (packet.earnings_results || []).slice(0, 4),
      has_finnhub: packet.analyst?.source === "finnhub",
      analyst_source: packet.analyst?.source || "none",
      feed_note: packet.report?.note || "",
    },
    agents: {
      bull: noteForJudge(bull),
      bear: noteForJudge(bear),
      valuation: noteForJudge(valuation),
      earnings: noteForJudge(earnings),
      analyst: noteForJudge(analyst),
      news: noteForJudge(news),
    },
  });
  return {
    ticker: symbol,
    as_of: packet.as_of,
    model: MODEL,
    company: companySnapshot(packet.financials),
    news: headlines,
    feeds: packet.report,
    agents: { bull, bear, valuation, earnings, analyst, news },
    judge,
  };
}

// ---------- Archive ----------

function archive(result) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify(result) + "\n";
  fs.appendFileSync(path.join(DATA_DIR, "debates.jsonl"), line);
}

export { debateOne, archive, sourceReport, buildPacket };

