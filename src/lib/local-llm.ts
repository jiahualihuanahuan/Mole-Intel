import { createServerFn } from "@tanstack/react-start"
import type { CompanyBrief } from "@/lib/intel.functions"

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
        thesis?: unknown
        analysis?: unknown
        risks?: unknown
        gaps?: unknown
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (!("digest" in parsed) && !("thesis" in parsed) && !("analysis" in parsed))
      ) {
        continue
      }
      return {
        digest: String(parsed.digest || "").slice(0, 1200),
        thesis: String(parsed.thesis || "").slice(0, 500),
        analysis: String(parsed.analysis || "").slice(0, 4000),
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
  "You are a senior buy-side equity analyst. Write a deep note on this one company from the packet only. Use the recent filings and headlines as evidence. A headline is not a figure. If a wire and a filing disagree, the filing wins. Do not invent numbers, guidance, valuation, or a price target. If the packet is too thin for a view, say so. Think first. Then end with JSON only: {\"digest\": string, \"thesis\": string, \"analysis\": string, \"risks\": string, \"gaps\": string}. digest is 3 to 5 sentences on what the recent filings and headlines actually say, naming the form and the date. thesis is the variant view in one or two sentences, or an explicit statement that the packet does not support one. analysis is the deep note: what the business setup looks like from these sources, what changed, and what a long or a short would be betting on. risks is what could make that view wrong. gaps is what you still need that this packet does not contain."

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

async function complete(root: string, model: string, packet: unknown) {
  const url = new URL(root)
  const origin = `${url.protocol}//${url.host}`
  const messages = [
    { role: "system", content: ANALYST },
    { role: "user", content: JSON.stringify(packet) },
  ]
  const native = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(480000),
    body: JSON.stringify({
      model,
      stream: false,
      think: true,
      messages,
      options: { temperature: 0.2, num_predict: 8192 },
    }),
  })
  if (native.status !== 404) return native
  return fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(480000),
    body: JSON.stringify({
      model,
      stream: false,
      think: true,
      temperature: 0.2,
      max_tokens: 8192,
      messages,
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
    try {
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
      let failure = `The desk could not reach ${root}.`
      for (const target of targets) {
        try {
          response = await complete(target, model, packet)
          break
        } catch (error) {
          response = null
          failure = explainFetch(error, target)
        }
      }
      if (!response) return { ok: false as const, error: failure }
      let raw = ""
      try {
        raw = await response.text()
      } catch (error) {
        return { ok: false as const, error: explainFetch(error, root) }
      }
      if (!response.ok) {
        return {
          ok: false as const,
          error: `Ollama returned ${response.status} for ${model}. ${raw.replace(/\s+/g, " ").slice(0, 240)}`,
        }
      }
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        return { ok: false as const, error: `Ollama did not return JSON. ${raw.replace(/\s+/g, " ").slice(0, 240)}` }
      }
      const { content, thought } = textFrom(payload)
      const review = readScore(content, model) ?? readScore(`${content}\n${thought}`, model)
      if (!review) {
        const preview = (content || thought || raw).replace(/\s+/g, " ").slice(0, 240)
        return {
          ok: false as const,
          error: preview ? `Ollama answered, but not with a note. ${preview}` : "Ollama returned an empty reply",
        }
      }
      return { ok: true as const, review }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "The desk lost the model reply",
      }
    }
  })
