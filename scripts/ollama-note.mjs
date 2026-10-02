const ANALYST =
  "You are reading one company for a user who wants a short picture of where it stands right now. Your job is to summarize the news, cross-reference the headlines, and think critically. Use only the packet. A headline is someone else's wording, not the company's books. Do not invent facts, figures, or events. Do not discuss revenue, earnings, margins, or valuation unless a headline states them, and even then treat the figure as a claim, not a fact you checked. Open roles are context only: mention one only if it confirms or contradicts a headline. Keep reasoning in the thinking channel. The reply itself is one JSON object and nothing else, with keys digest, thesis, analysis, risks, and gaps. Every value is short real sentences. Never write the word string. Never copy these instructions. digest: summarize what the headlines are saying, in two or three sentences. thesis: the current state of the company in one or two sentences, or that the wires are too thin to say. analysis: cross-reference the headlines. Say where they agree and where they conflict, and name the outlet when it is in the packet. risks: what a careful reader should not take at face value, including rewritten press releases and a story carried by one source. gaps: what these headlines do not settle."

const FINAL =
  "Output one JSON object and nothing else. Keys are digest, thesis, analysis, risks, gaps. Each value is short prose. Summarize the news, cross-reference it, and say the current state. Never write the word string. Do not invent facts or discuss revenue, earnings, or valuation unless a headline states them."

function stripThink(raw) {
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .trim()
}

function said(value) {
  const text = String(value || "").trim()
  if (!text || /^(string|\.\.\.|todo|tbd|n\/a|null)$/i.test(text)) return ""
  return text
}

function looksLikeScratch(text) {
  return /thinking process|analyze the request|\*\*role:\*\*|\*\*task:\*\*/i.test(text.slice(0, 600))
}

function scoreFrom(body, model) {
  const objects = []
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
      const parsed = JSON.parse(objects[i])
      const digest = said(parsed?.digest ?? parsed?.summary)
      const thesis = said(parsed?.thesis ?? parsed?.view)
      const analysis = said(parsed?.analysis ?? parsed?.note ?? parsed?.body)
      if (!digest && !thesis && !analysis) continue
      return {
        digest: digest.slice(0, 1200),
        thesis: thesis.slice(0, 500),
        analysis: analysis.slice(0, 8000),
        risks: said(parsed.risks).slice(0, 1200),
        gaps: said(parsed.gaps).slice(0, 800),
        model,
      }
    } catch {
      continue
    }
  }
  return null
}

function proseNote(raw, model) {
  let text = stripThink(raw).trim()
  const marker = text.search(/\n(?:final answer|final note|buy-side note)\b/i)
  if (marker >= 0) text = text.slice(marker).replace(/^(?:final answer|final note|buy-side note)\b[:\s]*/i, "").trim()
  if (!text || looksLikeScratch(text) || text.length < 80) return null
  return { digest: "", thesis: "", analysis: text.slice(0, 8000), risks: "", gaps: "", model }
}

function reviewFrom(content, thought, model) {
  const clean = stripThink(content)
  return scoreFrom(clean, model) || scoreFrom(`${clean}\n${thought}`, model) || proseNote(content, model)
}

function textFrom(payload) {
  if (payload?.message) {
    return { content: payload.message.content || "", thought: payload.message.thinking || "" }
  }
  const message = payload?.choices?.[0]?.message
  return { content: message?.content || "", thought: message?.reasoning || message?.thinking || "" }
}

async function callOllama(origin, model, packet, think) {
  const messages = [
    { role: "system", content: think ? ANALYST : FINAL },
    { role: "user", content: JSON.stringify(packet) },
  ]
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: JSON.stringify({
      model,
      stream: false,
      think,
      messages,
      options: { temperature: 0.2, num_predict: think ? 8192 : 2500 },
    }),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`Ollama returned ${response.status}. ${raw.replace(/\s+/g, " ").slice(0, 240)}`)
  const payload = JSON.parse(raw)
  return textFrom(payload)
}

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  const root = String(input.endpoint || "").replace(/\/$/, "")
  const url = new URL(root)
  const origins = [`${url.protocol}//${url.host}`]
  if (url.hostname === "192.168.86.35") origins.push(`${url.protocol}//host.docker.internal:${url.port || 11434}`)
  const model = input.model || "qwen3.5:9b"
  const packet = input.packet
  let lastError = `The desk could not reach ${root}.`
  for (const origin of origins) {
    try {
      const first = await callOllama(origin, model, packet, true)
      let review = reviewFrom(first.content, first.thought, model)
      if (!review) {
        const second = await callOllama(origin, model, packet, false)
        review = reviewFrom(second.content, second.thought, model)
      }
      if (!review) throw new Error("Ollama did not write the note.")
      process.stdout.write(JSON.stringify({ ok: true, review }))
      return
    } catch (error) {
      const detail = error instanceof Error ? error.message : "request failed"
      lastError = detail === "fetch failed" ? `The desk could not reach Ollama at ${origin}.` : detail
    }
  }
  process.stdout.write(JSON.stringify({ ok: false, error: lastError }))
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "The model worker failed." }))
})
