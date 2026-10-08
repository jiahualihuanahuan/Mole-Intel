import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNameIndex,
  composeBoards,
  decodeEntities,
  parseMarketCap,
  rowsFromBiggestHtml,
  rowsFromNewsXml,
  rowsFromUpgradesHtml,
  tickerFromHeadline,
} from "../src/lib/boards.mjs";

const amp = "&" + "amp;";

test("market caps accept the public print", () => {
  assert.equal(parseMarketCap("5.73T"), 5.73e12);
  assert.equal(parseMarketCap("876.09B"), 876.09e9);
  assert.equal(parseMarketCap("1,115,378,650"), 1115378650);
});

test("largest list keeps one share class", () => {
  const html = `
    <tr><td><div title="Berkshire Hathaway Inc."></div><div class="text-xs text-faded">BRK.A</div></td>
      <td class="text-right font-semibold text-default sm:px-4">1.08T</td></tr>
    <tr><td><div title="Berkshire Hathaway Inc."></div><div class="text-xs text-faded">BRK.B</div></td>
      <td class="text-right font-semibold text-default sm:px-4">1.07T</td></tr>
    <tr><td><div title="NVIDIA Corporation"></div><div class="text-xs text-faded">NVDA</div></td>
      <td class="text-right font-semibold text-default sm:px-4">5.73T</td></tr>
  `;
  const rows = rowsFromBiggestHtml(html);
  assert.deepEqual(rows.map((row) => row.ticker), ["BRK-A", "NVDA"]);
});

test("upgrades become a bullish list after the judge", () => {
  const html = `data-boxover-ticker="AFYA" data-boxover-company="Afya Ltd" data-boxover-ticker="AMD" data-boxover-company="Advanced Micro Devices"`;
  const upgrades = rowsFromUpgradesHtml(html);
  const boards = composeBoards({
    largest: [],
    upgrades,
    news: [],
    bullish: [{ ticker: "NVDA", name: "Nvidia", conviction: 0.8 }],
    index: buildNameIndex([{ ticker: "NVDA", name: "Nvidia" }]),
  });
  assert.equal(boards.bullish[0].ticker, "NVDA");
  assert.equal(boards.bullish[0].detail, "Desk · 80");
  assert.equal(boards.bullish[1].detail, "Upgraded");
});

test("breaking headlines name a company, not the word target", () => {
  const index = buildNameIndex([
    { ticker: "AMD", name: "Advanced Micro Devices" },
    { ticker: "TGT", name: "Target Corporation" },
    { ticker: "AAPL", name: "Apple" },
    { ticker: "CINF", name: "Cincinnati Financial" },
    { ticker: "GOOGL", name: "Alphabet Class A" },
  ]);
  assert.equal(tickerFromHeadline("Citi’s Price Target Boost Lifts AMD Shares", index), "AMD");
  assert.equal(tickerFromHeadline("RBC price target cut to $18", index), null);
  assert.equal(tickerFromHeadline("Intuitive Machines (NASDAQ:LUNR) drops", index), "LUNR");
  assert.equal(tickerFromHeadline("Apple shares fall with yields", index), "AAPL");
  assert.equal(tickerFromHeadline("Alphabet shares slip", index), "GOOGL");
  assert.equal(tickerFromHeadline("Integra cuts guidance after Cincinnati flooding", index), null);
  const xml = `<item><title>Apple shares fall with yields - Reuters</title><link>https://www.reuters.com/a</link><pubDate>Wed, 07 Oct 2026 23:14:17 GMT</pubDate></item>`;
  const rows = rowsFromNewsXml(xml, index, Date.parse("2026-10-08T00:00:00Z"));
  assert.equal(rows[0].ticker, "AAPL");
  assert.equal(rows[0].title, "Apple shares fall with yields");
  assert.equal(rows[0].source, "Reuters");
});

test("named entities in a company name decode", () => {
  assert.equal(decodeEntities(`JPMorgan Chase ${amp} Co.`), "JPMorgan Chase & Co.");
});
