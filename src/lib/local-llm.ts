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
  digest: string
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
        scores?: { question?: unknown; score?: unknown; note?: unknown }[]
      }
      if (!parsed || typeof parsed !== "object" || (!("summary" in parsed) && !("scores" in parsed) && !("digest" in parsed))) continue
      const scores = Array.isArray(parsed.scores)
        ? parsed.scores.slice(0, 5).map((item, index) => ({
            question: String(item.question || QUESTIONS[index] || "Check"),
            score: asScore(item.score),
            note: String(item.note || "").slice(0, 400),
          }))
        : []
      return {
        digest: String(parsed.digest || "").slice(0, 1200),
        summary: String(parsed.summary || "").slice(0, 700),
        scores,
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
      summary: stripThink(raw).slice(0, 700) || "The model returned no evaluation.",
      scores: [],
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

async function complete(root: string, model: string, packet: unknown) {
  return fetch(`${root}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 4096,
      think: true,
      messages: [
        {
          role: "system",
          content:
            "You evaluate sources for a company research desk. Think through the recent filings and headlines first, then timeliness, expertise, bias, conflicts, and whether references or methodology can be found. A headline is not a figure. If news and a filing disagree, the filing wins. Do not invent numbers that are not in the packet. After thinking, end with JSON only: {\"digest\": string, \"summary\": string, \"scores\": [{\"question\": string, \"score\": \"pass\"|\"caution\"|\"fail\", \"note\": string}]}. digest is 3 to 5 sentences on what the recent filings and headlines say, naming the form and the date. summary is one sentence on whether those sources can be trusted. Exactly these score questions, in order: Timeliness, Expertise, Bias, Conflicts, References and methodology.",
        },
        { role: "user", content: JSON.stringify(packet) },
      ],
    }),
  })
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
        response = await complete(target, model, packet)
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
      choices?: { message?: { content?: string; reasoning?: string; thinking?: string } }[]
    }
    const message = body.choices?.[0]?.message
    const content = message?.content ?? ""
    const thought = message?.reasoning || message?.thinking || ""
    const review = readScore(content, model) ?? readScore(`${content}\n${thought}`, model)
    if (!review) return { ok: false as const, error: "Ollama did not return a source score" }
    return { ok: true as const, review }
  })
