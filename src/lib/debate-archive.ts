import type { CompanyInfo, DebateResult, Disagreement, FeedReport, Headline, JudgeNote, JudgeZh, SeatNote, SeatZh } from "@/lib/debate-types";
import { normalizeYahooTicker, safeHttpUrl } from "@/lib/yahoo-ticker.mjs";

export type ArchiveHit = {
  ticker: string;
  asOf: string;
  call: string;
};

const SEATS = ["bull", "bear", "valuation", "earnings", "analyst", "news"] as const;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalTicker(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    return normalizeYahooTicker(raw);
  } catch {
    return raw.toUpperCase();
  }
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function lines(value: unknown, limit: number): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const line = [str(row.title), str(row.topic), str(row.view) || str(row.quote) || str(row.text)]
        .filter(Boolean)
        .join(": ");
      if (line) out.push(line);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function pairs(value: unknown, limit: number): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: string[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw == null || raw === "") continue;
    const text = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    if (!text.trim() || text === "null") continue;
    out.push(`${key.replace(/_/g, " ")}: ${text}`);
    if (out.length >= limit) break;
  }
  return out;
}

function unwrap(agent: unknown): Record<string, unknown> | null {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return null;
  const row = agent as Record<string, unknown>;
  if (row.ok === false) return null;
  const note = row.note;
  if (note && typeof note === "object" && !Array.isArray(note)) return note as Record<string, unknown>;
  if (row.thesis || row.summary || row.call || row.most_recent) return row;
  return null;
}

function seatZh(note: Record<string, unknown>): SeatZh | undefined {
  const raw = note.zh;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const summary = str(row.summary) || str(row.thesis);
  const argument = [str(row.argument), str(row.fundamental_impact) || str(row.fundamentalImpact), str(row.impact)]
    .filter(Boolean)
    .join("\n");
  const points = lines(row.points, 8);
  const verdict = str(row.verdict);
  if (!summary && !argument && !points.length && !verdict) return undefined;
  return { summary, argument, points, verdict };
}

function seatFromNote(title: string, note: Record<string, unknown>): SeatNote {
  const recent = note.most_recent;
  const recentObj = recent && typeof recent === "object" ? (recent as Record<string, unknown>) : null;
  const impact = str(note.fundamental_impact) || str(note.fundamentalImpact) || str(note.impact);
  const summary =
    str(note.summary) ||
    str(note.thesis) ||
    str(recentObj?.guidance) ||
    str(note.consensus) ||
    str(note.note);
  const argument = [
    str(note.argument),
    impact,
    str(recentObj?.tone),
    str(note.trend_vs_prior),
    str(note.insider_signal),
  ]
    .filter(Boolean)
    .join("\n");
  const points = [
    ...lines(note.points ?? note.evidence, 6),
    ...lines(note.catalysts, 3),
    ...lines(note.risks, 4),
    ...lines(note.risks_flagged, 3),
    ...lines(recentObj?.key_quotes, 3),
    ...lines(recentObj?.qa_themes, 3),
    ...lines(note.recent_changes, 4),
    ...lines(note.headlines, 5),
    ...lines(note.what_changed, 3),
    ...pairs(note.metrics, 8),
    ...pairs(note.backdrop, 6),
  ].slice(0, 8);
  return {
    title,
    summary,
    argument,
    points,
    verdict: str(note.verdict),
    confidence: num(note.confidence),
    thinking: "",
    zh: seatZh(note),
  };
}

function judgeZh(note: Record<string, unknown>): JudgeZh | undefined {
  const raw = note.zh;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const summary = [str(row.summary), str(row.argument)].filter(Boolean).join("\n\n");
  const disagreements: Disagreement[] = [];
  if (Array.isArray(row.disagreements)) {
    for (const item of row.disagreements) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const topic = str(entry.topic);
      const bull = str(entry.bull_view ?? entry.bullView ?? entry.bull);
      const bear = str(entry.bear_view ?? entry.bearView ?? entry.bear);
      if (!topic && !bull && !bear) continue;
      disagreements.push({ topic: topic || "未决", bull, bear });
      if (disagreements.length >= 5) break;
    }
  }
  const zh = {
    summary,
    bullPoints: lines(row.bull_points ?? row.bullPoints, 5),
    bearPoints: lines(row.bear_points ?? row.bearPoints, 5),
    disagreements,
    openQuestions: lines(row.open_questions ?? row.openQuestions, 4),
  };
  if (!zh.summary && !zh.bullPoints.length && !zh.bearPoints.length && !zh.disagreements.length && !zh.openQuestions.length) return undefined;
  return zh;
}

function judgeFromNote(note: Record<string, unknown> | null): JudgeNote | null {
  if (!note) return null;
  const callRaw = str(note.call).toLowerCase();
  const prose = [str(note.summary), str(note.argument)].filter(Boolean).join("\n\n");
  const call: JudgeNote["call"] =
    callRaw === "bullish" || callRaw === "bearish" || callRaw === "neutral" || callRaw === "mixed"
      ? callRaw
      : inferCall(prose);
  const disagreements: Disagreement[] = [];
  if (Array.isArray(note.disagreements)) {
    for (const item of note.disagreements) {
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
    conviction: num(note.conviction),
    summary: prose,
    bullPoints: lines(note.bull_points ?? note.bullPoints, 5),
    bearPoints: lines(note.bear_points ?? note.bearPoints, 5),
    disagreements,
    openQuestions: lines(note.open_questions ?? note.openQuestions, 4),
    thinking: "",
    zh: judgeZh(note),
  };
}

function inferCall(text: string): JudgeNote["call"] {
  const labeled = text.match(/\bcall\s*[:\-]\s*(bullish|bearish|neutral|mixed)\b/i);
  const word = labeled?.[1] || [...text.matchAll(/\b(bullish|bearish|neutral|mixed)\b/gi)].at(-1)?.[1];
  const call = word?.toLowerCase();
  if (call === "bullish" || call === "bearish" || call === "neutral" || call === "mixed") return call;
  return "mixed";
}

function companyFrom(value: unknown): CompanyInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const info: CompanyInfo = {
    price: num(row.price ?? row.currentPrice ?? row.price_last),
    marketCap: num(row.marketCap),
    trailingPe: num(row.trailingPe ?? row.trailingPE),
    forwardPe: num(row.forwardPe ?? row.forwardPE),
    priceToBook: num(row.priceToBook),
    evEbitda: num(row.evEbitda ?? row.enterpriseToEbitda),
    roe: num(row.roe ?? row.returnOnEquity),
    fcfYield: num(row.fcfYield ?? row.fcf_yield),
    sector: str(row.sector),
    industry: str(row.industry),
    targetMean: num(row.targetMean ?? row.targetMeanPrice ?? row.avg_price_target),
    high52: num(row.high52 ?? row.fiftyTwoWeekHigh ?? row.hist_52w_high),
    low52: num(row.low52 ?? row.fiftyTwoWeekLow ?? row.hist_52w_low),
    dayPct: num(row.dayPct ?? row.price_change_pct_1d),
    return1mPct: num(row.return1mPct ?? row.return_1m_pct),
    return3mPct: num(row.return3mPct ?? row.return_3m_pct),
  };
  const anyNumber = Object.values(info).some((item) => typeof item === "number");
  if (!anyNumber && !info.sector && !info.industry) return null;
  return info;
}

function feedReportFrom(value: unknown): FeedReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as FeedReport;
  if (!row.macro || typeof row.macro !== "object" || typeof row.note !== "string") return null;
  return row;
}

function newsFrom(value: unknown): Headline[] {
  if (!Array.isArray(value)) return [];
  const out: Headline[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      out.push({ title: item.trim().slice(0, 300), source: "", published: null, url: null });
    } else if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const title = str(row.title);
      if (!title) continue;
      out.push({
        title: title.slice(0, 300),
        source: str(row.source).slice(0, 120),
        published: str(row.published) || null,
        url: safeHttpUrl(row.url) ?? safeHttpUrl(row.link),
      });
    }
    if (out.length >= 10) break;
  }
  return out;
}

export function hitFromRecord(record: unknown): ArchiveHit | null {
  if (!record || typeof record !== "object") return null;
  const row = record as Record<string, unknown>;
  const ticker = canonicalTicker(str(row.ticker));
  if (!ticker) return null;
  const agents = row.agents && typeof row.agents === "object" ? (row.agents as Record<string, unknown>) : {};
  const judge = judgeFromNote(unwrap(row.judge) ?? unwrap(agents.judge));
  return { ticker, asOf: str(row.as_of ?? row.asOf), call: judge?.call ?? "" };
}

export function debateFromRecord(record: unknown): DebateResult | null {
  const hit = hitFromRecord(record);
  if (!hit || !record || typeof record !== "object") return null;
  const row = record as Record<string, unknown>;
  const agents = row.agents && typeof row.agents === "object" ? (row.agents as Record<string, unknown>) : {};
  const seats: Record<string, SeatNote | null> = {};
  const errors: string[] = [];
  for (const key of SEATS) {
    const raw = agents[key];
    const note = unwrap(raw);
    if (!note) {
      seats[key] = null;
      if (raw && typeof raw === "object" && (raw as Record<string, unknown>).ok === false) {
        errors.push(`${key}: ${str((raw as Record<string, unknown>).error) || "did not write a note"}`);
      }
      continue;
    }
    seats[key] = seatFromNote(key, note);
  }
  const judge = judgeFromNote(unwrap(row.judge) ?? unwrap(agents.judge));
  const news = newsFrom(row.news);
  return {
    ticker: hit.ticker,
    name: hit.ticker,
    sector: "",
    indexName: "",
    asOf: hit.asOf,
    model: str(row.model) || "archive",
    source: "archive",
    tape: {
      ticker: hit.ticker,
      name: hit.ticker,
      price: null,
      previousClose: null,
      changePct: null,
      return3mPct: null,
      currency: null,
      headlines: news.map((item) => item.title),
      stories: news,
      asOf: hit.asOf,
      note: "",
    },
    company: companyFrom(row.company),
    news,
    feeds: feedReportFrom(row.feeds),
    seats,
    judge,
    errors,
  };
}
