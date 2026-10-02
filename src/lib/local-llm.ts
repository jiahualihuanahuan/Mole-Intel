import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createServerFn } from "@tanstack/react-start"
import type { CompanyBrief } from "@/lib/intel.functions"
import { saveNote } from "@/lib/store"

export const DEFAULT_ENDPOINT = "http://192.168.86.35:11434/v1"
export const DEFAULT_MODEL = "qwen3.5:9b"

export type LocalReview = {
  digest: string
  thesis: string
  analysis: string
  risks: string
  gaps: string
  model: string
}

function stripThink(raw: string) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .trim()
}

function scoreFrom(body: string, model: string): LocalReview | null {
  const objects: string[] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < body.length; j++) {
      const char = body[j]
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === "{") depth += 1
      else if (char === "}") {
        depth -= 1
        if (depth === 0) {
          objects.push(body.slice(i, j + 1))
          break
        }
      }
    }
  }
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(objects[i]) as {
        digest?: unknown
        summary?: unknown
        thesis?: unknown
        view?: unknown
        analysis?: unknown
        note?: unknown
        body?: unknown
        risks?: unknown
        gaps?: unknown
      }
      const digest = parsed?.digest ?? parsed?.summary
      const thesis = parsed?.thesis ?? parsed?.view
      const analysis = parsed?.analysis ?? parsed?.note ?? parsed?.body
      if (!parsed || typeof parsed !== "object" || (digest == null && thesis == null && analysis == null)) continue
      return {
        digest: String(digest || "").slice(0, 1200),
        thesis: String(thesis || "").slice(0, 500),
        analysis: String(analysis || "").slice(0, 8000),
        risks: String(parsed.risks || "").slice(0, 1200),
        gaps: String(parsed.gaps || "").slice(0, 800),
        model,
      }
    } catch {
      continue
    }
  }
  return null
}

export function parseLocalReview(raw: string, model: string): LocalReview {
  const found = readScore(raw, model)
  return (
    found ?? {
      digest: "",
      thesis: "",
      analysis: stripThink(raw).slice(0, 4000) || "The model returned no analysis.",
      risks: "",
      gaps: "",
      model,
    }
  )
}

function readScore(raw: string, model: string): LocalReview | null {
  const withoutThink = stripThink(raw)
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/)
  const bodies = fenced?.[1] ? [fenced[1], withoutThink] : [withoutThink]
  for (const source of bodies) {
    const found = scoreFrom(source, model)
    if (found) return found
  }
  return null
}

const ANALYST =
  "You are a senior buy-side equity analyst. Keep the reasoning in the thinking channel. The reply itself must be one JSON object and nothing else: {\"digest\":\"string\",\"thesis\":\"string\",\"analysis\":\"string\",\"risks\":\"string\",\"gaps\":\"string\"}. Use only the packet. Do not invent numbers or a price target. Never write a thinking process, a numbered plan, or a restatement of these instructions. digest is what the recent filings and headlines say. thesis is the variant view, or a clear statement that the packet is too thin. analysis is the deep note. risks is what could be wrong. gaps is what is still missing."

const FINAL =
  "Output one JSON object and nothing else. Keys are digest, thesis, analysis, risks, gaps. No title, no thinking process, no preamble. Use only the packet. Do not invent numbers or a price target. digest is what the recent filings and headlines say. thesis is the view, or that the packet is too thin. analysis is the deep buy-side note. risks is what could be wrong. gaps is what is missing."

function looksLikeScratch(text: string) {
  return /thinking process|analyze the request|\*\*role:\*\*|\*\*task:\*\*/i.test(text.slice(0, 600))
}

function proseNote(raw: string, model: string): LocalReview | null {
  let text = stripThink(raw).trim()
  const marker = text.search(/\n(?:final answer|final note|buy-side note)\b/i)
  if (marker >= 0) text = text.slice(marker).replace(/^(?:final answer|final note|buy-side note)\b[:\s]*/i, "").trim()
  if (!text || looksLikeScratch(text)) return null
  if (text.length < 80) return null
  return { digest: "", thesis: "", analysis: text.slice(0, 8000), risks: "", gaps: "", model }
}

function reviewFrom(content: string, thought: string, model: string) {
  return readScore(content, model) ?? readScore(`${content}\n${thought}`, model) ?? proseNote(content, model)
}

function explainFetch(error: unknown, target: string) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `Ollama at ${target} was still generating when the desk stopped waiting.`
  }
  const cause = error instanceof Error ? error.cause : undefined
  const code =
    cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : ""
  const detail = error instanceof Error ? error.message : "request failed"
  return `The desk could not finish the call to ${target}${code ? ` (${code})` : ""}. ${detail}`
}

function textFrom(payload: unknown) {
  if (!payload || typeof payload !== "object") return { content: "", thought: "" }
  const record = payload as {
    message?: { content?: string; thinking?: string }
    choices?: { message?: { content?: string; reasoning?: string; thinking?: string } }[]
  }
  if (record.message) {
    return { content: record.message.content ?? "", thought: record.message.thinking ?? "" }
  }
  const message = record.choices?.[0]?.message
  return { content: message?.content ?? "", thought: message?.reasoning || message?.thinking || "" }
}

async function complete(root: string, model: string, packet: unknown, signal: AbortSignal, think: boolean) {
  const url = new URL(root)
  const origin = `${url.protocol}//${url.host}`
  const messages = [
    { role: "system", content: think ? ANALYST : FINAL },
    { role: "user", content: JSON.stringify(packet) },
  ]
  const native = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      think,
      messages,
      options: { temperature: 0.2, num_predict: think ? 8192 : 2500 },
    }),
  })
  if (native.status !== 404) return native
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      think,
      temperature: 0.2,
      max_tokens: think ? 8192 : 2500,
      messages,
    }),
  })
}

async function readModelReply(
  response: Response,
  model: string,
): Promise<{ ok: true; review: LocalReview | null } | { ok: false; error: string }> {
  let raw = ""
  try {
    raw = await response.text()
  } catch (error) {
    return { ok: false, error: explainFetch(error, "Ollama") }
  }
  if (!response.ok) {
    return { ok: false, error: `Ollama returned ${response.status}. ${raw.replace(/\s+/g, " ").slice(0, 240)}` }
  }
  try {
    const { content, thought } = textFrom(JSON.parse(raw) as unknown)
    return { ok: true, review: reviewFrom(content, thought, model) }
  } catch {
    return { ok: true, review: proseNote(raw, model) }
  }
}

type NoteResult = { ok: true; review: LocalReview } | { ok: false; error: string }

async function writeNote(
  data: {
    endpoint: string
    model: string
    brief: {
      name: string
      ticker: string
      entity: string
      filings: { form: string; date: string; url: string }[]
      headlines: { kind: "ir" | "news"; title: string; source: string; published: string }[]
    }
  },
  signal: AbortSignal,
): Promise<NoteResult> {
  const root = data.endpoint.replace(/\/$/, "")
  if (!/^https?:\/\//i.test(root)) {
    return { ok: false, error: "The model address must start with http:// or https://" }
  }
  const packet = {
    company: data.brief.name,
    ticker: data.brief.ticker,
    entity: data.brief.entity,
    filings: data.brief.filings.map((item) => `${item.form} ${item.date}`),
    headlines: data.brief.headlines,
  }
  const model = data.model || DEFAULT_MODEL
  const targets = [root]
  try {
    const url = new URL(root)
    if (url.hostname === "192.168.86.35") {
      url.hostname = "host.docker.internal"
      targets.push(url.toString().replace(/\/$/, ""))
    }
  } catch {
    return { ok: false, error: "The model address is not a valid URL" }
  }
  let response: Response | null = null
  let used = root
  let failure = `The desk could not reach ${root}.`
  for (const target of targets) {
    try {
      response = await complete(target, model, packet, signal, true)
      used = target
      break
    } catch (error) {
      response = null
      failure = explainFetch(error, target)
    }
  }
  if (!response) return { ok: false, error: failure }
  const first = await readModelReply(response, model)
  if (!first.ok) return first
  let review = first.review
  if (!review) {
    try {
      response = await complete(used, model, packet, signal, false)
    } catch (error) {
      return { ok: false, error: explainFetch(error, used) }
    }
    const second = await readModelReply(response, model)
    if (!second.ok) return second
    review = second.review
  }
  if (!review) return { ok: false, error: "Ollama did not write the note." }
  return { ok: true, review }
}

type NoteJob = {
  at: number
  ticker: string
  status: "pending" | "done" | "error"
  review?: LocalReview
  error?: string
  child?: ChildProcess
}

const jobs = new Map<string, NoteJob>()

function workerPath() {
  const candidates = ["/app/ollama-note.mjs", join(process.cwd(), "scripts/ollama-note.mjs")]
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new Error("The model worker is not in the image.")
  return found
}

function finishJob(id: string, result: { ok: true; review: LocalReview } | { ok: false; error: string }) {
  const current = jobs.get(id)
  if (!current || current.status !== "pending") return
  if (result.ok) {
    current.status = "done"
    current.review = result.review
    try {
      saveNote(current.ticker, result.review)
    } catch {
      // The note still returns to the page if the archive is not writable.
    }
    return
  }
  current.status = "error"
  current.error = result.error
}

function spawnNote(
  id: string,
  data: {
    endpoint: string
    model: string
    brief: {
      name: string
      ticker: string
      entity: string
      filings: { form: string; date: string; reportDate?: string; items?: string }[]
      facts?: { label: string; unit: string; points: string[] }[]
      headlines: { kind: string; title: string; source: string; published: string }[]
      profile?: {
        sic?: string
        website?: string
        summary?: string
        founded?: string
        employees?: string
        pages?: { label: string; text: string }[]
        peers?: string[]
        jobs?: { title: string; team: string; location: string }[]
        jobTotal?: number
      }
    }
  },
) {
  const job = jobs.get(id)
  if (!job) return
  const packet = {
    company: data.brief.name,
    ticker: data.brief.ticker,
    headlines: data.brief.headlines,
    openRoles: (data.brief.profile?.jobs ?? []).map((role) => ({
      title: role.title,
      team: role.team,
      location: role.location,
    })),
    roleCount: data.brief.profile?.jobTotal || data.brief.profile?.jobs?.length || 0,
  }
  let child: ChildProcess
  try {
    child = spawn(process.execPath, [workerPath()], { stdio: ["pipe", "pipe", "pipe"] })
  } catch (error) {
    finishJob(id, { ok: false, error: error instanceof Error ? error.message : "Could not start the model worker." })
    return
  }
  job.child = child
  let out = ""
  const timer = setTimeout(() => child.kill("SIGTERM"), 12 * 60 * 1000)
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    out += chunk
  })
  child.on("close", () => {
    clearTimeout(timer)
    try {
      finishJob(id, JSON.parse(out) as { ok: true; review: LocalReview } | { ok: false; error: string })
    } catch {
      finishJob(id, { ok: false, error: "The model worker stopped before it wrote a note." })
    }
  })
  child.stdin?.end(JSON.stringify({ endpoint: data.endpoint, model: data.model, packet }))
}

function noteInput(data: {
  endpoint?: string
  model?: string
  brief?: CompanyBrief
}) {
  return {
    endpoint: String(data?.endpoint ?? DEFAULT_ENDPOINT).trim().slice(0, 200),
    model: String(data?.model ?? DEFAULT_MODEL).trim().slice(0, 80),
    brief: {
      name: String(data?.brief?.name ?? "").slice(0, 140),
      ticker: String(data?.brief?.ticker ?? "").slice(0, 12),
      entity: String(data?.brief?.entity ?? "").slice(0, 400),
      filings: (data?.brief?.filings ?? []).slice(0, 8).map((item) => ({
        form: String(item.form ?? "").slice(0, 20),
        date: String(item.date ?? "").slice(0, 20),
        reportDate: String(item.reportDate ?? "").slice(0, 20),
        items: String(item.items ?? "").slice(0, 120),
        url: String(item.url ?? "").slice(0, 200),
      })),
      facts: (data?.brief?.facts ?? []).slice(0, 6).map((item) => ({
        label: String(item.label ?? "").slice(0, 40),
        unit: String(item.unit ?? "").slice(0, 40),
        points: (item.points ?? []).slice(0, 6).map((point) => String(point).slice(0, 80)),
      })),
      headlines: (data?.brief?.headlines ?? []).slice(0, 6).map((item) => ({
        kind: item.kind === "ir" ? ("ir" as const) : ("news" as const),
        title: String(item.title ?? "").slice(0, 240),
        source: String(item.source ?? "").slice(0, 80),
        published: String(item.published ?? "").slice(0, 40),
      })),
      profile: {
        sic: String(data?.brief?.profile?.sic ?? "").slice(0, 120),
        website: String(data?.brief?.profile?.website ?? "").slice(0, 200),
        summary: String(data?.brief?.profile?.summary ?? "").slice(0, 700),
        founded: String(data?.brief?.profile?.founded ?? "").slice(0, 10),
        employees: String(data?.brief?.profile?.employees ?? "").slice(0, 20),
        pages: (data?.brief?.profile?.pages ?? []).slice(0, 3).map((page) => ({
          label: String(page.label ?? "").slice(0, 40),
          text: String(page.text ?? "").slice(0, 400),
        })),
        peers: (data?.brief?.profile?.peers ?? []).slice(0, 8).map((peer) => String(peer).slice(0, 80)),
        jobs: (data?.brief?.profile?.jobs ?? []).slice(0, 400).map((role) => ({
          title: String(role.title ?? "").slice(0, 160),
          team: String(role.team ?? "").slice(0, 80),
          location: String(role.location ?? "").slice(0, 80),
        })),
        jobTotal: Number(data?.brief?.profile?.jobTotal ?? data?.brief?.profile?.jobs?.length ?? 0) || 0,
      },
    },
  }
}

export const startLocalModel = createServerFn({ method: "POST" })
  .validator(noteInput)
  .handler(({ data }) => {
    const cutoff = Date.now() - 20 * 60 * 1000
    for (const [id, job] of jobs) {
      if (job.at >= cutoff) continue
      job.child?.kill("SIGTERM")
      jobs.delete(id)
    }
    const id = crypto.randomUUID()
    const job: NoteJob = { at: Date.now(), ticker: data.brief.ticker, status: "pending" }
    jobs.set(id, job)
    spawnNote(id, data)
    return { ok: true as const, jobId: id }
  })

export const pollLocalModel = createServerFn({ method: "POST" })
  .validator((data: { jobId?: string }) => ({
    jobId: String(data?.jobId ?? "").slice(0, 80),
  }))
  .handler(({ data }) => {
    const job = jobs.get(data.jobId)
    if (!job) return { ok: false as const, error: "That note expired. Open the company again." }
    if (job.status === "pending") return { ok: true as const, pending: true as const }
    if (job.status === "error" || !job.review) {
      return { ok: false as const, error: job.error || "The model did not finish" }
    }
    return { ok: true as const, pending: false as const, review: job.review }
  })

export const cancelLocalModel = createServerFn({ method: "POST" })
  .validator((data: { jobId?: string }) => ({
    jobId: String(data?.jobId ?? "").slice(0, 80),
  }))
  .handler(({ data }) => {
    const job = jobs.get(data.jobId)
    job?.child?.kill("SIGTERM")
    jobs.delete(data.jobId)
    return { ok: true as const }
  })

