import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

type FilingRow = { form: string; date: string; reportDate: string; items: string; url: string }
type HeadlineRow = {
  title: string
  link: string
  published: string
  source: string
  sourceUrl: string
  kind: "ir" | "news"
}

export type StoredNote = {
  digest: string
  thesis: string
  analysis: string
  risks: string
  gaps: string
  model: string
  createdAt: string
}

let db: DatabaseSync | null = null

function database() {
  if (db) return db
  const dir = process.env.MOLE_DATA || join(process.cwd(), "data")
  mkdirSync(dir, { recursive: true })
  db = new DatabaseSync(join(dir, "mole.sqlite"))
  db.exec(`
    CREATE TABLE IF NOT EXISTS filings (
      ticker TEXT NOT NULL,
      form TEXT NOT NULL,
      filed TEXT NOT NULL,
      report_date TEXT NOT NULL,
      items TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (ticker, url)
    );
    CREATE TABLE IF NOT EXISTS headlines (
      ticker TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      published TEXT NOT NULL,
      published_at TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (ticker, link)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      model TEXT NOT NULL,
      digest TEXT NOT NULL,
      thesis TEXT NOT NULL,
      analysis TEXT NOT NULL,
      risks TEXT NOT NULL,
      gaps TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coverage (
      ticker TEXT PRIMARY KEY,
      filings_done INTEGER NOT NULL DEFAULT 0,
      news_done INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS notes_ticker ON notes (ticker, id DESC);
  `)
  return db
}

export function filingBackfillDone(ticker: string) {
  const row = database().prepare("SELECT filings_done FROM coverage WHERE ticker = ?").get(ticker) as
    | { filings_done: number }
    | undefined
  return Boolean(row?.filings_done)
}

export function newsBackfillDone(ticker: string) {
  const row = database().prepare("SELECT news_done FROM coverage WHERE ticker = ?").get(ticker) as
    | { news_done: number }
    | undefined
  return Boolean(row?.news_done)
}

export function markFilingBackfill(ticker: string) {
  database()
    .prepare(
      `INSERT INTO coverage (ticker, filings_done, news_done) VALUES (?, 1, 0)
       ON CONFLICT(ticker) DO UPDATE SET filings_done = 1`,
    )
    .run(ticker)
}

export function markNewsBackfill(ticker: string) {
  database()
    .prepare(
      `INSERT INTO coverage (ticker, filings_done, news_done) VALUES (?, 0, 1)
       ON CONFLICT(ticker) DO UPDATE SET news_done = 1`,
    )
    .run(ticker)
}

export function saveFilings(ticker: string, filings: FilingRow[]) {
  const insert = database().prepare(
    `INSERT INTO filings (ticker, form, filed, report_date, items, url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, url) DO UPDATE SET
       form = excluded.form,
       filed = excluded.filed,
       report_date = excluded.report_date,
       items = excluded.items`,
  )
  database().exec("BEGIN")
  try {
    for (const filing of filings) {
      if (!filing.url) continue
      insert.run(ticker, filing.form, filing.date, filing.reportDate, filing.items, filing.url)
    }
    database().exec("COMMIT")
  } catch (error) {
    database().exec("ROLLBACK")
    throw error
  }
}

export function saveHeadlines(ticker: string, headlines: HeadlineRow[]) {
  const insert = database().prepare(
    `INSERT INTO headlines (ticker, title, link, published, published_at, source, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, link) DO UPDATE SET
       title = excluded.title,
       published = excluded.published,
       published_at = excluded.published_at,
       source = excluded.source,
       kind = excluded.kind`,
  )
  database().exec("BEGIN")
  try {
    for (const item of headlines) {
      const link = item.link || `title:${item.title.slice(0, 180)}`
      const parsed = Date.parse(item.published)
      const publishedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : item.published
      insert.run(ticker, item.title, link, item.published, publishedAt, item.source, item.kind)
    }
    database().exec("COMMIT")
  } catch (error) {
    database().exec("ROLLBACK")
    throw error
  }
}

export function recentFilings(ticker: string, limit: number): FilingRow[] {
  const rows = database()
    .prepare(
      `SELECT form, filed, report_date, items, url FROM filings
       WHERE ticker = ? ORDER BY filed DESC LIMIT ?`,
    )
    .all(ticker, limit) as { form: string; filed: string; report_date: string; items: string; url: string }[]
  return rows.map((row) => ({
    form: row.form,
    date: row.filed,
    reportDate: row.report_date,
    items: row.items,
    url: row.url,
  }))
}

export function recentHeadlines(ticker: string, limit: number): HeadlineRow[] {
  const rows = database()
    .prepare(
      `SELECT title, link, published, source, kind FROM headlines
       WHERE ticker = ? ORDER BY published_at DESC LIMIT ?`,
    )
    .all(ticker, limit) as { title: string; link: string; published: string; source: string; kind: string }[]
  return rows.map((row) => ({
    title: row.title,
    link: row.link.startsWith("title:") ? "" : row.link,
    published: row.published,
    source: row.source,
    sourceUrl: "",
    kind: row.kind === "ir" ? "ir" : "news",
  }))
}

export function archiveCounts(ticker: string) {
  const filings = database().prepare("SELECT COUNT(*) AS n FROM filings WHERE ticker = ?").get(ticker) as { n: number }
  const headlines = database().prepare("SELECT COUNT(*) AS n FROM headlines WHERE ticker = ?").get(ticker) as {
    n: number
  }
  return { filings: filings.n, headlines: headlines.n }
}

export function latestNote(ticker: string): StoredNote | null {
  const row = database()
    .prepare(
      `SELECT model, digest, thesis, analysis, risks, gaps, created_at
       FROM notes WHERE ticker = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(ticker) as
    | {
        model: string
        digest: string
        thesis: string
        analysis: string
        risks: string
        gaps: string
        created_at: string
      }
    | undefined
  if (!row) return null
  return {
    model: row.model,
    digest: row.digest,
    thesis: row.thesis,
    analysis: row.analysis,
    risks: row.risks,
    gaps: row.gaps,
    createdAt: row.created_at,
  }
}

export function saveNote(
  ticker: string,
  note: { model: string; digest: string; thesis: string; analysis: string; risks: string; gaps: string },
) {
  database()
    .prepare(
      `INSERT INTO notes (ticker, model, digest, thesis, analysis, risks, gaps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticker,
      note.model,
      note.digest,
      note.thesis,
      note.analysis,
      note.risks,
      note.gaps,
      new Date().toISOString(),
    )
}

