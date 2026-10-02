import { createServerFn } from "@tanstack/react-start"

export type Headline = {
  title: string
  link: string
  published: string
  source: string
  sourceUrl: string
  kind: "ir" | "news"
}

export type Filing = {
  form: string
  date: string
  reportDate: string
  items: string
  url: string
}

export type FactLine = {
  label: string
  unit: string
  points: string[]
}

export type CompanyBrief = {
  ticker: string
  name: string
  cik: string | null
  exchanges: string[]
  address: string
  entity: string
  filings: Filing[]
  facts: FactLine[]
  headlines: Headline[]
  rubric: { question: string; note: string }[]
}

const UA = "MoleIntel research@marketdesk.app"
const newsCache = new Map<string, { at: number; headlines: Headline[] }>()
const NEWS_TTL = 15 * 60 * 1000

let tickerMap: Map<string, string> | null = null
let tickerLoaded = 0

function decode(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function classify(title: string, source: string, sourceUrl: string): "ir" | "news" {
  const blob = `${title} ${source} ${sourceUrl}`.toLowerCase()
  if (
    /investor|newsroom|press release|business wire|businesswire|pr newswire|globenewswire|sec\.gov|earnings|guidance/.test(
      blob,
    )
  ) {
    return "ir"
  }
  return "news"
}

function parseRss(xml: string): Headline[] {
  const items: Headline[] = []
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1]
    const title = decode(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "")
    const link = decode(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "")
    const published = decode(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "")
    const source = decode(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "")
    const sourceUrl = decode(block.match(/<source[^>]*url="([^"]+)"/)?.[1] ?? "")
    if (!title) continue
    items.push({
      title: title.replace(/\s+-\s+[^-]+$/, "").trim() || title,
      link,
      published,
      source,
      sourceUrl,
      kind: classify(title, source, sourceUrl),
    })
    if (items.length >= 6) break
  }
  return items
}

async function rss(query: string): Promise<Headline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" },
    })
    if (!response.ok) return []
    return parseRss(await response.text())
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function headlinesFor(ticker: string, name: string): Promise<Headline[]> {
  const key = ticker.toUpperCase()
  const cached = newsCache.get(key)
  if (cached && Date.now() - cached.at < NEWS_TTL) return cached.headlines
  const irQuery = `"${name}" (investor relations OR "press release" OR earnings OR newsroom)`
  let headlines = await rss(irQuery)
  if (headlines.length === 0) {
    headlines = await rss(`${ticker} stock`)
  }
  const irFirst = [...headlines].sort((a, b) => Number(b.kind === "ir") - Number(a.kind === "ir"))
  newsCache.set(key, { at: Date.now(), headlines: irFirst })
  return irFirst
}

async function loadTickers() {
  if (tickerMap && Date.now() - tickerLoaded < 12 * 60 * 60 * 1000) return tickerMap
  const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": UA, Accept: "application/json" },
  })
  if (!response.ok) throw new Error("EDGAR ticker list unavailable")
  const payload = (await response.json()) as Record<string, { cik_str: number; ticker: string }>
  const map = new Map<string, string>()
  for (const row of Object.values(payload)) {
    map.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, "0"))
  }
  tickerMap = map
  tickerLoaded = Date.now()
  return map
}

function addressOf(block: Record<string, string> | undefined) {
  if (!block) return ""
  return [block.street1, block.city, block.foreignStateTerritory || block.stateOrCountry, block.country]
    .filter(Boolean)
    .join(", ")
}

const EIGHT_K: Record<string, string> = {
  "1.01": "material agreement",
  "1.02": "agreement ended",
  "1.05": "cybersecurity incident",
  "2.01": "acquisition or sale",
  "2.02": "results",
  "2.03": "new debt",
  "2.04": "default or acceleration",
  "2.05": "exit costs",
  "2.06": "impairment",
  "3.01": "delisting notice",
  "4.02": "non-reliance on financials",
  "5.02": "officer or director change",
  "5.03": "charter or bylaw change",
  "5.07": "shareholder vote",
  "7.01": "Reg FD",
  "8.01": "other event",
}

function itemLabel(raw: string) {
  const labels = raw
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code && code !== "9.01")
    .map((code) => EIGHT_K[code] || code)
  return labels.slice(0, 4).join(", ")
}

type XbrlPoint = { end?: string; val?: number; form?: string; filed?: string; fp?: string; frame?: string; fy?: number }

const METRICS: { label: string; concepts: string[]; scale: "m" | "ps" }[] = [
  {
    label: "Revenue",
    concepts: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ],
    scale: "m",
  },
  { label: "Operating income", concepts: ["OperatingIncomeLoss"], scale: "m" },
  { label: "Net income", concepts: ["NetIncomeLoss"], scale: "m" },
  { label: "Diluted EPS", concepts: ["EarningsPerShareDiluted"], scale: "ps" },
  { label: "Operating cash flow", concepts: ["NetCashProvidedByUsedInOperatingActivities"], scale: "m" },
  {
    label: "Capex",
    concepts: ["PaymentsToAcquireProductiveAssets", "PaymentsToAcquirePropertyPlantAndEquipment"],
    scale: "m",
  },
]

function framed(units: XbrlPoint[], annual: boolean) {
  const frameRe = annual ? /^CY\d{4}$/ : /^CY\d{4}Q[1-4]$/
  const forms = annual ? /10-K|20-F|40-F|DEF 14A/ : /10-Q|6-K/
  const chosen = new Map<string, XbrlPoint>()
  const rank = (form?: string) => (form === "10-K" || form === "20-F" || form === "40-F" ? 2 : 1)
  for (const point of units) {
    if (!point.frame || !frameRe.test(point.frame) || !forms.test(point.form || "")) continue
    const prev = chosen.get(point.frame)
    if (
      !prev ||
      rank(point.form) > rank(prev.form) ||
      (rank(point.form) === rank(prev.form) && (point.filed || "") > (prev.filed || ""))
    ) {
      chosen.set(point.frame, point)
    }
  }
  return [...chosen.values()].sort((a, b) => (b.end || "").localeCompare(a.end || "")).slice(0, 3)
}

function periodLabel(point: XbrlPoint) {
  const quarter = point.frame?.match(/^CY(\d{4})Q([1-4])$/)
  if (quarter) return `${quarter[1]} Q${quarter[2]}`
  return `FY${point.fy || point.frame?.slice(2) || ""}`
}

function formatPoint(point: XbrlPoint, scale: "m" | "ps") {
  const value = point.val ?? 0
  const shown = scale === "ps" ? value.toFixed(2) : Math.round(value / 1e6).toLocaleString("en-US")
  const source = point.form === "DEF 14A" ? "annual" : point.form
  return `${periodLabel(point)} ${shown} (${source} filed ${point.filed})`
}

type CompanyFacts = {
  facts?: { "us-gaap"?: Record<string, { units?: Record<string, XbrlPoint[]> }> }
}

function factLines(payload: CompanyFacts): FactLine[] {
  const gaap = payload.facts?.["us-gaap"] ?? {}
  const lines: FactLine[] = []
  for (const metric of METRICS) {
    let bestUnits: XbrlPoint[] | null = null
    let bestEnd = ""
    let unit = metric.scale === "ps" ? "USD per share" : "USD millions"
    for (const concept of metric.concepts) {
      const units = gaap[concept]?.units
      if (!units) continue
      const key = metric.scale === "ps" ? "USD/shares" : "USD"
      const series = units[key] ?? units[Object.keys(units)[0]] ?? []
      const latest = framed(series, true)[0] || framed(series, false)[0]
      if (latest?.end && latest.end > bestEnd) {
        bestUnits = series
        bestEnd = latest.end
        if (metric.scale === "ps") unit = "USD per share"
      }
    }
    if (!bestUnits) continue
    const points = [...framed(bestUnits, true), ...framed(bestUnits, false)].map((point) => formatPoint(point, metric.scale))
    if (points.length) lines.push({ label: metric.label, unit, points })
  }
  return lines
}

export const getNewsBatch = createServerFn({ method: "POST" })
  .validator((data: { items: { ticker: string; name: string }[] }) => {
    const items = Array.isArray(data?.items) ? data.items.slice(0, 6) : []
    return {
      items: items.map((item) => ({
        ticker: String(item.ticker ?? "")
          .toUpperCase()
          .replace(/[^A-Z0-9.-]/g, "")
          .slice(0, 8),
        name: String(item.name ?? "").slice(0, 140),
      })),
    }
  })
  .handler(async ({ data }) => {
    const results = await Promise.all(
      data.items
        .filter((item) => item.ticker)
        .map(async (item) => {
          try {
            return { ticker: item.ticker, headlines: await headlinesFor(item.ticker, item.name) }
          } catch (error) {
            return {
              ticker: item.ticker,
              headlines: [] as Headline[],
              error: error instanceof Error ? error.message : "News check failed",
            }
          }
        }),
    )
    return { results }
  })

export const getCompanyBrief = createServerFn({ method: "POST" })
  .validator((data: { ticker: string; name: string }) => ({
    ticker: String(data?.ticker ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9.-]/g, "")
      .slice(0, 8),
    name: String(data?.name ?? "").slice(0, 140),
  }))
  .handler(async ({ data }): Promise<CompanyBrief> => {
    const headlines = await headlinesFor(data.ticker, data.name).catch(() => [] as Headline[])
    const map = await loadTickers().catch(() => new Map<string, string>())
    const cik = map.get(data.ticker) ?? null
    let filings: Filing[] = []
    let facts: FactLine[] = []
    let exchanges: string[] = []
    let address = ""
    let entity = "Not an SEC registrant under this ticker"
    let canadian = false
    let latestAnnual: string | null = null

    if (cik) {
      const [response, factsResponse] = await Promise.all([
        fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
        }),
        fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
        }),
      ])
      if (factsResponse.ok) {
        try {
          facts = factLines(await factsResponse.json())
        } catch {
          facts = []
        }
      }
      if (response.ok) {
        const sub = (await response.json()) as {
          name?: string
          tickers?: string[]
          exchanges?: string[]
          addresses?: { business?: Record<string, string> }
          filings?: {
            recent?: {
              form?: string[]
              filingDate?: string[]
              accessionNumber?: string[]
              primaryDocument?: string[]
              reportDate?: string[]
              items?: string[]
            }
          }
        }
        exchanges = sub.exchanges ?? []
        address = addressOf(sub.addresses?.business)
        canadian = /canada/i.test(address)
        const recent = sub.filings?.recent
        const forms = recent?.form ?? []
        const dates = recent?.filingDate ?? []
        const accessions = recent?.accessionNumber ?? []
        const docs = recent?.primaryDocument ?? []
        const reports = recent?.reportDate ?? []
        const itemCodes = recent?.items ?? []
        const wanted = new Set(["10-K", "10-Q", "8-K", "20-F", "40-F", "6-K"])
        for (let i = 0; i < forms.length && filings.length < 8; i++) {
          if (!wanted.has(forms[i])) continue
          const acc = (accessions[i] ?? "").replace(/-/g, "")
          filings.push({
            form: forms[i],
            date: dates[i] ?? "",
            reportDate: reports[i] ?? "",
            items: forms[i] === "8-K" ? itemLabel(itemCodes[i] ?? "") : "",
            url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${docs[i] ?? ""}`,
          })
          if (!latestAnnual && (forms[i] === "10-K" || forms[i] === "20-F" || forms[i] === "40-F")) {
            latestAnnual = `${forms[i]} filed ${dates[i]}`
          }
        }
        entity = canadian ? "Canada-linked SEC filer — SEDAR+ still required" : "US-listed SEC registrant"
      }
    }

    const newest = headlines[0]
    const rubric = [
      {
        question: "Timeliness",
        note: newest
          ? `Latest wire: ${newest.published || "undated"} from ${newest.source || "unknown outlet"}.`
          : "No recent IR or news item came back for this name.",
      },
      {
        question: "Expertise",
        note: newest?.kind === "ir"
          ? "Top item looks like an investor wire, press release, or earnings note. Still confirm it is the issuer, not a commentator."
          : "Top item is general news. Prefer the company IR page or an 8-K when the claim is about results.",
      },
      {
        question: "Bias",
        note: "Company IR copy is advocacy under a filing obligation. News mixes reporting and rewritten releases. Name the outlet.",
      },
      {
        question: "Conflicts",
        note: latestAnnual
          ? `Latest annual on EDGAR: ${latestAnnual}. If the headline's numbers disagree, the filing wins.`
          : "No annual report in the recent EDGAR window, so a headline figure is unchecked.",
      },
      {
        question: "References and methodology",
        note: "A headline is not a source of figures. Cite the form, date, and the IR release only for what the company said.",
      },
    ]

    return {
      ticker: data.ticker,
      name: data.name,
      cik,
      exchanges,
      address,
      entity,
      filings,
      facts,
      headlines,
      rubric,
    }
  })
