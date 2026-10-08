import assert from "node:assert/strict";
import test from "node:test";
import { normalizeYahooTicker, safeHttpUrl, tryNormalizeYahooTicker } from "../src/lib/yahoo-ticker.mjs";

test("keeps Yahoo symbols and share classes", () => {
  assert.equal(normalizeYahooTicker("aapl"), "AAPL");
  assert.equal(normalizeYahooTicker("$msft"), "MSFT");
  assert.equal(normalizeYahooTicker("BRK.B"), "BRK-B");
  assert.equal(normalizeYahooTicker("BRK/B"), "BRK-B");
  assert.equal(normalizeYahooTicker("BRK-B"), "BRK-B");
  assert.equal(normalizeYahooTicker("BRK B"), "BRK-B");
  assert.equal(normalizeYahooTicker("AAPL.O"), "AAPL");
  assert.equal(normalizeYahooTicker("AAPL.N"), "AAPL");
  assert.equal(normalizeYahooTicker("NYSE:BRK.B"), "BRK-B");
});

test("maps developed-market exchanges to Yahoo suffixes", () => {
  const cases = [
    ["TSX:SHOP", "SHOP.TO"],
    ["TSE:SHOP", "SHOP.TO"],
    ["SHOP CN", "SHOP.TO"],
    ["SHOP.TO", "SHOP.TO"],
    ["TECK.B.TO", "TECK-B.TO"],
    ["TECK/B.TO", "TECK-B.TO"],
    ["TSE:7203", "7203.T"],
    ["7203 JP", "7203.T"],
    ["7203.T", "7203.T"],
    ["9984 JT", "9984.T"],
    ["700.HK", "0700.HK"],
    ["HKG:5", "0005.HK"],
    ["0700.HK", "0700.HK"],
    ["LON:SHEL", "SHEL.L"],
    ["SHEL LN", "SHEL.L"],
    ["SHEL.L", "SHEL.L"],
    ["BP.L", "BP.L"],
    ["3IN.L", "3IN.L"],
    ["AMS:ASML", "ASML.AS"],
    ["ASML NA", "ASML.AS"],
    ["ASML.AS", "ASML.AS"],
    ["NESN SW", "NESN.SW"],
    ["NESN.SW", "NESN.SW"],
    ["SAP GY", "SAP.DE"],
    ["SAP.DE", "SAP.DE"],
    ["VOW3.DE", "VOW3.DE"],
    ["AIR FP", "AIR.PA"],
    ["AIR.PA", "AIR.PA"],
    ["MC.PA", "MC.PA"],
    ["ENI IM", "ENI.MI"],
    ["IBE SM", "IBE.MC"],
    ["ABI BB", "ABI.BR"],
    ["NOVO-B.CO", "NOVO-B.CO"],
    ["NOVO B DC", "NOVO-B.CO"],
    ["VOLV-B.ST", "VOLV-B.ST"],
    ["VOLV B SS", "VOLV-B.ST"],
    ["EQNR.OL", "EQNR.OL"],
    ["NOKIA FH", "NOKIA.HE"],
    ["BHP AT", "BHP.AX"],
    ["ASX:BHP", "BHP.AX"],
    ["BHP.AX", "BHP.AX"],
    ["FPH.NZ", "FPH.NZ"],
    ["D05 SP", "D05.SI"],
    ["D05.SI", "D05.SI"],
    ["TEVA IT", "TEVA.TA"],
    ["TEVA.TA", "TEVA.TA"],
    ["600519.SS", "600519.SS"],
    ["005930.KS", "005930.KS"],
    ["HTO.AT", "HTO.AT"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeYahooTicker(input), expected, input);
  }
});

test("rejects names and junk", () => {
  assert.equal(tryNormalizeYahooTicker(""), null);
  assert.equal(tryNormalizeYahooTicker("johnson & johnson"), null);
  assert.equal(tryNormalizeYahooTicker("hello there"), null);
});

test("only allows http(s) story links", () => {
  assert.equal(safeHttpUrl("https://www.reuters.com/world/a"), "https://www.reuters.com/world/a");
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("not a url"), null);
});
