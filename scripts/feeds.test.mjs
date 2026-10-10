import test from "node:test";
import assert from "node:assert/strict";
import { finalNote } from "../src/lib/final-note.mjs";
import { splitChunks } from "../src/lib/translate.mjs";
import {
  cpiYoyFromBls,
  effrFromNyFed,
  fiscalRank,
  parseBlsLatest,
  parseNasdaqAmount,
  tenYearFromTreasuryCsv,
  transcriptLinksFromHtml,
  multiplesFromFigures,
} from "../src/lib/debate-job.mjs";

test("a long note is translated in short pieces", () => {
  const chunks = splitChunks(`${"A".repeat(800)}. ${"B".repeat(800)}`, 1000);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].length <= 1000);
  assert.ok(chunks[1].startsWith("B"));
});

test("displayed notes drop the thinking process", () => {
  const note = finalNote("<think>scratch this</think>\n**Thinking Process:**\nThe multiple might be high.\n\n**Final answer:**\nThe shares look expensive at 50 times earnings.");
  assert.equal(note.includes("scratch"), false);
  assert.equal(note.includes("Thinking"), false);
  assert.equal(note.includes("**"), false);
  assert.match(note, /expensive at 50 times earnings/);
});

test("valuation multiples come from the published P/E and the statements", () => {
  const multiples = multiplesFromFigures({
    marketCap: 5_525_648_000_000,
    price: 229.28,
    netIncome: 120_067_000_000,
    equity: 157_293_000_000,
    ebit: 141_709_000_000,
    depreciation: 2_843_000_000,
    cash: 10_605_000_000,
    shortDebt: 999_000_000,
    longDebt: 7_469_000_000,
    actualPe: 50.43,
    forwardPe: 24.92,
    forwardEps: 9.25,
  });
  assert.equal(multiples.trailingPE, 50.43);
  assert.equal(multiples.forwardPE, 24.92);
  assert.ok(multiples.priceToBook > 30 && multiples.priceToBook < 40);
  assert.ok(multiples.enterpriseToEbitda > 30 && multiples.enterpriseToEbitda < 45);
});

test("BLS latest numbers parse the headline feed", () => {
  const parsed = parseBlsLatest(
    "Unemployment Rate: 4.2% in Sep 2026 Consumer Price Index (CPI): +0.4% in Aug 2026 Payroll Employment: +29,000(p) in Sep 2026",
  );
  assert.equal(parsed.unemployment, 4.2);
  assert.equal(parsed.unemployment_as_of, "2026-09");
  assert.equal(parsed.cpi_mom, 0.4);
  assert.equal(parsed.cpi_mom_as_of, "2026-08");
  assert.equal(parsed.payroll_change, 29000);
});

test("CPI-U year over year uses the same month a year earlier and skips the annual average", () => {
  const parsed = cpiYoyFromBls("CUUR0000SA0 2025 M08 323.976\nCUUR0000SA0 2026 M08 334.980\nCUUR0000SA0 2026 M13 100\n");
  assert.equal(parsed.cpi_yoy, 3.4);
  assert.equal(parsed.cpi_as_of, "2026-08");
});

test("Treasury csv takes the newest 10-year yield", () => {
  const parsed = tenYearFromTreasuryCsv('Date,"1 Mo","10 Yr"\n10/07/2026,4.07,5.28\n10/06/2026,4.06,5.27\n');
  assert.equal(parsed.ten_year, 5.28);
  assert.equal(parsed.ten_year_as_of, "2026-10-07");
});

test("NY Fed effective fed funds includes the target range", () => {
  const parsed = effrFromNyFed({
    refRates: [{ type: "EFFR", percentRate: 3.88, effectiveDate: "2026-10-06", targetRateFrom: 3.75, targetRateTo: 4 }],
  });
  assert.equal(parsed.fed_funds, 3.88);
  assert.equal(parsed.fed_target, "3.75-4.00");
});

test("Nasdaq amounts keep sign and drop currency marks", () => {
  assert.equal(parseNasdaqAmount("-$6,042,000"), -6042000);
  assert.equal(parseNasdaqAmount("(5,755)"), -5755);
  assert.equal(parseNasdaqAmount("N/A"), null);
});

test("transcript index prefers the latest fiscal quarter", () => {
  const html =
    '<a href="https://news.alphastreet.com/old/">NVIDIA Corporation (NVDA) Q1 2026 Earnings Call Transcript</a>' +
    '<a href="https://news.alphastreet.com/new/">NVIDIA Corporation (NVDA) Q2 2027 Earnings Call Transcript</a>';
  const links = transcriptLinksFromHtml(html);
  assert.equal(links[0].url, "https://news.alphastreet.com/new/");
  assert.ok(fiscalRank("Q2 2027") > fiscalRank("Q4 2026"));
});
