import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { universe, type UniverseRow } from "@/data/universe";
import { listArchiveFn, loadArchiveFn, readTapeFn, runDebateFn } from "@/lib/debate.functions";
import type { DebateResult, JudgeNote, SeatNote, Tape } from "@/lib/debate-types";

export const Route = createFileRoute("/")({ component: Home });

const STORE = "mole-intel-debates";
const SEAT_ORDER = ["bull", "bear", "valuation", "macro", "earnings", "analyst"] as const;

type Listed = {
  ticker: string;
  name: string;
  sector: string;
  indexName: string;
  call: string;
};

function money(value: number | null): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(value: number | null): string {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function toneClass(value: number | null): string {
  if (value == null) return "text-muted";
  if (value > 0.05) return "text-pine";
  if (value < -0.05) return "text-accent";
  return "text-ink";
}

function listedFrom(row: DebateResult): Listed {
  return {
    ticker: row.ticker,
    name: row.name,
    sector: row.sector,
    indexName: row.indexName,
    call: row.judge?.call ?? "",
  };
}

function loadSaved(): DebateResult[] {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DebateResult[];
    return Array.isArray(parsed) ? parsed.slice(0, 12) : [];
  } catch {
    return [];
  }
}

function Home() {
  const readTape = useServerFn(readTapeFn);
  const runDebate = useServerFn(runDebateFn);
  const listArchive = useServerFn(listArchiveFn);
  const loadArchive = useServerFn(loadArchiveFn);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<UniverseRow | null>(null);
  const [tape, setTape] = useState<Tape | null>(null);
  const [tapeState, setTapeState] = useState<"idle" | "loading" | "error">("idle");
  const [debate, setDebate] = useState<DebateResult | null>(null);
  const [deskState, setDeskState] = useState<"idle" | "loading" | "error">("idle");
  const [deskError, setDeskError] = useState("");
  const [saved, setSaved] = useState<Listed[]>([]);
  const [fromArchive, setFromArchive] = useState(false);

  function showList(hits: { ticker: string; call: string }[]) {
    const fromFile: Listed[] = hits.map((hit) => {
      const known = universe.find((row) => row.ticker === hit.ticker);
      return {
        ticker: hit.ticker,
        name: known?.name ?? hit.ticker,
        sector: known?.sector ?? "Unlisted",
        indexName: known?.index ?? "Tape",
        call: hit.call,
      };
    });
    const local = loadSaved()
      .map(listedFrom)
      .filter((row) => !fromFile.some((item) => item.ticker === row.ticker));
    setFromArchive(fromFile.length > 0);
    setSaved([...fromFile, ...local]);
  }

  useEffect(() => {
    listArchive({ data: {} })
      .then(showList)
      .catch(() => setSaved(loadSaved().map(listedFrom)));
    // Load the archive once. listArchive is stable enough for this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return universe
      .filter((row) => row.ticker.toLowerCase().includes(q) || row.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query]);

  function remember(next: DebateResult) {
    const list = [next, ...loadSaved().filter((row) => row.ticker !== next.ticker)].slice(0, 12);
    localStorage.setItem(STORE, JSON.stringify(list));
    listArchive({ data: {} })
      .then(showList)
      .catch(() => setSaved(loadSaved().map(listedFrom)));
  }

  function openCompany(row: UniverseRow) {
    setSelected(row);
    setQuery("");
    setSearchOpen(false);
    setTape(null);
    setDebate(loadSaved().find((item) => item.ticker === row.ticker) ?? null);
    setDeskState("idle");
    setDeskError("");
    setTapeState("loading");
    loadArchive({ data: { ticker: row.ticker } })
      .then((value) => {
        if (!value) return;
        setDebate((current) => (current?.source === "desk" && current.ticker === row.ticker ? current : value));
      })
      .catch(() => undefined);
    readTape({ data: { ticker: row.ticker } })
      .then((value) => {
        setTape(value);
        setTapeState("idle");
      })
      .catch(() => setTapeState("error"));
  }

  function openRaw(ticker: string) {
    const known = universe.find((row) => row.ticker === ticker);
    openCompany(known ?? { ticker, name: ticker, sector: "Unlisted", index: "Tape" });
  }

  async function startDesk() {
    if (!selected || deskState === "loading") return;
    setDeskState("loading");
    setDeskError("");
    try {
      const value = await runDebate({ data: { ticker: selected.ticker } });
      setDebate(value);
      setTape(value.tape);
      remember(value);
      setDeskState(value.judge ? "idle" : "error");
      if (!value.judge) setDeskError(value.errors[0] || "The judge did not write a note.");
    } catch (error) {
      setDeskState("error");
      setDeskError(error instanceof Error ? error.message : "The desk did not answer.");
    }
  }

  const rawTicker = query.trim().toUpperCase();
  const showRaw = /^[A-Z.]{1,8}$/.test(rawTicker) && !matches.some((row) => row.ticker === rawTicker);

  return (
    <main className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 py-3 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <p className="hidden font-display text-xl sm:block">Mole Intel</p>
          <div className="relative min-w-0 flex-1">
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => window.setTimeout(() => setSearchOpen(false), 200)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches[0]) openCompany(matches[0]);
                else if (event.key === "Enter" && showRaw) openRaw(rawTicker);
              }}
              placeholder="Ticker or company"
              aria-label="Ticker or company"
              className="min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm outline-none"
            />
            {searchOpen && query.trim() && (
              <ul className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-card border border-line bg-surface shadow-sm">
                {matches.length === 0 && !showRaw && (
                  <li className="px-3 py-3 text-sm text-muted">No company in the desk list.</li>
                )}
                {matches.map((row) => (
                  <li key={row.ticker}>
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        openCompany(row);
                      }}
                      className="flex min-h-11 w-full items-baseline gap-2 px-3 text-left hover:bg-chip"
                    >
                      <span className="font-medium">{row.ticker}</span>
                      <span className="truncate text-sm text-muted">{row.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted">{row.index}</span>
                    </button>
                  </li>
                ))}
                {showRaw && (
                  <li>
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        openRaw(rawTicker);
                      }}
                      className="flex min-h-11 w-full items-baseline gap-2 px-3 text-left hover:bg-chip"
                    >
                      <span className="font-medium">{rawTicker}</span>
                      <span className="text-sm text-muted">Open this ticker</span>
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8">
        {!selected && <Empty saved={saved} archive={fromArchive} onOpen={openCompany} />}
        {selected && (
          <Company
            company={selected}
            tape={tape}
            tapeState={tapeState}
            debate={debate}
            deskState={deskState}
            deskError={deskError}
            onRun={() => void startDesk()}
          />
        )}
      </div>
    </main>
  );
}

function Empty({
  saved,
  archive,
  onOpen,
}: {
  saved: Listed[];
  archive: boolean;
  onOpen: (row: UniverseRow) => void;
}) {
  return (
    <section className="max-w-2xl pt-6">
      <p className="text-xs tracking-wide text-muted">The desk</p>
      <h1 className="font-display text-4xl leading-tight sm:text-5xl">Six seats. One judge. The split stays on the page.</h1>
      <p className="mt-4 max-w-xl text-base text-muted">
        Search a company. Bull, bear, valuation, macro, earnings, and analysts each read the same tape. The judge writes the call and lists what they still do not agree on.
      </p>
      {saved.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xs tracking-wide text-muted">{archive ? "From the archive" : "Saved on this browser"}</h2>
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {saved.map((row) => (
              <li key={row.ticker}>
                <button
                  type="button"
                  onClick={() =>
                    onOpen({
                      ticker: row.ticker,
                      name: row.name,
                      sector: row.sector,
                      index: row.indexName,
                    })
                  }
                  className="flex min-h-11 w-full items-baseline gap-3 py-2 text-left"
                >
                  <span className="font-medium">{row.ticker}</span>
                  <span className="truncate text-sm text-muted">{row.name}</span>
                  <span className="ml-auto text-xs capitalize text-muted">{row.call || "unread"}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Company({
  company,
  tape,
  tapeState,
  debate,
  deskState,
  deskError,
  onRun,
}: {
  company: UniverseRow;
  tape: Tape | null;
  tapeState: "idle" | "loading" | "error";
  debate: DebateResult | null;
  deskState: "idle" | "loading" | "error";
  deskError: string;
  onRun: () => void;
}) {
  const shown = tape ?? debate?.tape ?? null;
  return (
    <article>
      <p className="text-xs tracking-wide text-muted">{company.index}</p>
      <h1 className="font-display text-4xl sm:text-5xl">{company.name}</h1>
      <p className="text-sm text-muted">
        {company.ticker} · {company.sector}
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4">
        <Fact label="Last" value={shown ? money(shown.price) : "—"} hint={shown?.currency ?? ""} />
        <Fact label="Day" value={shown ? pct(shown.changePct) : "—"} className={toneClass(shown?.changePct ?? null)} />
        <Fact label="3 months" value={shown ? pct(shown.return3mPct) : "—"} className={toneClass(shown?.return3mPct ?? null)} />
        <Fact label="Wires" value={shown ? String(shown.headlines.length) : "—"} hint="headlines" />
      </dl>
      {tapeState === "loading" && <p className="mt-3 text-sm text-muted">Reading the tape…</p>}
      {tapeState === "error" && <p className="mt-3 text-sm text-accent">The tape did not load. The desk can still sit, but it will say the numbers are unknown.</p>}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={deskState === "loading"}
          className="min-h-11 rounded-card bg-ink px-4 text-sm text-surface disabled:opacity-60"
        >
          {deskState === "loading" ? "The desk is sitting…" : debate?.source === "archive" ? "Run it again on the 3080" : debate ? "Sit the desk again" : "Sit the desk"}
        </button>
        <p className="text-xs text-muted">
          {debate?.source === "archive"
            ? `Already in the archive${debate.asOf ? `, ${debate.asOf.slice(0, 16).replace("T", " ")} UTC` : ""}.`
            : "One pass on the 3080. About a minute."}
        </p>
      </div>
      {deskState === "loading" && (
        <p className="mt-4 text-sm text-muted">Bull, bear, valuation, macro, earnings, and analysts are reading. The judge goes last.</p>
      )}
      {deskError && <p className="mt-4 text-sm text-accent">{deskError}</p>}

      {debate && <Desk debate={debate} />}
    </article>
  );
}

function Fact({ label, value, hint, className }: { label: string; value: string; hint?: string; className?: string }) {
  return (
    <div className="bg-surface px-3 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 font-display text-2xl tabular-nums ${className ?? "text-ink"}`}>{value}</dd>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function Desk({ debate }: { debate: DebateResult }) {
  return (
    <div className="mt-8 space-y-8">
      {debate.judge && <Judge note={debate.judge} model={debate.model} />}
      <section>
        <h2 className="text-xs tracking-wide text-muted">The seats</h2>
        <div className="mt-3 space-y-3">
          {SEAT_ORDER.map((key) => (
            <Seat key={key} note={debate.seats[key] ?? null} fallback={key} />
          ))}
        </div>
      </section>
      {debate.tape.headlines.length > 0 && (
        <section>
          <h2 className="text-xs tracking-wide text-muted">Wires in the packet</h2>
          <ul className="mt-2 space-y-2">
            {debate.tape.headlines.map((headline) => (
              <li key={headline} className="text-sm leading-relaxed">
                {headline}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Judge({ note, model }: { note: JudgeNote; model: string }) {
  const callColor =
    note.call === "bullish" ? "text-pine" : note.call === "bearish" ? "text-accent" : "text-ink";
  return (
    <section className="rounded-card border border-line bg-surface p-4 sm:p-6">
      <p className="text-xs tracking-wide text-muted">Judge</p>
      <p className={`mt-1 font-display text-3xl capitalize ${callColor}`}>{note.call}</p>
      {note.conviction != null && (
        <p className="text-sm tabular-nums text-muted">Conviction {Math.round(note.conviction * 100)}</p>
      )}
      {note.summary && <Prose text={note.summary} />}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <PointList title="For" items={note.bullPoints} />
        <PointList title="Against" items={note.bearPoints} />
      </div>
      {note.disagreements.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs tracking-wide text-muted">Still open</h3>
          <ul className="mt-2 space-y-3">
            {note.disagreements.map((row) => (
              <li key={row.topic} className="border-t border-line pt-3">
                <p className="text-sm font-medium">{row.topic}</p>
                {row.bull && <p className="mt-1 text-sm leading-relaxed"><span className="text-pine">Bull. </span>{row.bull}</p>}
                {row.bear && <p className="mt-1 text-sm leading-relaxed"><span className="text-accent">Bear. </span>{row.bear}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {note.openQuestions.length > 0 && (
        <ul className="mt-4 space-y-1">
          {note.openQuestions.map((question) => (
            <li key={question} className="text-sm text-muted">{question}</li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-muted">Answered by {model}</p>
    </section>
  );
}

function PointList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs tracking-wide text-muted">{title}</h3>
      <ul className="mt-1 space-y-1">
        {items.map((item) => (
          <li key={item} className="text-sm leading-relaxed">{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Seat({ note, fallback }: { note: SeatNote | null; fallback: string }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-2xl capitalize">{note?.title || fallback}</h3>
        {note?.confidence != null && (
          <p className="text-xs tabular-nums text-muted">Confidence {Math.round(note.confidence * 100)}</p>
        )}
      </div>
      {!note && <p className="mt-2 text-sm text-muted">This seat did not write a note.</p>}
      {note?.summary && <p className="mt-3 max-w-3xl text-sm font-medium leading-relaxed">{note.summary}</p>}
      {note?.argument && <Prose text={note.argument} />}
      {note && note.points.length > 0 && (
        <ul className="mt-4 max-w-3xl space-y-2">
          {note.points.map((point) => (
            <li key={point} className="text-sm leading-relaxed text-muted">{point}</li>
          ))}
        </ul>
      )}
      {note?.verdict && <p className="mt-4 text-sm font-medium">{note.verdict}</p>}
    </section>
  );
}

function Prose({ text }: { text: string }) {
  const paragraphs = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return (
    <div className="mt-3 max-w-3xl space-y-3">
      {paragraphs.map((paragraph) => (
        <p key={paragraph.slice(0, 48)} className="text-sm leading-relaxed">{paragraph}</p>
      ))}
    </div>
  );
}
