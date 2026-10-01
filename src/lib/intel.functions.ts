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
  url: string
}

export type CompanyBrief = {
  ticker: string
  name: string
  cik: string | null
  exchanges: string[]
  address: string
  entity: string
  filings: Filing[]
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
    if (items.length >= 4) break
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
    let exchanges: string[] = []
    let address = ""
    let entity = "Not an SEC registrant under this ticker"
    let canadian = false
    let latestAnnual: string | null = null

    if (cik) {
      const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      })
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
        const wanted = new Set(["10-K", "10-Q", "8-K", "20-F", "40-F", "6-K"])
        for (let i = 0; i < forms.length && filings.length < 8; i++) {
          if (!wanted.has(forms[i])) continue
          const acc = (accessions[i] ?? "").replace(/-/g, "")
          filings.push({
            form: forms[i],
            date: dates[i] ?? "",
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
      headlines,
      rubric,
    }
  })
