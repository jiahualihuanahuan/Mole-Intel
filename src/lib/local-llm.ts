import { createServerFn } from "@tanstack/react-start"
import type { CompanyBrief } from "@/lib/intel.functions"

export const DEFAULT_ENDPOINT = "http://192.168.86.35:11434/v1"
export const DEFAULT_MODEL = "qwen3.5:9b"

export type LocalScore = {
  question: string
  score: "pass" | "caution" | "fail"
  note: string
}

export type LocalReview = {
  summary: string
  scores: LocalScore[]
  model: string
}

const QUESTIONS = ["Timeliness", "Expertise", "Bias", "Conflicts", "References and methodology"]

function asScore(value: unknown): LocalScore["score"] {
  const text = String(value ?? "").toLowerCase()
  if (text.includes("fail")) return "fail"
  if (text.includes("pass")) return "pass"
  return "caution"
}

export function parseLocalReview(raw: string, model: string): LocalReview {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced?.[1] ?? withoutThink).trim()
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end <= start) {
    return { summary: body.slice(0, 700) || "The model returned no evaluation.", scores: [], model }
  }
  const parsed = JSON.parse(body.slice(start, end + 1)) as {
    summary?: unknown
    scores?: { question?: unknown; score?: unknown; note?: unknown }[]
  }
  const scores = Array.isArray(parsed.scores)
    ? parsed.scores.slice(0, 5).map((item, index) => ({
        question: String(item.question || QUESTIONS[index] || "Check"),
        score: asScore(item.score),
        note: String(item.note || "").slice(0, 400),
      }))
    : []
  return {
    summary: String(parsed.summary || "").slice(0, 700),
    scores,
    model,
  }
}

async function complete(root: string, model: string, packet: unknown, think: boolean) {
  const response = await fetch(`${root}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 700,
      ...(think ? {} : { think: false }),
      messages: [
        {
          role: "system",
          content:
            "You evaluate sources for a company research desk. Judge timeliness, expertise, bias, conflicts across sources, and whether references or methodology can be found. A headline is not a figure. If news and a filing disagree, the filing wins. Reply with JSON only: {\"summary\": string, \"scores\": [{\"question\": string, \"score\": \"pass\"|\"caution\"|\"fail\", \"note\": string}]}. Exactly these questions, in order: Timeliness, Expertise, Bias, Conflicts, References and methodology.",
        },
        { role: "user", content: JSON.stringify(packet) },
      ],
    }),
  })
  return response
}

export const askLocalModel = createServerFn({ method: "POST" })
  .validator(
    (data: { endpoint?: string; model?: string; brief?: CompanyBrief }) => ({
      endpoint: String(data?.endpoint ?? DEFAULT_ENDPOINT).trim().slice(0, 200),
      model: String(data?.model ?? DEFAULT_MODEL).trim().slice(0, 80),
      brief: {
        name: String(data?.brief?.name ?? "").slice(0, 140),
        ticker: String(data?.brief?.ticker ?? "").slice(0, 12),
        entity: String(data?.brief?.entity ?? "").slice(0, 400),
        filings: (data?.brief?.filings ?? []).slice(0, 6).map((item) => ({
          form: String(item.form ?? "").slice(0, 20),
          date: String(item.date ?? "").slice(0, 20),
          url: String(item.url ?? "").slice(0, 200),
        })),
        headlines: (data?.brief?.headlines ?? []).slice(0, 4).map((item) => ({
          kind: item.kind === "ir" ? ("ir" as const) : ("news" as const),
          title: String(item.title ?? "").slice(0, 240),
          source: String(item.source ?? "").slice(0, 80),
          published: String(item.published ?? "").slice(0, 40),
        })),
      },
    }),
  )
  .handler(async ({ data }) => {
    const root = data.endpoint.replace(/\/$/, "")
    if (!/^https?:\/\//i.test(root)) {
      return { ok: false as const, error: "The model address must start with http:// or https://" }
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
      return { ok: false as const, error: "The model address is not a valid URL" }
    }
    let response: Response | null = null
    for (const target of targets) {
      try {
        response = await complete(target, model, packet, false)
        if (response.status === 400) response = await complete(target, model, packet, true)
        break
      } catch {
        response = null
      }
    }
    if (!response) {
      return {
        ok: false as const,
        error: `The desk could not reach ${root}. Check that Ollama is running and that this machine can open that address.`,
      }
    }
    if (!response.ok) {
      return { ok: false as const, error: `Ollama returned ${response.status} for ${model}` }
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string; reasoning?: string } }[]
    }
    const message = body.choices?.[0]?.message
    const text = message?.content || message?.reasoning || ""
    if (!text) return { ok: false as const, error: "Ollama returned an empty reply" }
    try {
      return { ok: true as const, review: parseLocalReview(text, model) }
    } catch {
      return { ok: false as const, error: "Ollama did not return a source score" }
    }
  })
