/** @param {string} raw */
export function finalNote(raw) {
  let text = String(raw || "");
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "\n");
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "\n");
  text = text.replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, "\n");
  text = text.replace(/<think>[\s\S]*$/i, "");
  text = text.replace(/<thinking>[\s\S]*$/i, "");
  const marked = text.split(/\n(?=\s*(?:#{1,3}\s*)?(?:\*\*|__)?(?:final(?:\s+\w+){0,2}|conclusion)\b)/i);
  if (marked.length > 1) text = marked[marked.length - 1];
  text = text.replace(
    /^\s*(?:#{1,3}\s*)?(?:\*\*|__)?(?:thinking(?:\s+process)?|reasoning|chain of thought)(?:\*\*|__)?\s*:?\s*\n[\s\S]*?(?=\n\s*(?:#{1,3}\s+\S|\*\*[^*\n]+\*\*))/i,
    "",
  );
  text = text.replace(/^\s*(?:#{1,3}\s*)?(?:\*\*|__)?(?:final(?:\s+\w+){0,2}|conclusion)\s*:?\s*(?:\*\*|__)?\s*/i, "");
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
