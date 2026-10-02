import { createServerFn } from "@tanstack/react-start"
import { universe } from "@/data/universe"
import {
  archiveCounts,
  filingBackfillDone,
  latestNote,
  markFilingBackfill,
  markNewsBackfill,
  newsBackfillDone,
  recentFilings,
  recentHeadlines,
  saveFilings,
  saveHeadlines,
  type StoredNote,
} from "@/lib/store"

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

export type CompanyPage = { label: string; url: string; text: string }
export type CompanyLink = { label: string; url: string }

export type JobPosting = { title: string; team: string; location: string; url: string; posted: string }

export type CompanyProfile = {
  sic: string
  website: string
  summary: string
  founded: string
  employees: string
  pages: CompanyPage[]
  peers: string[]
  links: CompanyLink[]
  jobs: JobPosting[]
  jobSource: string
  careersUrl: string
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
  profile: CompanyProfile
  archive: { filings: number; headlines: number }
  priorNote: StoredNote | null
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

function parseRss(xml: string, limit = 6): Headline[] {
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
    if (items.length >= limit) break
  }
  return items
}

async function rss(query: string, limit = 6): Promise<Headline[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" },
    })
    if (!response.ok) return []
    return parseRss(await response.text(), limit)
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

const WANTED_FORMS = new Set(["10-K", "10-Q", "8-K", "20-F", "40-F", "6-K", "10-K/A", "10-Q/A", "8-K/A"])

type FilingColumns = {
  form?: string[]
  filingDate?: string[]
  accessionNumber?: string[]
  primaryDocument?: string[]
  reportDate?: string[]
  items?: string[]
}

function filingsFromColumns(cik: string, columns: FilingColumns): Filing[] {
  const forms = columns.form ?? []
  const rows: Filing[] = []
  for (let i = 0; i < forms.length; i++) {
    if (!WANTED_FORMS.has(forms[i])) continue
    const accession = (columns.accessionNumber?.[i] ?? "").replace(/-/g, "")
    if (!accession) continue
    rows.push({
      form: forms[i],
      date: columns.filingDate?.[i] ?? "",
      reportDate: columns.reportDate?.[i] ?? "",
      items: forms[i].startsWith("8-K") ? itemLabel(columns.items?.[i] ?? "") : "",
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${columns.primaryDocument?.[i] ?? ""}`,
    })
  }
  return rows
}

async function olderFilings(cik: string, names: string[]) {
  const pages = await Promise.all(
    names.map(async (name) => {
      try {
        const response = await fetch(`https://data.sec.gov/submissions/${name}`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
          signal: AbortSignal.timeout(20000),
        })
        if (!response.ok) return [] as Filing[]
        return filingsFromColumns(cik, (await response.json()) as FilingColumns)
      } catch {
        return [] as Filing[]
      }
    }),
  )
  return pages.flat()
}

async function newsHistory(name: string, full: boolean) {
  const current = await rss(`"${name}" (investor relations OR "press release" OR earnings OR newsroom)`, 100)
  if (!full) return current
  const year = new Date().getFullYear()
  const years: number[] = []
  for (let cursor = year; cursor >= year - 10; cursor--) years.push(cursor)
  const older: Headline[] = []
  for (let i = 0; i < years.length; i += 5) {
    const chunk = years.slice(i, i + 4)
    const parts = await Promise.all(
      chunk.map((value) => rss(`"${name}" after:${value}-01-01 before:${value + 1}-01-01`, 80)),
    )
    for (const part of parts) older.push(...part)
  }
  return [...current, ...older]
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

const emptyProfile = (): CompanyProfile => ({
  sic: "",
  website: "",
  summary: "",
  founded: "",
  employees: "",
  pages: [],
  peers: [],
  links: [],
  jobs: [],
  jobSource: "",
  careersUrl: "",
})

const profileCache = new Map<string, { at: number; profile: CompanyProfile }>()

function claimValues(claims: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]> | undefined, pid: string) {
  return (claims?.[pid] ?? [])
    .map((claim) => {
      const value = claim.mainsnak?.datavalue?.value
      if (typeof value === "string") return value
      if (value && typeof value === "object" && "time" in value) return String((value as { time: string }).time).slice(1, 5)
      if (value && typeof value === "object" && "amount" in value) {
        return String((value as { amount: string }).amount).replace(/^\+/, "").split(".")[0]
      }
      return ""
    })
    .filter(Boolean)
}

function pickWebsite(urls: string[]) {
  const ranked = urls
    .filter((url) => /^https?:\/\//i.test(url))
    .map((url) => {
      try {
        const parsed = new URL(url)
        const path = parsed.pathname.replace(/\/$/, "")
        let score = 0
        if (!path) score += 5
        if (path.split("/").filter(Boolean).length <= 1) score += 2
        if (/^\/[a-z]{2}$/i.test(path)) score -= 4
        if (parsed.hostname.startsWith("www.")) score += 1
        return { url: `${parsed.protocol}//${parsed.host}`, score }
      } catch {
        return { url, score: -10 }
      }
    })
    .sort((a, b) => b.score - a.score)
  return ranked[0]?.url ?? ""
}

function pageText(html: string) {
  const description =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] ??
    ""
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const text = decode(`${description} ${body}`).slice(0, 500)
  return text.length >= 80 ? text : ""
}

async function readSitePage(url: string) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    })
    if (!response.ok) return null
    if (/sitemap/i.test(response.url)) return null
    const text = pageText((await response.text()).slice(0, 180000))
    if (!text) return null
    return { url: response.url || url, text }
  } catch {
    return null
  }
}

async function firstPage(origin: string, label: string, paths: string[]) {
  for (const path of paths) {
    const found = await readSitePage(`${origin}${path}`)
    if (found) return { label, url: found.url, text: found.text }
  }
  return null
}

const AI_ROLE = /artificial intelligence|machine learning|deep learning|generative|foundation model|\bllm\b|applied scientist|computer vision|natural language|mlops|\bai\b/i

function decodeHtml(value: string) {
  return value.replace(/&#34;/g, '"').replace(/&/g, "&").replace(/&#39;/g, "'")
}

async function fetchHtml(url: string) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(6000),
      redirect: "follow",
    })
    if (!response.ok) return { ok: false, url, html: "" }
    return { ok: true, url: response.url || url, html: decodeHtml((await response.text()).slice(0, 250000)) }
  } catch {
    return { ok: false, url, html: "" }
  }
}

function asJobs(
  rows: { title?: string; team?: string; location?: string; url?: string; posted?: string }[],
): JobPosting[] {
  const seen = new Set<string>()
  const jobs: JobPosting[] = []
  for (const row of rows) {
    const title = String(row.title || "").replace(/\s+/g, " ").trim()
    if (!title || !AI_ROLE.test(`${title} ${row.team || ""}`)) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    jobs.push({
      title: title.slice(0, 160),
      team: String(row.team || "").slice(0, 80),
      location: String(row.location || "").slice(0, 80),
      url: String(row.url || ""),
      posted: String(row.posted || "").slice(0, 40),
    })
    if (jobs.length >= 12) break
  }
  return jobs
}

async function workdayJobs(tenant: string, cluster: string, site: string) {
  const endpoint = `https://${tenant}.${cluster}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "machine learning" }),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return []
  const body = (await response.json()) as {
    jobPostings?: { title?: string; externalPath?: string; locationsText?: string; postedOn?: string }[]
  }
  return asJobs(
    (body.jobPostings ?? []).map((job) => ({
      title: job.title,
      location: job.locationsText,
      posted: job.postedOn,
      url: `https://${tenant}.${cluster}.myworkdayjobs.com/${site}${job.externalPath || ""}`,
    })),
  )
}

async function amazonJobs() {
  const response = await fetch("https://www.amazon.jobs/en/search.json?base_query=machine%20learning&result_limit=20", {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return []
  const body = (await response.json()) as {
    jobs?: { title?: string; job_category?: string; location?: string; job_path?: string; posted_date?: string }[]
  }
  return asJobs(
    (body.jobs ?? []).map((job) => ({
      title: job.title,
      team: job.job_category,
      location: job.location,
      posted: job.posted_date,
      url: job.job_path ? `https://www.amazon.jobs${job.job_path}` : "",
    })),
  )
}

async function greenhouseJobs(token: string) {
  const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return []
  const body = (await response.json()) as {
    jobs?: { title?: string; absolute_url?: string; location?: { name?: string } }[]
  }
  return asJobs(
    (body.jobs ?? []).map((job) => ({ title: job.title, location: job.location?.name, url: job.absolute_url })),
  )
}

async function leverJobs(site: string) {
  const response = await fetch(`https://api.lever.co/v0/postings/${site}?mode=json`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return []
  const body = (await response.json()) as {
    text?: string
    hostedUrl?: string
    categories?: { team?: string; location?: string }
  }[]
  if (!Array.isArray(body)) return []
  return asJobs(body.map((job) => ({ title: job.text, team: job.categories?.team, location: job.categories?.location, url: job.hostedUrl })))
}

async function ashbyJobs(board: string) {
  const response = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${board}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) return []
  const body = (await response.json()) as {
    jobs?: { title?: string; department?: string; location?: string; jobUrl?: string; publishedAt?: string }[]
  }
  return asJobs(
    (body.jobs ?? []).map((job) => ({
      title: job.title,
      team: job.department,
      location: job.location,
      url: job.jobUrl,
      posted: job.publishedAt,
    })),
  )
}

async function loadJobs(website: string) {
  const empty = { jobs: [] as JobPosting[], jobSource: "", careersUrl: website }
  const pages = await Promise.all(
    ["/careers", "/jobs", "/about/careers"].map((path) => fetchHtml(`${website}${path}`)),
  )
  let html = pages.map((page) => page.html).join("\n")
  const careersUrl = pages.find((page) => page.ok)?.url || website
  const deeper = html.match(/https?:\/\/(?:jobs|careers)\.[a-z0-9.-]+\/[a-z0-9./_-]*/i)
  if (deeper && !/myworkdayjobs|greenhouse|lever\.co|ashbyhq/i.test(html)) {
    const next = await fetchHtml(deeper[0])
    if (next.html) html += `\n${next.html}`
  }
  const workday = html.match(/https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/([A-Za-z0-9_]+)/i)
  if (workday && workday[3].toLowerCase() !== "login") {
    const jobs = await workdayJobs(workday[1], workday[2], workday[3]).catch(() => [])
    if (jobs.length) return { jobs, jobSource: "Workday", careersUrl }
  }
  const host = (url: string) => {
    try {
      return new URL(url).hostname
    } catch {
      return ""
    }
  }
  if (/(^|\.)amazon\.(jobs|com)$/i.test(host(website)) || /(^|\.)amazon\.jobs$/i.test(host(careersUrl))) {
    const jobs = await amazonJobs().catch(() => [])
    if (jobs.length) return { jobs, jobSource: "Amazon Jobs", careersUrl: "https://www.amazon.jobs/en/search?base_query=machine%20learning" }
  }
  const greenhouse = html.match(/(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9_-]+)/i)
  if (greenhouse) {
    const jobs = await greenhouseJobs(greenhouse[1]).catch(() => [])
    if (jobs.length) return { jobs, jobSource: "Greenhouse", careersUrl }
  }
  const lever = html.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i)
  if (lever) {
    const jobs = await leverJobs(lever[1]).catch(() => [])
    if (jobs.length) return { jobs, jobSource: "Lever", careersUrl }
  }
  const ashby = html.match(/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i)
  if (ashby) {
    const jobs = await ashbyJobs(ashby[1]).catch(() => [])
    if (jobs.length) return { jobs, jobSource: "Ashby", careersUrl }
  }
  return { ...empty, careersUrl }
}

async function loadProfile(ticker: string, name: string, sector: string): Promise<CompanyProfile> {
  const cached = profileCache.get(ticker)
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.profile
  const profile = emptyProfile()
  profile.peers = universe
    .filter((row) => row.sector === sector && row.ticker !== ticker)
    .slice(0, 8)
    .map((row) => `${row.ticker} ${row.name}`)
  const query = encodeURIComponent(name)
  const links: CompanyLink[] = [
    { label: "Glassdoor", url: `https://www.glassdoor.com/Search/results.htm?keyword=${query}` },
    { label: "Indeed", url: `https://www.indeed.com/cmp?q=${query}` },
    { label: "Crunchbase", url: `https://www.crunchbase.com/textsearch?q=${query}` },
    { label: "Buzzfile", url: `https://www.buzzfile.com/Search/Company/Results?searchTerm=${query}` },
  ]
  try {
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${query}&language=en&format=json&type=item&limit=1`
    const search = (await (await fetch(searchUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) })).json()) as {
      search?: { id?: string; label?: string; description?: string }[]
    }
    const hit = search.search?.[0]
    const words = name.toLowerCase().split(/\W+/).filter((word) => word.length > 3)
    const label = (hit?.label ?? "").toLowerCase()
    if (hit?.id && words.some((word) => label.includes(word))) {
      profile.summary = hit.description ?? ""
      const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${hit.id}&props=claims|sitelinks&sitefilter=enwiki&format=json`
      const entity = (await (await fetch(entityUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) })).json()) as {
        entities?: Record<string, { claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>; sitelinks?: { enwiki?: { title?: string } } }>
      }
      const record = entity.entities?.[hit.id]
      const claims = record?.claims
      profile.website = pickWebsite(claimValues(claims, "P856"))
      profile.founded = claimValues(claims, "P571")[0] ?? ""
      profile.employees = claimValues(claims, "P1128")[0] ?? ""
      const twitter = claimValues(claims, "P2002")[0]
      const linkedin = claimValues(claims, "P4264")[0]
      const instagram = claimValues(claims, "P2003")[0]
      const tiktok = claimValues(claims, "P7085")[0]
      if (twitter) links.unshift({ label: "X", url: `https://x.com/${twitter}` })
      else links.push({ label: "X", url: `https://x.com/search?q=${query}&f=live` })
      if (linkedin) links.unshift({ label: "LinkedIn", url: `https://www.linkedin.com/company/${linkedin}` })
      else links.push({ label: "LinkedIn", url: `https://www.linkedin.com/search/results/companies/?keywords=${query}` })
      if (instagram) links.unshift({ label: "Instagram", url: `https://www.instagram.com/${instagram}` })
      else links.push({ label: "Instagram", url: `https://www.instagram.com/explore/search/keyword/?q=${query}` })
      if (tiktok) links.unshift({ label: "TikTok", url: `https://www.tiktok.com/@${tiktok}` })
      else links.push({ label: "TikTok", url: `https://www.tiktok.com/search?q=${query}` })
      const wikiTitle = record?.sitelinks?.enwiki?.title
      if (wikiTitle) {
        links.unshift({ label: "Wikipedia", url: `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, "_"))}` })
        const wiki = (await (
          await fetch(
            `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&titles=${encodeURIComponent(wikiTitle)}&exintro=1&explaintext=1&format=json&redirects=1`,
            { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) },
          )
        ).json()) as { query?: { pages?: Record<string, { extract?: string }> } }
        const extract = Object.values(wiki.query?.pages ?? {})[0]?.extract ?? ""
        if (extract) profile.summary = extract.replace(/\s+/g, " ").trim().slice(0, 700)
      }
    }
  } catch {
    // Public reference data is optional. Filings still stand.
  }
  if (!links.some((item) => item.label === "X")) links.push({ label: "X", url: `https://x.com/search?q=${query}&f=live` })
  if (!links.some((item) => item.label === "LinkedIn")) {
    links.push({ label: "LinkedIn", url: `https://www.linkedin.com/search/results/companies/?keywords=${query}` })
  }
  if (profile.website) {
    const [about, newsroom, careers, hiring] = await Promise.all([
      firstPage(profile.website, "About", ["/about", "/about-us", "/company"]),
      firstPage(profile.website, "Newsroom", ["/newsroom", "/news", "/press", "/blog"]),
      firstPage(profile.website, "Careers", ["/careers", "/jobs"]),
      loadJobs(profile.website),
    ])
    profile.pages = [about, newsroom, careers].filter((page): page is CompanyPage => Boolean(page))
    profile.jobs = hiring.jobs
    profile.jobSource = hiring.jobSource
    profile.careersUrl = hiring.careersUrl
  }
  profile.links = links
  profileCache.set(ticker, { at: Date.now(), profile })
  return profile
}

export const getCompanyBrief = createServerFn({ method: "POST" })
  .validator((data: { ticker: string; name: string }) => ({
    ticker: String(data?.ticker ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9.-]/g, "")
      .slice(0, 8),
    name: String(data?.name ?? "").slice(0, 140),
  }))
  .handler(async ({ data }): Promise<CompanyBrief> => {
    const map = await loadTickers().catch(() => new Map<string, string>())
    const cik = map.get(data.ticker) ?? null
    let facts: FactLine[] = []
    let exchanges: string[] = []
    let address = ""
    let entity = "Not an SEC registrant under this ticker"
    let canadian = false
    let sic = ""
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
          sic?: string
          sicDescription?: string
          exchanges?: string[]
          addresses?: { business?: Record<string, string> }
          filings?: { recent?: FilingColumns; files?: { name: string }[] }
        }
        exchanges = sub.exchanges ?? []
        sic = [sub.sic, sub.sicDescription].filter(Boolean).join(" ")
        address = addressOf(sub.addresses?.business)
        canadian = /canada/i.test(address)
        const recentRows = filingsFromColumns(cik, sub.filings?.recent ?? {})
        const older = filingBackfillDone(data.ticker)
          ? []
          : await olderFilings(cik, (sub.filings?.files ?? []).map((file) => file.name))
        saveFilings(data.ticker, [...recentRows, ...older])
        if (!filingBackfillDone(data.ticker)) markFilingBackfill(data.ticker)
        const annual = recentFilings(data.ticker, 40).find(
          (row) => row.form === "10-K" || row.form === "20-F" || row.form === "40-F",
        )
        latestAnnual = annual ? `${annual.form} filed ${annual.date}` : null
        entity = canadian ? "Canada-linked SEC filer — SEDAR+ still required" : "US-listed SEC registrant"
      }
    }

    const sector = universe.find((row) => row.ticker === data.ticker)?.sector ?? ""
    const [freshNews, tradeNews, profile] = await Promise.all([
      newsHistory(data.name, !newsBackfillDone(data.ticker)).catch(() => [] as Headline[]),
      rss(`"${data.name}" ${sector} (industry OR contract OR competitor)`, 12).catch(() => [] as Headline[]),
      loadProfile(data.ticker, data.name, sector).catch(() => emptyProfile()),
    ])
    profile.sic = sic
    const incoming = [...freshNews, ...tradeNews]
    if (incoming.length > 0) saveHeadlines(data.ticker, incoming)
    if (!newsBackfillDone(data.ticker) && freshNews.length > 0) markNewsBackfill(data.ticker)
    const headlines = recentHeadlines(data.ticker, 6)
    const filings = recentFilings(data.ticker, 8)
    const archive = archiveCounts(data.ticker)
    const priorNote = latestNote(data.ticker)
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
      profile,
      archive,
      priorNote,
      rubric,
    }
  })
