import { createFileRoute } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { useEffect, useMemo, useState } from "react"
import { universe, type UniverseRow } from "@/data/universe"
import { getCompanyBrief, type CompanyBrief } from "@/lib/intel.functions"
import { cancelLocalModel, DEFAULT_ENDPOINT, DEFAULT_MODEL, pollLocalModel, startLocalModel, type LocalReview } from "@/lib/local-llm"

export const Route = createFileRoute("/")({ component: Home })

async function reachDesk<T>(run: () => Promise<T>) {
  let last = "Failed to fetch"
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await run()
    } catch (error) {
      last = error instanceof Error ? error.message : last
      const dropped = /failed to fetch|networkerror|load failed/i.test(last)
      if (!dropped || attempt === 5) break
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  throw new Error(last === "Failed to fetch" ? "The page lost the desk for a moment. Open the company again." : last)
}

function Home() {
  const fetchBrief = useServerFn(getCompanyBrief)
  const startReview = useServerFn(startLocalModel)
  const pollReview = useServerFn(pollLocalModel)
  const cancelReview = useServerFn(cancelLocalModel)
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState("")
  const [selected, setSelected] = useState<UniverseRow | null>(null)
  const [brief, setBrief] = useState<CompanyBrief | null>(null)
  const [briefState, setBriefState] = useState<"idle" | "loading" | "error">("idle")
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT)
  const [modelName, setModelName] = useState(DEFAULT_MODEL)
  const [settingsReady, setSettingsReady] = useState(false)
  const [armed, setArmed] = useState(false)
  const [review, setReview] = useState<LocalReview | null>(null)
  const [savedAt, setSavedAt] = useState("")
  const [reviewState, setReviewState] = useState<"idle" | "loading" | "error">("idle")
  const [reviewError, setReviewError] = useState("")

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return universe
      .filter((row) => row.ticker.toLowerCase().includes(q) || row.name.toLowerCase().includes(q))
      .slice(0, 8)
  }, [query])

  useEffect(() => {
    const saved = localStorage.getItem("mole-intel-llm")
    let nextEndpoint = DEFAULT_ENDPOINT
    let nextModel = DEFAULT_MODEL
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as { endpoint?: string; model?: string }
        const stale =
          !parsed.endpoint ||
          parsed.endpoint === "http://127.0.0.1:8080/v1" ||
          parsed.endpoint === "http://127.0.0.1:11434/v1"
        if (!stale && parsed.endpoint) nextEndpoint = parsed.endpoint
        if (parsed.model && parsed.model !== "local") nextModel = parsed.model
      } catch {
        localStorage.removeItem("mole-intel-llm")
      }
    }
    setEndpoint(nextEndpoint)
    setModelName(nextModel)
    localStorage.setItem("mole-intel-llm", JSON.stringify({ endpoint: nextEndpoint, model: nextModel }))
    setArmed(true)
    setSettingsReady(true)
  }, [])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setBriefState("loading")
    setBrief(null)
    setReview(null)
    setReviewState("idle")
    setReviewError("")
    fetchBrief({ data: { ticker: selected.ticker, name: selected.name } })
      .then((value) => {
        if (!cancelled) {
          setBrief(value)
          setBriefState("idle")
          if (value.priorNote) {
            setReview({
              digest: value.priorNote.digest,
              thesis: value.priorNote.thesis,
              analysis: value.priorNote.analysis,
              risks: value.priorNote.risks,
              gaps: value.priorNote.gaps,
              model: value.priorNote.model,
            })
            setSavedAt(value.priorNote.createdAt)
          } else {
            setSavedAt("")
          }
        }
      })
      .catch(() => {
        if (!cancelled) setBriefState("error")
      })
    return () => {
      cancelled = true
    }
  }, [selected, fetchBrief])

  useEffect(() => {
    if (!settingsReady || !armed || !brief) return
    let cancelled = false
    let timer = 0
    const job = { id: "" }
    setReviewState("loading")
    setReviewError("")
    const tick = async () => {
      const started = await reachDesk(() => startReview({ data: { endpoint, model: modelName, brief } }))
      if (cancelled) {
        void cancelReview({ data: { jobId: started.jobId } })
        return
      }
      job.id = started.jobId
      while (!cancelled) {
        await new Promise((resolve) => {
          timer = window.setTimeout(resolve, 2000)
        })
        if (cancelled) return
        const value = await reachDesk(() => pollReview({ data: { jobId: job.id } }))
        if (cancelled) return
        if (!value.ok) {
          setReviewState("error")
          setReviewError(value.error)
          return
        }
        if (value.pending) continue
        setReview(value.review)
        setSavedAt("")
        setReviewState("idle")
        return
      }
    }
    tick().catch((error: unknown) => {
      if (cancelled) return
      setReviewState("error")
      setReviewError(error instanceof Error ? error.message : "The local model did not answer")
    })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (job.id) void cancelReview({ data: { jobId: job.id } })
    }
  }, [armed, brief, cancelReview, endpoint, modelName, pollReview, settingsReady, startReview])

  function saveModel() {
    const next = endpoint.trim()
    if (!/^https?:\/\//i.test(next)) {
      setSettingsError("The address must start with http:// or https://")
      return
    }
    localStorage.setItem("mole-intel-llm", JSON.stringify({ endpoint: next, model: modelName.trim() }))
    setEndpoint(next)
    setSettingsError("")
    setSettingsOpen(false)
    setArmed(true)
  }

  return (
    <main className="min-h-screen">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-6">
        <div className="relative flex-1">
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
            placeholder="Ticker or company"
            aria-label="Ticker or company"
            className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm"
          />
          {searchOpen && query.trim() && (
            <ul className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-xl border border-line bg-surface">
              {matches.length === 0 && <li className="px-3 py-2 text-sm text-muted">No company</li>}
              {matches.map((row) => (
                <li key={row.ticker}>
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault()
                      setSelected(row)
                      setQuery("")
                      setSearchOpen(false)
                    }}
                    className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-chip"
                  >
                    <span className="font-medium">{row.ticker}</span>
                    <span className="text-sm text-muted">{row.name}</span>
                    <span className="ml-auto text-xs text-muted">{row.index}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="min-h-11 rounded-xl border border-line bg-surface px-3 text-sm"
        >
          Settings
        </button>
      </header>
      {settingsOpen && (
        <div
          className="fixed inset-0 z-20 flex items-start justify-center bg-ink/40 px-4 pt-20"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-line bg-surface p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">Settings</h2>
              <button type="button" onClick={() => setSettingsOpen(false)} className="text-sm text-muted">
                Close
              </button>
            </div>
            <label className="mt-4 block text-xs text-muted" htmlFor="llm-endpoint">
              Model address
            </label>
            <input
              id="llm-endpoint"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-line bg-bg px-3 text-sm"
            />
            <label className="mt-3 block text-xs text-muted" htmlFor="llm-model">
              Model name
            </label>
            <input
              id="llm-model"
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-line bg-bg px-3 text-sm"
            />
            {settingsError && <p className="mt-3 text-sm text-accent">{settingsError}</p>}
            <button type="button" onClick={saveModel} className="mt-4 min-h-11 rounded-xl bg-ink px-3 text-sm text-surface">
              Save
            </button>
          </div>
        </div>
      )}
      <div>
        <section className="px-4 py-6 sm:px-8">
          {!selected && <p className="text-sm text-muted">Search for a company.</p>}
          {selected && (
            <div>
              <p className="text-xs tracking-wide text-muted">{selected.index}</p>
              <h1 className="font-display text-4xl">{selected.name}</h1>
              <p className="text-sm text-muted">
                {selected.ticker} · {selected.sector}
              </p>
              {briefState === "loading" && <p className="mt-6 text-sm text-muted">Reading filings and wires…</p>}
              {briefState === "error" && (
                <p className="mt-6 text-sm text-accent">Could not load this company. Try another ticker.</p>
              )}
              {brief && (
                <div className="mt-6 max-w-3xl space-y-6">
                  <p className="text-sm leading-relaxed">{brief.entity}</p>
                  <p className="text-sm text-muted">
                    {brief.exchanges.join(", ") || "Exchange not on the SEC profile"}
                    {brief.profile.sic ? ` · ${brief.profile.sic}` : ""}
                    {brief.address ? ` · ${brief.address}` : ""}
                    {brief.cik ? ` · CIK ${brief.cik}` : ""}
                    {brief.profile.founded ? ` · founded ${brief.profile.founded}` : ""}
                    {brief.profile.employees ? ` · about ${brief.profile.employees} employees` : ""}
                  </p>
                  {(brief.profile.summary || brief.profile.website || brief.profile.pages.length > 0) && (
                    <div>
                      <h2 className="text-xs tracking-wide text-muted">What the company says</h2>
                      {brief.profile.website && (
                        <a href={brief.profile.website} target="_blank" rel="noreferrer" className="mt-1 block text-sm text-pine underline">
                          {brief.profile.website}
                        </a>
                      )}
                      {brief.profile.summary && <p className="mt-2 text-sm leading-relaxed">{brief.profile.summary}</p>}
                      {brief.profile.pages.map((page) => (
                        <p key={page.url} className="mt-2 text-sm leading-relaxed">
                          <a href={page.url} target="_blank" rel="noreferrer" className="font-medium text-pine underline">
                            {page.label}
                          </a>
                          <span className="text-muted"> {page.text}</span>
                        </p>
                      ))}
                    </div>
                  )}
                  {brief.profile.peers.length > 0 && (
                    <p className="text-sm text-muted">Same sector in the universe: {brief.profile.peers.join(", ")}</p>
                  )}
                  {brief.profile.links.length > 0 && (
                    <div>
                      <h2 className="text-xs tracking-wide text-muted">Channels not read here</h2>
                      <p className="mt-1 text-xs text-muted">
                        Social, reviews, and private-company databases stay behind their own login. These open the public page.
                      </p>
                      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {brief.profile.links.map((link) => (
                          <li key={link.label}>
                            <a href={link.url} target="_blank" rel="noreferrer" className="text-sm text-pine underline">
                              {link.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div>
                    <h2 className="text-xs tracking-wide text-muted">Open roles</h2>
                    <p className="mt-1 text-xs text-muted">
                      {brief.profile.jobTotal || brief.profile.jobs.length} English postings
                      {brief.profile.jobSource ? ` From ${brief.profile.jobSource}.` : ""} The note uses them only if they confirm or contradict the news.
                      {brief.profile.jobs.length > 12 ? " Showing 12." : ""}
                    </p>
                    {brief.profile.jobs.length === 0 && (
                      <p className="mt-2 text-sm text-muted">No public job list came back for this name.</p>
                    )}
                    <ul className="mt-2 space-y-2">
                      {brief.profile.jobs.slice(0, 12).map((job) => (
                        <li key={job.url || job.title} className="text-sm">
                          {job.url ? (
                            <a href={job.url} target="_blank" rel="noreferrer" className="text-pine underline">
                              {job.title}
                            </a>
                          ) : (
                            <span>{job.title}</span>
                          )}
                          <span className="mt-1 block text-xs text-muted">
                            {[job.team, job.location, job.posted].filter(Boolean).join(" · ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {brief.profile.careersUrl && (
                      <a href={brief.profile.careersUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-pine underline">
                        Careers page
                      </a>
                    )}
                  </div>
                  <div>
                    <h2 className="text-xs tracking-wide text-muted">Company read</h2>
                    <p className="mt-1 text-xs text-muted">A short read of where the company stands, from the news.</p>
                    {reviewState === "loading" && review && (
                      <p className="mt-2 text-sm text-muted">
                        Updating the note. Showing the last one
                        {savedAt ? ` from ${savedAt.slice(0, 16).replace("T", " ")}` : ""}.
                      </p>
                    )}
                    {reviewState === "loading" && !review && (
                      <p className="mt-2 text-sm text-muted">qwen3.5 is working the name. This can take a few minutes.</p>
                    )}
                    {reviewState === "error" && <p className="mt-2 text-sm text-accent">{reviewError}</p>}
                    {review && (
                      <div className="mt-2 space-y-3">
                        {review.digest && (
                          <p className="text-sm leading-relaxed">
                            <span className="font-medium">The news. </span>
                            {review.digest}
                          </p>
                        )}
                        {review.thesis && <p className="text-sm leading-relaxed font-medium">{review.thesis}</p>}
                        {review.analysis.split(/\n+/).filter(Boolean).map((paragraph) => (
                          <p key={paragraph.slice(0, 40)} className="text-sm leading-relaxed">
                            {paragraph}
                          </p>
                        ))}
                        {review.risks && (
                          <p className="text-sm leading-relaxed">
                            <span className="font-medium">Do not take this at face value. </span>
                            {review.risks}
                          </p>
                        )}
                        {review.gaps && <p className="text-sm leading-relaxed text-muted">{review.gaps}</p>}
                        <p className="text-xs text-muted">Answered by {review.model}</p>
                      </div>
                    )}
                  </div>
                  {brief.facts.length > 0 && (
                    <div>
                      <h2 className="text-xs tracking-wide text-muted">Figures from EDGAR</h2>
                      <ul className="mt-2 space-y-2">
                        {brief.facts.map((fact) => (
                          <li key={fact.label} className="text-sm">
                            <span className="font-medium">
                              {fact.label}
                              <span className="font-normal text-muted"> · {fact.unit}</span>
                            </span>
                            <span className="mt-1 block text-muted">{fact.points.join(" · ")}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div>
                    <h2 className="text-xs tracking-wide text-muted">Latest IR or news</h2>
                    <p className="mt-1 text-xs text-muted">{brief.archive.headlines} stored. Showing the latest.</p>
                    <ul className="mt-2 space-y-2">
                      {brief.headlines.length === 0 && (
                        <li className="text-sm text-muted">No wire came back for this name.</li>
                      )}
                      {brief.headlines.map((item) => (
                        <li key={item.link || item.title} className="text-sm">
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
                    <h2 className="text-xs tracking-wide text-muted">Recent filings</h2>
                    <p className="mt-1 text-xs text-muted">{brief.archive.filings} stored. Showing the latest.</p>
                    <ul className="mt-2 space-y-1 text-sm">
                      {brief.filings.map((filing) => (
                        <li key={filing.url}>
                          <a href={filing.url} target="_blank" rel="noreferrer" className="text-pine underline">
                            {filing.form}
                          </a>
                          <span className="text-muted">
                            {" "}
                            · {filing.date}
                            {filing.items ? ` · ${filing.items}` : ""}
                          </span>
                        </li>
                      ))}
                      {brief.filings.length === 0 && <li className="text-muted">No recent 10-K, 10-Q, or 8-K.</li>}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
