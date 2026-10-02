const ANALYST =
  "You are a senior buy-side equity analyst. Keep the reasoning in the thinking channel. The reply itself must be one JSON object and nothing else: {\"digest\":\"string\",\"thesis\":\"string\",\"analysis\":\"string\",\"risks\":\"string\",\"gaps\":\"string\"}. Use only the packet. Do not invent numbers or a price target. Never write a thinking process or restate these instructions. digest is what the recent filings and headlines say. thesis is the variant view, or that the packet is too thin. analysis is the deep note. risks is what could be wrong. gaps is what is missing."

const FINAL =
  "Output one JSON object and nothing else. Keys are digest, thesis, analysis, risks, gaps. No title and no thinking process. Use only the packet. Do not invent numbers or a price target."

function stripThink(raw) {
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .trim()
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
