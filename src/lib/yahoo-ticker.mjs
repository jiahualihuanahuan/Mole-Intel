/**
 * Turn a developed-market ticker into the symbol Yahoo Finance / yfinance accepts.
 *
 * Handles bare US symbols, share classes (BRK.B, BRK/B), Reuters venue suffixes
 * (.N / .O), and exchange prefixes or Bloomberg-style suffixes for developed
 * markets (TSX:SHOP, 7203 JP, SHEL LN, NESN SW, BHP AT). A symbol that is
 * already a Yahoo symbol is kept, including non-developed suffixes such as
 * .SS or .KS when the user typed the dotted form on purpose.
 */

/** @type {Record<string, string>} */
const EXCHANGE_ALIAS = {
  // United States — no Yahoo suffix
  US: "",
  UN: "",
  UW: "",
  UQ: "",
  UA: "",
  NYSE: "",
  NASDAQ: "",
  NAS: "",
  NMS: "",
  NYQ: "",
  NY: "",
  NQ: "",
  AMEX: "",
  ASE: "",
  // Canada
  TO: "TO",
  TSX: "TO",
  CN: "TO",
  CT: "TO",
  TOR: "TO",
  XTSE: "TO",
  V: "V",
  TSXV: "V",
  CVE: "V",
  CSE: "CN",
  NEO: "NE",
  NE: "NE",
  // United Kingdom
  L: "L",
  LN: "L",
  LON: "L",
  LSE: "L",
  UK: "L",
  GB: "L",
  XLON: "L",
  IL: "IL",
  // Germany
  DE: "DE",
  GY: "DE",
  GR: "DE",
  XETRA: "DE",
  XETR: "DE",
  ETR: "DE",
  GER: "DE",
  F: "F",
  GF: "F",
  FF: "F",
  FRA: "F",
  // France, Amsterdam, Brussels, Madrid, Milan
  PA: "PA",
  FP: "PA",
  PAR: "PA",
  EPA: "PA",
  XPAR: "PA",
  AS: "AS",
  NA: "AS",
  AMS: "AS",
  XAMS: "AS",
  BR: "BR",
  BB: "BR",
  BRU: "BR",
  EBR: "BR",
  MC: "MC",
  SM: "MC",
  MAD: "MC",
  BME: "MC",
  MI: "MI",
  IM: "MI",
  MIL: "MI",
  BIT: "MI",
  // Switzerland and Nordics
  SW: "SW",
  VX: "SW",
  SE: "SW",
  SIX: "SW",
  SWX: "SW",
  ST: "ST",
  SS: "ST",
  STO: "ST",
  OL: "OL",
  NO: "OL",
  OSL: "OL",
  CO: "CO",
  DC: "CO",
  CPH: "CO",
  HE: "HE",
  FH: "HE",
  HEL: "HE",
  // Austria, Portugal, Ireland
  VI: "VI",
  AV: "VI",
  VIE: "VI",
  LS: "LS",
  PL: "LS",
  LIS: "LS",
  IR: "IR",
  ID: "IR",
  DUB: "IR",
  ISE: "IR",
  // Australia, New Zealand
  AX: "AX",
  AU: "AX",
  AT: "AX",
  ASX: "AX",
  NZ: "NZ",
  NZE: "NZ",
  // Hong Kong, Japan, Singapore, Israel
  HK: "HK",
  HKG: "HK",
  HKEX: "HK",
  JP: "T",
  JT: "T",
  TYO: "T",
  XTKS: "T",
  SI: "SI",
  SP: "SI",
  SGX: "SI",
  SES: "SI",
  TA: "TA",
  IT: "TA",
  TLV: "TA",
  TASE: "TA",
};

/** Dotted suffixes Yahoo already understands. AT is Athens; Australia aliases map to AX. */
const YAHOO_SUFFIXES = new Set([
  "TO",
  "V",
  "CN",
  "NE",
  "L",
  "IL",
  "DE",
  "F",
  "SG",
  "MU",
  "BE",
  "HM",
  "DU",
  "HA",
  "PA",
  "AS",
  "BR",
  "MC",
  "MI",
  "SW",
  "ST",
  "OL",
  "CO",
  "HE",
  "VI",
  "LS",
  "IR",
  "AX",
  "HK",
  "TA",
  "T",
  "NZ",
  "SI",
  "SS",
  "SZ",
  "KS",
  "KQ",
  "TW",
  "TWO",
  "BO",
  "NS",
  "SA",
  "MX",
  "BA",
  "JK",
  "BK",
  "KL",
  "JO",
  "SR",
  "QA",
  "WA",
  "PR",
  "AT",
  "IC",
]);

const SYMBOL = /^[A-Z0-9](?:[A-Z0-9-]{0,14})?(?:\.[A-Z]{1,3})?$/;

/**
 * @param {string} code
 * @param {string} base
 * @returns {string | null} Yahoo suffix, "" for a US listing, or null if `code` is not an exchange here.
 */
function resolveAlias(code, base) {
  const stem = base.split(/[./-]/)[0] ?? "";
  const numeric = /^\d{1,5}$/.test(stem);
  if (code === "T") return numeric ? "T" : null;
  if (code === "TSE") return numeric ? "T" : "TO";
  if (!Object.prototype.hasOwnProperty.call(EXCHANGE_ALIAS, code)) return null;
  return EXCHANGE_ALIAS[code] ?? null;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function clean(raw) {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/_/g, "-")
    .replace(/\s*([./:-])\s*/g, "$1")
    .replace(/^\$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function padCode(base, suffix) {
  if ((suffix === "HK" || suffix === "T") && /^\d+$/.test(base) && base.length > 0 && base.length < 4) {
    return base.padStart(4, "0");
  }
  return base;
}

/**
 * @param {string} base
 * @param {string} suffix Yahoo suffix, or "" for a US listing.
 * @returns {string}
 */
function withSuffix(base, suffix) {
  let cleaned = base.toUpperCase().replace(/([A-Z0-9])\/([A-Z])(?=\.|$)/g, "$1-$2");
  if (!suffix) {
    if (/^[A-Z]{1,5}\.(N|O)$/.test(cleaned)) return cleaned.replace(/\.(N|O)$/, "");
    return cleaned.replace(/\.([A-Z])$/, "-$1");
  }
  if (cleaned.endsWith(`.${suffix}`)) return padSymbol(cleaned);
  cleaned = cleaned.replace(/\.([A-Z])$/, "-$1");
  return `${padCode(cleaned, suffix)}.${suffix}`;
}

/**
 * @param {string} symbol
 * @returns {string}
 */
function padSymbol(symbol) {
  const match = symbol.match(/^(\d+)\.([A-Z]{1,3})$/);
  if (!match) return symbol;
  return `${padCode(match[1] ?? "", match[2] ?? "")}.${match[2] ?? ""}`;
}

/**
 * @param {string} symbol
 * @returns {string}
 */
function canonicalize(symbol) {
  let s = symbol.replace(/([A-Z0-9])\/([A-Z])(?=\.|$)/g, "$1-$2");
  const parts = s.split(".");
  if (parts.length === 3 && /^[A-Z]$/.test(parts[1] ?? "") && YAHOO_SUFFIXES.has(parts[2] ?? "")) {
    s = `${parts[0]}-${parts[1]}.${parts[2]}`;
  } else if (parts.length === 2 && (parts[1] === "PK" || parts[1] === "OB")) {
    s = parts[0] ?? s;
  } else if (parts.length === 2 && (parts[1] ?? "").length === 1 && !YAHOO_SUFFIXES.has(parts[1] ?? "")) {
    if ((parts[1] === "N" || parts[1] === "O") && /^[A-Z]{1,5}$/.test(parts[0] ?? "")) s = parts[0] ?? s;
    else s = `${parts[0]}-${parts[1]}`;
  }
  return padSymbol(s);
}

/**
 * @param {string} symbol
 * @returns {boolean}
 */
function isYahooSymbol(symbol) {
  if (!SYMBOL.test(symbol)) return false;
  if (symbol.includes("--") || symbol.endsWith("-") || symbol.startsWith("-")) return false;
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return true;
  return YAHOO_SUFFIXES.has(symbol.slice(dot + 1));
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeYahooTicker(raw) {
  const cleaned = clean(raw);
  if (!cleaned) throw new Error("Enter a ticker, like NVDA, BRK-B, SHOP.TO, or 7203.T.");

  let parsed = cleaned;
  const three = cleaned.match(/^([A-Z0-9][A-Z0-9-]*)\s+([A-Z])\s+([A-Z]{1,6})$/);
  if (three) {
    const suffix = resolveAlias(three[3] ?? "", three[1] ?? "");
    if (suffix !== null) parsed = withSuffix(`${three[1]}-${three[2]}`, suffix);
  }
  if (parsed === cleaned) {
    const two = cleaned.match(/^([A-Z0-9][A-Z0-9./-]*)\s+([A-Z]{1,6})$/);
    if (two) {
      const suffix = resolveAlias(two[2] ?? "", two[1] ?? "");
      if (suffix !== null) parsed = withSuffix(two[1] ?? "", suffix);
    }
  }
  if (parsed === cleaned) {
    const pref = cleaned.match(/^([A-Z]{1,6}):([A-Z0-9][A-Z0-9./-]*)$/);
    if (pref) {
      const suffix = resolveAlias(pref[1] ?? "", pref[2] ?? "");
      if (suffix !== null) parsed = withSuffix(pref[2] ?? "", suffix);
    }
  }
  if (parsed === cleaned) {
    const classSpace = cleaned.match(/^([A-Z][A-Z0-9]{0,10})\s+([A-Z])$/);
    if (classSpace && resolveAlias(classSpace[2] ?? "", classSpace[1] ?? "") === null) {
      parsed = `${classSpace[1]}-${classSpace[2]}`;
    }
  }
  if (parsed.includes(" ") || parsed.includes(":")) {
    throw new Error("Enter a ticker, like NVDA, BRK-B, SHOP.TO, SHEL.L, or 7203.T.");
  }

  const symbol = canonicalize(parsed);
  if (!isYahooSymbol(symbol)) {
    throw new Error("Enter a ticker, like NVDA, BRK-B, SHOP.TO, SHEL.L, or 7203.T.");
  }
  return symbol;
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function tryNormalizeYahooTicker(raw) {
  try {
    return normalizeYahooTicker(raw);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeHttpUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 2000) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function linkHost(value) {
  const safe = safeHttpUrl(value);
  if (!safe) return "";
  return new URL(safe).hostname.replace(/^www\./, "");
}
