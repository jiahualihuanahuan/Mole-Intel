export type Tape = {
  ticker: string;
  name: string;
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
  return3mPct: number | null;
  currency: string | null;
  headlines: string[];
  asOf: string;
  note: string;
};

export type SeatNote = {
  title: string;
  summary: string;
  argument: string;
  points: string[];
  verdict: string;
  confidence: number | null;
};

export type Disagreement = {
  topic: string;
  bull: string;
  bear: string;
};

export type JudgeNote = {
  call: "bullish" | "bearish" | "neutral" | "mixed";
  conviction: number | null;
  summary: string;
  bullPoints: string[];
  bearPoints: string[];
  disagreements: Disagreement[];
  openQuestions: string[];
};

export type DebateResult = {
  ticker: string;
  name: string;
  sector: string;
  indexName: string;
  asOf: string;
  model: string;
  source: "archive" | "desk";
  tape: Tape;
  seats: Record<string, SeatNote | null>;
  judge: JudgeNote | null;
  errors: string[];
};
