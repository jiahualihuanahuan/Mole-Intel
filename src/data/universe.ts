export type UniverseRow = {
  ticker: string;
  name: string;
  sector: string;
  index: string;
};

export const universe: UniverseRow[] = [
  { ticker: "AAPL", name: "Apple", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "MSFT", name: "Microsoft", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "NVDA", name: "Nvidia", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "AMZN", name: "Amazon", sector: "Consumer", index: "Nasdaq 100" },
  { ticker: "GOOGL", name: "Alphabet", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "META", name: "Meta Platforms", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "TSLA", name: "Tesla", sector: "Consumer", index: "Nasdaq 100" },
  { ticker: "AVGO", name: "Broadcom", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "AMD", name: "Advanced Micro Devices", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "NFLX", name: "Netflix", sector: "Consumer", index: "Nasdaq 100" },
  { ticker: "COST", name: "Costco", sector: "Consumer", index: "Nasdaq 100" },
  { ticker: "JPM", name: "JPMorgan Chase", sector: "Financials", index: "S&P 500" },
  { ticker: "V", name: "Visa", sector: "Financials", index: "S&P 500" },
  { ticker: "UNH", name: "UnitedHealth", sector: "Health Care", index: "S&P 500" },
  { ticker: "LLY", name: "Eli Lilly", sector: "Health Care", index: "S&P 500" },
  { ticker: "XOM", name: "Exxon Mobil", sector: "Energy", index: "S&P 500" },
  { ticker: "JNJ", name: "Johnson & Johnson", sector: "Health Care", index: "S&P 500" },
  { ticker: "WMT", name: "Walmart", sector: "Consumer", index: "S&P 500" },
  { ticker: "MA", name: "Mastercard", sector: "Financials", index: "S&P 500" },
  { ticker: "PG", name: "Procter & Gamble", sector: "Consumer Staples", index: "S&P 500" },
  { ticker: "HD", name: "Home Depot", sector: "Consumer", index: "S&P 500" },
  { ticker: "BAC", name: "Bank of America", sector: "Financials", index: "S&P 500" },
  { ticker: "CRM", name: "Salesforce", sector: "Technology", index: "S&P 500" },
  { ticker: "ORCL", name: "Oracle", sector: "Technology", index: "S&P 500" },
  { ticker: "KO", name: "Coca-Cola", sector: "Consumer Staples", index: "S&P 500" },
  { ticker: "PEP", name: "PepsiCo", sector: "Consumer Staples", index: "Nasdaq 100" },
  { ticker: "DIS", name: "Walt Disney", sector: "Consumer", index: "S&P 500" },
  { ticker: "INTC", name: "Intel", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "QCOM", name: "Qualcomm", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "AMAT", name: "Applied Materials", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "CAT", name: "Caterpillar", sector: "Industrials", index: "S&P 500" },
  { ticker: "GE", name: "GE Aerospace", sector: "Industrials", index: "S&P 500" },
  { ticker: "BA", name: "Boeing", sector: "Industrials", index: "S&P 500" },
  { ticker: "SHOP", name: "Shopify", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "PLTR", name: "Palantir", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "ASML", name: "ASML", sector: "Technology", index: "Nasdaq 100" },
  { ticker: "TSM", name: "TSMC", sector: "Technology", index: "NYSE" },
  { ticker: "BABA", name: "Alibaba", sector: "Consumer", index: "NYSE" },
  { ticker: "SONY", name: "Sony", sector: "Consumer", index: "NYSE" },
  { ticker: "TM", name: "Toyota", sector: "Consumer", index: "NYSE" },
];

export function findCompany(ticker: string): UniverseRow | null {
  const key = ticker.trim().toUpperCase();
  return universe.find((row) => row.ticker === key) ?? null;
}
