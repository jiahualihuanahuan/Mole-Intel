export type MacroTape = {
  fed_funds: number | null;
  fed_funds_as_of: string | null;
  fed_target: string | null;
  cpi_yoy: number | null;
  cpi_as_of: string | null;
  cpi_mom: number | null;
  unemployment: number | null;
  unemployment_as_of: string | null;
  ten_year: number | null;
  ten_year_as_of: string | null;
  payroll_change: number | null;
};

export type FeedReport = {
  ticker: string;
  macro: MacroTape;
  finnhub: "ok" | "no_key" | "empty" | "rejected" | "error" | "unused";
  analyst: "finnhub" | "nasdaq" | "none";
  analyst_line: string;
  transcripts: { count: number; source: string; latest: string | null };
  fundamentals: string;
  news: string;
  note: string;
};

export type Tape = {
  ticker: string;
  name: string;
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
  return3mPct: number | null;
  currency: string | null;
  headlines: string[];
  stories?: Headline[];
  asOf: string;
  note: string;
};

export type Headline = {
  title: string;
  source: string;
  published: string | null;
  url?: string | null;
};

export type CompanyInfo = {
  price: number | null;
  marketCap: number | null;
  trailingPe: number | null;
  forwardPe: number | null;
  priceToBook: number | null;
  evEbitda: number | null;
  roe: number | null;
  fcfYield: number | null;
  sector: string;
  industry: string;
  targetMean: number | null;
  high52: number | null;
  low52: number | null;
  dayPct: number | null;
  return1mPct: number | null;
  return3mPct: number | null;
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
  company: CompanyInfo | null;
  news: Headline[];
  feeds?: FeedReport | null;
  seats: Record<string, SeatNote | null>;
  judge: JudgeNote | null;
  errors: string[];
};
