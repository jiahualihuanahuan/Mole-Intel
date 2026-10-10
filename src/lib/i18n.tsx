import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "zh";

const copy = {
  en: {
    search: "Ticker or company",
    searchLabel: "Ticker or company",
    home: "Mole Intel, back to the desk",
    noMatch: "No company in the desk list.",
    openTicker: "Open this ticker",
    badTicker: "That is not a Yahoo Finance ticker. Try NVDA, BRK-B, SHOP.TO, SHEL.L, or 7203.T.",
    kicker: "The desk",
    headline: "Six seats. One reads the news. The judge reads the macro tape.",
    lede: "Search a company, or start from the largest names, the bullish calls, and whatever just hit the wires.",
    listsLoading: "Reading the lists…",
    listsError: "The lists did not come back.",
    largest: "Largest",
    largestHint: "Market cap",
    largestEmpty: "No market-cap print.",
    bullish: "Most bullish",
    bullishHint: "The judge, then fresh upgrades",
    bullishEmpty: "No bullish names yet.",
    breaking: "Breaking",
    breakingHint: "Named in today's wires",
    breakingEmpty: "No company in the latest wires.",
    sat: "Already sat",
    saved: "Saved on this browser",
    source: "Source",
    last: "Last",
    day: "Day",
    threeMonths: "3 months",
    wires: "Wires",
    headlines: "headlines",
    tapeLoading: "Reading the tape…",
    tapeError: "The tape did not load. The desk can still sit, but it will say the numbers are unknown.",
    sitting: "The desk is sitting…",
    again: "Run it again on the 3080",
    sit: "Sit the desk",
    archived: "Already in the archive",
    runsOnOpen: "A ticker with no note runs as soon as you open it.",
    sittingLong: "Reading the tape, the wires, and the filings. The news seat digests the headlines, then the judge. A first pass takes a few minutes.",
    company: "The company",
    marketCap: "Market cap",
    trailPe: "Trail P/E",
    fwdPe: "Fwd P/E",
    pb: "P/B",
    ev: "EV/EBITDA",
    roe: "ROE",
    fcf: "FCF yield",
    target: "Target",
    high52: "52w high",
    low52: "52w low",
    month: "1 month",
    industry: "Industry",
    theWires: "The wires",
    judge: "Judge",
    conviction: "Conviction",
    forCase: "For",
    against: "Against",
    stillOpen: "Still open",
    answered: "Answered by",
    seats: "The seats",
    news: "News",
    bull: "Bull",
    bear: "Bear",
    valuation: "Valuation",
    earnings: "Earnings",
    analyst: "Analyst ratings",
    newsHint: "What the headlines change in the fundamentals",
    noNews: "No news note in this pass. Run the desk again so this seat can read the wires.",
    noNote: "This seat did not write a note.",
    confidence: "Confidence",
    translating: "Translating this note…",
    translatingSection: "Translating",
    translateFailed: "The Chinese note did not come back. Showing the English.",
    callBullish: "Bullish",
    callBearish: "Bearish",
    callNeutral: "Neutral",
    callMixed: "Mixed",
    unread: "Unread",
  },
  zh: {
    search: "代码或公司",
    searchLabel: "代码或公司",
    home: "Mole Intel，回到桌面",
    noMatch: "名单里没有这家公司。",
    openTicker: "打开这只股票",
    badTicker: "这不是 Yahoo Finance 代码。试试 NVDA、BRK-B、SHOP.TO、SHEL.L 或 7203.T。",
    kicker: "研究桌",
    headline: "六个席位。一个读新闻。法官自己看宏观数据。",
    lede: "搜一家公司，或从市值最大、最看多、以及刚上头条的名字开始。",
    listsLoading: "正在读名单…",
    listsError: "名单没有回来。",
    largest: "市值最大",
    largestHint: "市值",
    largestEmpty: "没有市值数据。",
    bullish: "最看多",
    bullishHint: "先看法官，再看新上调",
    bullishEmpty: "还没有看多的名字。",
    breaking: "突发",
    breakingHint: "今天新闻点到的公司",
    breakingEmpty: "最新新闻里没有点名公司。",
    sat: "已经讨论过",
    saved: "存在这台浏览器上",
    source: "来源",
    last: "最新价",
    day: "当日",
    threeMonths: "三个月",
    wires: "新闻",
    headlines: "条",
    tapeLoading: "正在读行情…",
    tapeError: "行情没有载入。研究桌仍可开会，但会把数字标成未知。",
    sitting: "研究桌正在开会…",
    again: "在 3080 上再开一次",
    sit: "开会",
    archived: "已在存档中",
    runsOnOpen: "没有记录的股票，打开就会开始讨论。",
    sittingLong: "正在读行情、新闻和财报。新闻席先消化标题，然后是法官。第一次要几分钟。",
    company: "公司",
    marketCap: "市值",
    trailPe: "滚动市盈率",
    fwdPe: "预期市盈率",
    pb: "市净率",
    ev: "EV/EBITDA",
    roe: "净资产收益率",
    fcf: "自由现金流收益率",
    target: "目标价",
    high52: "52周高",
    low52: "52周低",
    month: "一个月",
    industry: "行业",
    theWires: "新闻",
    judge: "法官",
    conviction: "把握",
    forCase: "多方",
    against: "空方",
    stillOpen: "仍未一致",
    answered: "回答模型",
    seats: "席位",
    news: "新闻",
    bull: "多方",
    bear: "空方",
    valuation: "估值",
    earnings: "财报电话会",
    analyst: "分析师评级",
    newsHint: "这些新闻会怎样改变公司基本面",
    noNews: "这一轮没有新闻笔记。再开一次，让这个席位读新闻。",
    noNote: "这个席位没有写笔记。",
    confidence: "信心",
    translating: "正在翻译这篇笔记…",
    translatingSection: "正在翻译",
    translateFailed: "中文没有回来。仍显示英文。",
    callBullish: "看多",
    callBearish: "看空",
    callNeutral: "中性",
    callMixed: "分歧",
    unread: "未读",
  },
} as const;

export type CopyKey = keyof typeof copy.en;

const LangContext = createContext<{
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: CopyKey) => string;
}>({
  lang: "en",
  setLang: () => {},
  t: (key) => copy.en[key],
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    const saved = localStorage.getItem("mole-intel-lang");
    if (saved === "zh" || saved === "en") setLangState(saved);
  }, []);
  function setLang(next: Lang) {
    setLangState(next);
    localStorage.setItem("mole-intel-lang", next);
  }
  const t = (key: CopyKey) => copy[lang][key];
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}

export function useI18n() {
  return useContext(LangContext);
}

export function callName(call: string, lang: Lang): string {
  const key = call.toLowerCase();
  if (key === "bullish") return copy[lang].callBullish;
  if (key === "bearish") return copy[lang].callBearish;
  if (key === "neutral") return copy[lang].callNeutral;
  if (key === "mixed") return copy[lang].callMixed;
  if (!key) return copy[lang].unread;
  return call;
}
