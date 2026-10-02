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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState("")
  const [selected, setSelected] = useState<UniverseRow | null>(universe[0] ?? null)
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

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return universe
    return universe.filter((row) => row.ticker.toLowerCase().includes(q) || row.name.toLowerCase().includes(q))
  }, [query])

  const listed = useMemo(() => rows.slice(0, 40), [rows])

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
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Ticker or company"
          aria-label="Ticker or company"
          className="min-h-11 flex-1 rounded-xl border border-line bg-surface px-3 text-sm"
        />
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
      <div className="grid lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="px-4 py-6 sm:px-8">
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
                    {brief.address ? ` · ${brief.address}` : ""}
                    {brief.cik ? ` · CIK ${brief.cik}` : ""}
                  </p>
                  <div>
                    <h2 className="text-xs tracking-wide text-muted">Buy-side note</h2>
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
                            <span className="font-medium">Recent filings and news. </span>
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
                            <span className="font-medium">What could be wrong. </span>
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
        <aside className="border-t border-line lg:sticky lg:top-0 lg:max-h-screen lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <ul>
            {listed.map((row) => {
              const active = selected?.ticker === row.ticker
              return (
                <li key={row.ticker} className="border-b border-line">
                  <button
                    type="button"
                    onClick={() => setSelected(row)}
                    className={"w-full px-4 py-2.5 text-left " + (active ? "bg-chip" : "hover:bg-surface")}
                  >
                    <span className="font-medium">{row.ticker}</span>
                    <span className="ml-2 text-sm text-muted">{row.name}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {rows.length > 40 && (
            <p className="px-4 py-3 text-xs text-muted">Showing 40 of {rows.length}. Search to narrow.</p>
          )}
        </aside>
      </div>
    </main>
  )
}
