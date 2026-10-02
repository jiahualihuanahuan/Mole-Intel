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

export async function askLocalModel(
  endpoint: string,
  model: string,
  brief: CompanyBrief,
): Promise<LocalReview> {
  const root = endpoint.trim().replace(/\/$/, "")
  if (!/^https?:\/\//i.test(root)) {
    throw new Error("The model address must start with http:// or https://")
  }
  let chosen = model.trim()
  if (!chosen) {
    const listed = await fetch(`${root}/models`)
    if (listed.ok) {
      const payload = (await listed.json()) as { data?: { id?: string }[] }
      chosen = payload.data?.[0]?.id ?? ""
    }
  }
  if (!chosen) chosen = "local"
  const packet = {
    company: brief.name,
    ticker: brief.ticker,
    entity: brief.entity,
    filings: brief.filings.slice(0, 6).map((item) => `${item.form} ${item.date}`),
    headlines: brief.headlines.slice(0, 4).map((item) => ({
      kind: item.kind,
      title: item.title,
      source: item.source,
      published: item.published,
    })),
  }
  let response: Response
  try {
    response = await fetch(`${root}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: chosen,
        temperature: 0.2,
        max_tokens: 700,
        think: false,
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
  } catch {
    throw new Error(
      "The browser could not reach " +
        root +
        ". If this is Ollama, set OLLAMA_ORIGINS=* on that machine and restart it.",
    )
  }
  if (!response.ok) {
    throw new Error(`Local model returned ${response.status}`)
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const text = body.choices?.[0]?.message?.content ?? ""
  if (!text) throw new Error("The local model returned an empty reply")
  return parseLocalReview(text, chosen)
}
