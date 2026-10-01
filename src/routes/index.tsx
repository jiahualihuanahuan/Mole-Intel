import { createFileRoute } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { universe, type UniverseRow } from "@/data/universe"
import { getCompanyBrief, getNewsBatch, type CompanyBrief, type Headline } from "@/lib/intel.functions"

export const Route = createFileRoute("/")({ component: Home })

type Filter = "all" | "ndx" | "spx"

function Home() {
  const fetchNews = useServerFn(getNewsBatch)
  const fetchBrief = useServerFn(getCompanyBrief)
  const [filter, setFilter] = useState<Filter>("ndx")
  const [query, setQuery] = useState("")
  const [news, setNews] = useState<Record<string, Headline[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<UniverseRow | null>(universe[0] ?? null)
  const [brief, setBrief] = useState<CompanyBrief | null>(null)
  const [briefState, setBriefState] = useState<"idle" | "loading" | "error">("idle")
  const checked = useRef(new Set<string>())
  const fetchNewsRef = useRef(fetchNews)
  fetchNewsRef.current = fetchNews

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return universe.filter((row) => {
      if (filter === "ndx" && row.priority !== 0) return false
      if (filter === "spx" && row.priority !== 1) return false
      if (!q) return true
      return row.ticker.toLowerCase().includes(q) || row.name.toLowerCase().includes(q)
    })
  }, [filter, query])

  const ndxCount = universe.filter((row) => row.priority === 0).length
  const spxCount = universe.length - ndxCount
  const checkedNdx = universe.filter((row) => row.priority === 0 && news[row.ticker]).length

  useEffect(() => {
    let cancelled = false
    let timer = 0
    async function pump() {
      if (cancelled) return
      const pending = rows.filter((row) => !checked.current.has(row.ticker)).slice(0, 4)
      if (pending.length === 0) return
      pending.forEach((row) => checked.current.add(row.ticker))
      try {
        const payload = await fetchNewsRef.current({
          data: { items: pending.map((row) => ({ ticker: row.ticker, name: row.name })) },
        })
        if (cancelled) return
        setNews((prev) => {
          const next = { ...prev }
          for (const result of payload.results) next[result.ticker] = result.headlines
          return next
        })
        setErrors((prev) => {
          const next = { ...prev }
          for (const result of payload.results) {
            if (result.error) next[result.ticker] = result.error
          }
          return next
        })
      } catch {
        if (!cancelled) {
          pending.forEach((row) => checked.current.delete(row.ticker))
        }
      }
      if (!cancelled && rows.some((row) => !checked.current.has(row.ticker))) {
        timer = window.setTimeout(() => void pump(), 350)
      }
    }
    void pump()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [rows])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setBriefState("loading")
    setBrief(null)
    fetchBrief({ data: { ticker: selected.ticker, name: selected.name } })
      .then((value) => {
        if (!cancelled) {
          setBrief(value)
          setBriefState("idle")
        }
      })
      .catch(() => {
        if (!cancelled) setBriefState("error")
      })
    return () => {
      cancelled = true
    }
  }, [selected, fetchBrief])

  return (
    <main className="min-h-screen">
      <header className="border-b border-line px-4 py-5 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium tracking-wide text-accent">Company desk</p>
            <h1 className="font-display text-4xl text-ink">Mole Intel</h1>
          </div>
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            Nasdaq 100 is checked first, then the rest of the S&P 500. Each name is matched to its latest
            investor-relations wire or news item, and the filing still outranks the headline.
          </p>
        </div>
      </header>
      <div className="grid lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
        <section className="border-line px-4 py-4 sm:px-8 lg:border-r">
          <div className="flex flex-wrap items-center gap-2">
            <FilterButton active={filter === "ndx"} onClick={() => setFilter("ndx")}>
              Nasdaq 100 · {ndxCount}
            </FilterButton>
            <FilterButton active={filter === "spx"} onClick={() => setFilter("spx")}>
              S&P 500 only · {spxCount}
            </FilterButton>
            <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
              Both · {universe.length}
            </FilterButton>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ticker or company"
              className="min-h-11 min-w-48 flex-1 rounded-xl border border-line bg-surface px-3 text-sm"
            />
          </div>
          <p className="mt-3 text-sm text-muted">
            Nasdaq 100 wires checked: {checkedNdx} of {ndxCount}. S&P 500 names wait until you open that list.
          </p>
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {rows.slice(0, 40).map((row) => {
              const headline = news[row.ticker]?.[0]
              const active = selected?.ticker === row.ticker
              return (
                <li key={row.ticker}>
                  <button
                    type="button"
                    onClick={() => setSelected(row)}
                    className={
                      "flex w-full flex-col gap-1 px-4 py-3 text-left sm:flex-row sm:items-start sm:justify-between " +
                      (active ? "bg-chip" : "hover:bg-bg")
                    }
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{row.ticker}</span>
                      <span className="ml-2 text-sm text-muted">{row.name}</span>
                      <span className="mt-1 block text-xs text-muted">
                        {row.index} · {row.sector}
                      </span>
                    </span>
                    <span className="max-w-md text-sm leading-snug text-ink">
                      {headline ? (
                        <>
                          <span
                            className={
                              "mr-2 rounded-full px-2 py-0.5 text-xs " +
                              (headline.kind === "ir" ? "bg-pine text-surface" : "bg-chip text-ink")
                            }
                          >
                            {headline.kind === "ir" ? "IR / wire" : "News"}
                          </span>
                          {headline.title}
                        </>
                      ) : errors[row.ticker] ? (
                        <span className="text-accent">News check failed</span>
                      ) : (
                        <span className="text-muted">Checking IR and news…</span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {rows.length > 40 && (
            <p className="mt-3 text-sm text-muted">
              Showing 40 of {rows.length}. Search to narrow. News keeps loading down the priority list.
            </p>
          )}
        </section>
        <aside className="px-4 py-4 sm:px-6">
          {selected && (
            <div className="rounded-2xl border border-line bg-surface p-4">
              <p className="text-xs tracking-wide text-muted">{selected.index}</p>
              <h2 className="font-display text-3xl">{selected.name}</h2>
              <p className="text-sm text-muted">
                {selected.ticker} · {selected.sector}
              </p>
              {briefState === "loading" && <p className="mt-4 text-sm text-muted">Reading filings and wires…</p>}
              {briefState === "error" && (
                <p className="mt-4 text-sm text-accent">Could not load this company. Try another ticker.</p>
              )}
              {brief && (
                <div className="mt-4 space-y-4">
                  <p className="text-sm leading-relaxed">{brief.entity}</p>
                  <p className="text-sm text-muted">
                    {brief.exchanges.join(", ") || "Exchange not on the SEC profile"}
                    {brief.address ? ` · ${brief.address}` : ""}
                    {brief.cik ? ` · CIK ${brief.cik}` : ""}
                  </p>
                  <div>
                    <h3 className="text-xs tracking-wide text-muted">Latest IR or news</h3>
                    <ul className="mt-2 space-y-2">
                      {brief.headlines.length === 0 && (
                        <li className="text-sm text-muted">No wire came back for this name.</li>
                      )}
                      {brief.headlines.map((item) => (
                        <li key={item.link} className="text-sm">
                          <a href={item.link} target="_blank" rel="noreferrer" className="text-pine underline">
                            {item.title}
                          </a>
                          <span className="mt-1 block text-xs text-muted">
                            {item.kind === "ir" ? "IR / wire" : "News"}
                            {item.source ? ` · ${item.source}` : ""} {item.published}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-xs tracking-wide text-muted">Source test</h3>
                    <ul className="mt-2 space-y-2">
                      {brief.rubric.map((item) => (
                        <li key={item.question} className="text-sm">
                          <span className="font-medium">{item.question}. </span>
                          <span className="text-muted">{item.note}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="text-xs tracking-wide text-muted">Recent filings</h3>
                    <ul className="mt-2 space-y-1 text-sm">
                      {brief.filings.map((filing) => (
                        <li key={filing.url}>
                          <a href={filing.url} target="_blank" rel="noreferrer" className="text-pine underline">
                            {filing.form}
                          </a>
                          <span className="text-muted"> · {filing.date}</span>
                        </li>
                      ))}
                      {brief.filings.length === 0 && <li className="text-muted">No recent 10-K, 10-Q, or 8-K.</li>}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "min-h-11 rounded-xl px-3 text-sm " +
        (active ? "bg-ink text-surface" : "border border-line bg-surface text-ink")
      }
    >
      {children}
    </button>
  )
}
