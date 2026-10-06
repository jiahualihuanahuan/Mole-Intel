import type { DebateResult, Disagreement, JudgeNote, SeatNote } from "@/lib/debate-types";

export type ArchiveHit = {
  ticker: string;
  asOf: string;
  call: string;
};

const SEATS = ["bull", "bear", "valuation", "macro", "earnings", "analyst"] as const;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
      const line = [str(row.topic), str(row.view) || str(row.quote) || str(row.text)].filter(Boolean).join(": ");
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

function seatFromNote(title: string, note: Record<string, unknown>): SeatNote {
  const recent = note.most_recent;
  const recentObj = recent && typeof recent === "object" ? (recent as Record<string, unknown>) : null;
  const summary =
    str(note.summary) ||
    str(note.thesis) ||
    str(recentObj?.guidance) ||
    str(note.consensus) ||
    str(note.note);
  const argument = [str(note.argument), str(recentObj?.tone), str(note.trend_vs_prior), str(note.insider_signal)]
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
  };
}

function judgeFromNote(note: Record<string, unknown> | null): JudgeNote | null {
  if (!note) return null;
  const callRaw = str(note.call).toLowerCase();
  const call: JudgeNote["call"] =
    callRaw === "bullish" || callRaw === "bearish" || callRaw === "neutral" || callRaw === "mixed"
      ? callRaw
      : "mixed";
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
    summary: str(note.summary),
    bullPoints: lines(note.bull_points ?? note.bullPoints, 5),
    bearPoints: lines(note.bear_points ?? note.bearPoints, 5),
    disagreements,
    openQuestions: lines(note.open_questions ?? note.openQuestions, 4),
  };
}

export function hitFromRecord(record: unknown): ArchiveHit | null {
  if (!record || typeof record !== "object") return null;
  const row = record as Record<string, unknown>;
  const ticker = str(row.ticker).toUpperCase();
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
      headlines: [],
      asOf: hit.asOf,
      note: "",
    },
    seats,
    judge,
    errors,
  };
}
