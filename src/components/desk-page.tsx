import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { findCompany, universe, type UniverseRow } from "@/data/universe";
import { listArchiveFn, loadArchiveFn, readBoardsFn, readTapeFn, runDebateFn } from "@/lib/debate.functions";
import type { CompanyInfo, DebateResult, DeskBoards, Headline, JudgeNote, SeatNote, Tape } from "@/lib/debate-types";
import { finalNote } from "@/lib/final-note.mjs";
import { safeHttpUrl, tryNormalizeYahooTicker } from "@/lib/yahoo-ticker.mjs";

const STORE = "mole-intel-debates";
const SEAT_ORDER = ["news", "bull", "bear", "valuation", "earnings", "analyst"] as const;

const SEAT_LABEL: Record<(typeof SEAT_ORDER)[number], string> = {
  news: "News",
  bull: "Bull",
  bear: "Bear",
  valuation: "Valuation",
  earnings: "Earnings",
  analyst: "Analyst ratings",
};

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

function ratioPct(value: number | null): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function multiple(value: number | null): string {
  if (value == null) return "—";
  return value.toFixed(1);
}

function compactMoney(value: number | null): string {
  if (value == null) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}

function normalize(row: DebateResult): DebateResult {
  return {
    ...row,
    company: row.company ?? null,
    news: Array.isArray(row.news) ? row.news : [],
    errors: Array.isArray(row.errors) ? row.errors : [],
  };
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
    return Array.isArray(parsed) ? parsed.slice(0, 12).map(normalize) : [];
  } catch {
    return [];
  }
}

export function DeskPage({ routeTicker }: { routeTicker?: string }) {
  const readTape = useServerFn(readTapeFn);
  const runDebate = useServerFn(runDebateFn);
  const listArchive = useServerFn(listArchiveFn);
  const loadArchive = useServerFn(loadArchiveFn);
  const readBoards = useServerFn(readBoardsFn);
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
  const [boards, setBoards] = useState<DeskBoards | null>(null);
  const [boardState, setBoardState] = useState<"loading" | "ready" | "error">("loading");
  const navigate = useNavigate();
  const request = useRef(0);
  const routeSymbol = useMemo(() => (routeTicker ? tryNormalizeYahooTicker(routeTicker) : null), [routeTicker]);
  const tickerRejected = Boolean(routeTicker) && !routeSymbol;

  function showList(hits: { ticker: string; call: string }[]) {
    const fromFile: Listed[] = hits.map((hit) => {
      const known = findCompany(hit.ticker) ?? universe.find((row) => row.ticker === hit.ticker);
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
    if (routeTicker) return;
    listArchive({ data: {} })
      .then(showList)
      .catch(() => setSaved(loadSaved().map(listedFrom)));
    setBoardState("loading");
    readBoards({ data: {} })
      .then((value) => {
        setBoards(value);
        setBoardState("ready");
      })
      .catch(() => setBoardState("error"));
    // Load the desk lists once. The server functions are stable enough for this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeTicker]);

  useEffect(() => {
    if (!routeTicker || !routeSymbol || routeSymbol === routeTicker) return;
    void navigate({ to: "/t/$ticker", params: { ticker: routeSymbol }, replace: true });
  }, [navigate, routeSymbol, routeTicker]);

  useEffect(() => {
    if (!routeSymbol) {
      setSelected(null);
      setTape(null);
      setDebate(null);
      setDeskState("idle");
      setDeskError("");
      setTapeState("idle");
      return;
    }
    const row = findCompany(routeSymbol) ?? {
      ticker: routeSymbol,
      name: routeSymbol,
      sector: "Unlisted",
      index: "Tape",
    };
    const ticket = ++request.current;
    setSelected(row);
    setTape(null);
    setDebate(loadSaved().find((item) => item.ticker === routeSymbol) ?? null);
    setDeskState("idle");
    setDeskError("");
    setTapeState("loading");
    loadArchive({ data: { ticker: routeSymbol } })
      .then((value) => {
        if (ticket !== request.current) return;
        if (value) {
          setDebate((current) => (current?.source === "desk" && current.ticker === routeSymbol ? current : value));
          return;
        }
        void startDesk(routeSymbol, ticket);
      })
      .catch(() => {
        if (ticket !== request.current) return;
        void startDesk(routeSymbol, ticket);
      });
    readTape({ data: { ticker: routeSymbol } })
      .then((value) => {
        if (ticket !== request.current) return;
        setTape(value);
        setTapeState("idle");
        if (value.name && value.name !== routeSymbol) {
          setSelected((current) => (current?.ticker === routeSymbol ? { ...current, name: value.name } : current));
        }
      })
      .catch(() => {
        if (ticket !== request.current) return;
        setTapeState("error");
      });
    // Fetch when the ticker in the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSymbol]);

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

  function go(ticker: string) {
    const symbol = tryNormalizeYahooTicker(ticker);
    if (!symbol) return;
    setQuery("");
    setSearchOpen(false);
    void navigate({ to: "/t/$ticker", params: { ticker: symbol } });
  }

  async function startDesk(ticker?: string, ticket = request.current) {
    const symbol = ticker ?? selected?.ticker;
    if (!symbol) return;
    setDeskState("loading");
    setDeskError("");
    try {
      const value = await runDebate({ data: { ticker: symbol } });
      if (ticket !== request.current) return;
      setDebate(value);
      if (value.tape.price != null) {
        setTape((current) => ({
          ...value.tape,
          stories: value.tape.stories?.length ? value.tape.stories : current?.stories,
          headlines: value.tape.headlines.length ? value.tape.headlines : (current?.headlines ?? []),
        }));
      }
      remember(value);
      setDeskState(value.judge ? "idle" : "error");
      if (!value.judge) setDeskError(value.errors[0] || "The judge did not write a note.");
    } catch (error) {
      if (ticket !== request.current) return;
      setDeskState("error");
      setDeskError(error instanceof Error ? error.message : "The desk did not answer.");
    }
  }

  const normalized = tryNormalizeYahooTicker(query);
  const qualified = /[:./\s]/.test(query.trim());
  const exactMatch = Boolean(normalized && matches.some((row) => row.ticker === normalized));
  const showNormalized = Boolean(normalized) && !exactMatch && (qualified || matches.length === 0);

  return (
    <main className="min-h-screen bg-bg text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 py-3 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Link to="/" aria-label="Mole Intel, back to the desk" className="flex shrink-0 items-center gap-2 text-ink no-underline">
            <img src="/favicon.svg" alt="" width={32} height={32} className="h-8 w-8" />
            <span className="hidden font-display text-xl sm:inline">Mole Intel</span>
          </Link>
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
                if (event.key !== "Enter") return;
                if (qualified && normalized) go(normalized);
                else if (matches[0]) go(matches[0].ticker);
                else if (normalized) go(normalized);
              }}
              placeholder="Ticker or company"
              aria-label="Ticker or company"
              className="min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm outline-none"
            />
            {searchOpen && query.trim() && (
              <ul className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-card border border-line bg-surface shadow-sm">
                {matches.length === 0 && !showNormalized && (
                  <li className="px-3 py-3 text-sm text-muted">No company in the desk list.</li>
                )}
                {matches.map((row) => (
                  <li key={row.ticker}>
                    <Link
                      to="/t/$ticker"
                      params={{ ticker: row.ticker }}
                      onMouseDown={(event) => event.preventDefault()}
                      className="flex min-h-11 w-full items-baseline gap-2 px-3 text-left text-ink no-underline hover:bg-chip"
                    >
                      <span className="font-medium">{row.ticker}</span>
                      <span className="truncate text-sm text-muted">{row.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted">{row.index}</span>
                    </Link>
                  </li>
                ))}
                {showNormalized && normalized && (
                  <li>
                    <Link
                      to="/t/$ticker"
                      params={{ ticker: normalized }}
                      onMouseDown={(event) => event.preventDefault()}
                      className="flex min-h-11 w-full items-baseline gap-2 px-3 text-left text-ink no-underline hover:bg-chip"
                    >
                      <span className="font-medium">{normalized}</span>
                      <span className="text-sm text-muted">Open this ticker</span>
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8">
        {!routeSymbol && !tickerRejected && (
          <Empty saved={saved} archive={fromArchive} boards={boards} boardState={boardState} />
        )}
        {tickerRejected && (
          <p className="max-w-xl pt-6 text-sm text-accent">
            That is not a Yahoo Finance ticker. Try NVDA, BRK-B, SHOP.TO, SHEL.L, or 7203.T.
          </p>
        )}
        {selected && routeSymbol && (
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
  boards,
  boardState,
}: {
  saved: Listed[];
  archive: boolean;
  boards: DeskBoards | null;
  boardState: "loading" | "ready" | "error";
}) {
  return (
    <section className="pt-6">
      <p className="text-xs tracking-wide text-muted">The desk</p>
      <h1 className="max-w-3xl font-display text-4xl leading-tight sm:text-5xl">Six seats. One reads the news. The judge reads the macro tape.</h1>
      <p className="mt-4 max-w-xl text-base text-muted">
        Search a company, or start from the largest names, the bullish calls, and whatever just hit the wires.
      </p>
      {boardState === "loading" && <p className="mt-8 text-sm text-muted">Reading the lists…</p>}
      {boardState === "error" && <p className="mt-8 text-sm text-accent">The lists did not come back.</p>}
      {boards && (
        <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-3">
          <Board title="Largest" hint="Market cap" rows={boards.largest} empty="No market-cap print." />
          <Board title="Most bullish" hint="The judge, then fresh upgrades" rows={boards.bullish} empty="No bullish names yet." />
          <Board title="Breaking" hint="Named in today's wires" rows={boards.news} empty="No company in the latest wires." />
        </div>
      )}
      {saved.length > 0 && (
        <div className="mt-10 max-w-2xl">
          <h2 className="text-xs tracking-wide text-muted">{archive ? "Already sat" : "Saved on this browser"}</h2>
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {saved.map((row) => (
              <li key={row.ticker}>
                <Link
                  to="/t/$ticker"
                  params={{ ticker: row.ticker }}
                  className="flex min-h-11 w-full items-baseline gap-3 py-2 text-left text-ink no-underline"
                >
                  <span className="font-medium">{row.ticker}</span>
                  <span className="truncate text-sm text-muted">{row.name}</span>
                  <span className="ml-auto text-xs capitalize text-muted">{row.call || "unread"}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Board({
  title,
  hint,
  rows,
  empty,
}: {
  title: string;
  hint: string;
  rows: DeskBoards["largest"];
  empty: string;
}) {
  return (
    <section className="min-w-0">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="text-xs tracking-wide text-muted">{hint}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 min-w-0 divide-y divide-line border-y border-line">
          {rows.map((row) => {
            const long = row.detail.length > 28;
            return (
              <li key={`${title}-${row.ticker}`} className="min-w-0">
                <div className="flex min-w-0 items-start gap-2 py-2">
                  <Link
                    to="/t/$ticker"
                    params={{ ticker: row.ticker }}
                    className="block min-h-11 min-w-0 flex-1 overflow-hidden text-ink no-underline"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-medium">{row.ticker}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted">{row.name}</span>
                      {!long && <span className="shrink-0 text-sm">{row.detail}</span>}
                    </span>
                    {long && <span className="mt-0.5 block truncate text-sm">{row.detail}</span>}
                  </Link>
                  {row.url && (
                    <a href={row.url} target="_blank" rel="noreferrer" className="mt-1 shrink-0 text-xs text-muted underline">
                      Source
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
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
        {company.ticker} · {debate?.company?.industry || company.sector}
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4">
        <Fact label="Last" value={shown ? money(shown.price) : "—"} hint={shown?.currency ?? ""} />
        <Fact label="Day" value={shown ? pct(shown.changePct) : "—"} className={toneClass(shown?.changePct ?? null)} />
        <Fact label="3 months" value={shown ? pct(shown.return3mPct) : "—"} className={toneClass(shown?.return3mPct ?? null)} />
        <Fact label="Wires" value={shown ? String(shown.stories?.length || shown.headlines.length) : "—"} hint="headlines" />
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
          {deskState === "loading" ? "The desk is sitting…" : debate ? "Run it again on the 3080" : "Sit the desk"}
        </button>
        <p className="text-xs text-muted">
          {debate?.source === "archive"
            ? `Already in the archive${debate.asOf ? `, ${debate.asOf.slice(0, 16).replace("T", " ")} UTC` : ""}.`
            : "A ticker with no note runs as soon as you open it."}
        </p>
      </div>
      {deskState === "loading" && (
        <p className="mt-4 text-sm text-muted">Reading the tape, the wires, and the filings. The news seat digests the headlines, then the judge. A first pass takes a few minutes.</p>
      )}
      {deskError && <p className="mt-4 text-sm text-accent">{deskError}</p>}

      {debate && <Desk debate={debate} live={tape?.stories ?? []} />}
      {!debate && (tape?.stories?.length ?? 0) > 0 && (
        <div className="mt-8">
          <NewsList items={tape?.stories ?? []} />
        </div>
      )}
    </article>
  );
}

function Fact({
  label,
  value,
  hint,
  className,
  small,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
  small?: boolean;
}) {
  return (
    <div className="bg-surface px-3 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 font-display tabular-nums ${small ? "text-base leading-snug" : "text-2xl"} ${className ?? "text-ink"}`}>
        {value}
      </dd>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function Desk({ debate, live }: { debate: DebateResult; live: Headline[] }) {
  const archived: Headline[] = debate.news.length
    ? debate.news
    : debate.tape.stories?.length
      ? debate.tape.stories
      : debate.tape.headlines.map((title) => ({ title, source: "", published: null }));
  const byTitle = new Map(live.filter((item) => item.url).map((item) => [item.title, item]));
  const wires = archived.map((item) => {
    if (safeHttpUrl(item.url)) return item;
    const hit = byTitle.get(item.title);
    return hit?.url ? { ...item, url: hit.url, source: item.source || hit.source } : item;
  });
  return (
    <div className="mt-8 space-y-8">
      {debate.company && <CompanySheet info={debate.company} />}
      {debate.judge && <Judge note={debate.judge} model={debate.model} />}
      <section>
        <h2 className="text-xs tracking-wide text-muted">The seats</h2>
        <div className="mt-3 space-y-3">
          {SEAT_ORDER.map((key) => (
            <Seat key={key} note={debate.seats[key] ?? null} label={SEAT_LABEL[key]} wires={key === "news" ? wires : undefined} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CompanySheet({ info }: { info: CompanyInfo }) {
  return (
    <section>
      <h2 className="text-xs tracking-wide text-muted">The company</h2>
      <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4">
        <Fact label="Market cap" value={compactMoney(info.marketCap)} />
        <Fact label="Trail P/E" value={multiple(info.trailingPe)} />
        <Fact label="Fwd P/E" value={multiple(info.forwardPe)} />
        <Fact label="P/B" value={multiple(info.priceToBook)} />
        <Fact label="EV/EBITDA" value={multiple(info.evEbitda)} />
        <Fact label="ROE" value={ratioPct(info.roe)} />
        <Fact label="FCF yield" value={ratioPct(info.fcfYield)} />
        <Fact label="Target" value={info.targetMean == null ? "—" : `$${money(info.targetMean)}`} />
        <Fact label="52w high" value={info.high52 == null ? "—" : `$${money(info.high52)}`} />
        <Fact label="52w low" value={info.low52 == null ? "—" : `$${money(info.low52)}`} />
        <Fact label="1 month" value={pct(info.return1mPct)} className={toneClass(info.return1mPct)} />
        <Fact label="Industry" value={info.industry || "—"} small />
      </dl>
    </section>
  );
}

function NewsList({ items }: { items: Headline[] }) {
  return (
    <section>
      <h2 className="text-xs tracking-wide text-muted">The wires</h2>
      <ul className="mt-2 divide-y divide-line border-y border-line">
        {items.map((item) => {
          const href = safeHttpUrl(item.url);
          return (
            <li key={`${item.url || item.source}-${item.title}`} className="py-3">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm leading-relaxed text-ink underline decoration-line underline-offset-2"
                >
                  {item.title}
                </a>
              ) : (
                <p className="text-sm leading-relaxed">{item.title}</p>
              )}
              {(item.source || item.published) && (
                <p className="mt-1 text-xs text-muted">
                  {[item.source, item.published?.slice(0, 10)].filter(Boolean).join(" · ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
      {note.summary && <Markdown text={note.summary} />}
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
                <p className="text-sm font-medium">{inline(row.topic)}</p>
                {row.bull && <p className="mt-1 text-sm leading-relaxed"><span className="text-pine">Bull. </span>{inline(row.bull)}</p>}
                {row.bear && <p className="mt-1 text-sm leading-relaxed"><span className="text-accent">Bear. </span>{inline(row.bear)}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {note.openQuestions.length > 0 && (
        <ul className="mt-4 space-y-1">
          {note.openQuestions.map((question) => (
            <li key={question} className="text-sm text-muted">{inline(question)}</li>
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
          <li key={item} className="text-sm leading-relaxed">{inline(item)}</li>
        ))}
      </ul>
    </div>
  );
}

function Seat({ note, label, wires }: { note: SeatNote | null; label: string; wires?: Headline[] }) {
  const isNews = label === "News";
  return (
    <section className="rounded-card border border-line bg-surface p-4 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-2xl">{label}</h3>
        {note?.confidence != null && (
          <p className="text-xs tabular-nums text-muted">Confidence {Math.round(note.confidence * 100)}</p>
        )}
      </div>
      {isNews && <p className="mt-1 text-xs text-muted">What the headlines change in the fundamentals</p>}
      {!note && (
        <p className="mt-2 text-sm text-muted">
          {isNews ? "No news note in this pass. Run the desk again so this seat can read the wires." : "This seat did not write a note."}
        </p>
      )}
      {note?.summary && <Markdown text={note.summary} />}
      {note?.argument && <Markdown text={note.argument} />}
      {note && note.points.length > 0 && (
        <ul className="mt-4 max-w-3xl list-disc space-y-2 pl-5">
          {note.points.map((point) => (
            <li key={point} className="text-sm leading-relaxed text-muted">{inline(point)}</li>
          ))}
        </ul>
      )}
      {note?.verdict && <Markdown text={note.verdict} />}
      {isNews && wires && wires.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {wires.map((item) => {
            const href = safeHttpUrl(item.url);
            return (
              <li key={`${item.url || item.source}-${item.title}`} className="py-3">
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm leading-relaxed text-ink underline decoration-line underline-offset-2">
                    {item.title}
                  </a>
                ) : (
                  <p className="text-sm leading-relaxed">{item.title}</p>
                )}
                {(item.source || item.published) && (
                  <p className="mt-1 text-xs text-muted">{[item.source, item.published?.slice(0, 10)].filter(Boolean).join(" · ")}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(finalNote(text));
  if (blocks.length === 0) return null;
  return (
    <div className="mt-3 max-w-3xl space-y-3 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        if (block.kind === "h") {
          const className = block.level === 1 ? "font-display text-xl text-ink" : "font-medium text-ink";
          return block.level === 1 ? (
            <h3 key={index} className={className}>{inline(block.text)}</h3>
          ) : (
            <h4 key={index} className={className}>{inline(block.text)}</h4>
          );
        }
        if (block.kind === "ul" || block.kind === "ol") {
          const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>);
          return block.kind === "ul" ? (
            <ul key={index} className="list-disc space-y-1 pl-5">{items}</ul>
          ) : (
            <ol key={index} className="list-decimal space-y-1 pl-5">{items}</ol>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}

function parseMarkdown(raw: string): Array<{ kind: "p"; text: string } | { kind: "h"; level: number; text: string } | { kind: "ul" | "ol"; items: string[] }> {
  const trimmed = raw.trim().replace(/^```[a-zA-Z]*\n([\s\S]*?)```$/m, "$1").trim();
  const lines = trimmed.split(/\n/);
  const blocks: Array<{ kind: "p"; text: string } | { kind: "h"; level: number; text: string } | { kind: "ul" | "ol"; items: string[] }> = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ kind: "p", text });
    paragraph = [];
  };
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      flush();
      continue;
    }
    const heading = trimmedLine.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
      continue;
    }
    const bullet = trimmedLine.match(/^[-*]\s+(.+)$/);
    const numbered = trimmedLine.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const item = (bullet || numbered)?.[1] ?? "";
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    paragraph.push(trimmedLine);
  }
  flush();
  return blocks;
}

function inline(text: string) {
  const nodes: Array<string | { mark: "strong" | "em" | "code"; text: string }> = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    if (match[1] || match[2]) nodes.push({ mark: "strong", text: match[1] || match[2] });
    else if (match[3]) nodes.push({ mark: "code", text: match[3] });
    else if (match[4]) nodes.push({ mark: "em", text: match[4] });
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.map((node, index) => {
    if (typeof node === "string") return <span key={index}>{node}</span>;
    if (node.mark === "strong") return <strong key={index} className="font-medium text-ink">{node.text}</strong>;
    if (node.mark === "code") return <code key={index} className="rounded bg-bg px-1 text-[0.92em]">{node.text}</code>;
    return <em key={index}>{node.text}</em>;
  });
}
