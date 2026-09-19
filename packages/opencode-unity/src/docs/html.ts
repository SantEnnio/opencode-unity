// Unity documentation page -> compact Markdown-ish text. Only the article is kept: navigation,
// feedback forms and version switchers would waste a small model's context.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "..." }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

// <div> blocks that are page furniture, identified by class or id.
const SKIPPED_BLOCKS = /\b(suggest|scrollToFeedback|nextprev|_leavefeedback|breadcrumbs|lang-switcher|otherversionscontent|switch-link)\b/
const VOID_TAGS = new Set(["br", "img", "input", "hr", "meta", "link", "wbr"])
const BLOCK_TAGS = new Set(["p", "div", "section", "table", "tr", "ul", "ol", "dl", "dt", "dd", "blockquote", "thead", "tbody"])

export type DocPage = { title: string; body: string }

export function htmlToText(html: string): DocPage {
  const rawTitle = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? ""
  const title = decodeEntities(rawTitle).replace(/^Unity\s*-\s*(Scripting API|Manual):\s*/, "").trim()

  const start = html.search(/<h1[\s>]/i)
  let end = html.search(/<div[^>]*(id="_content"|class="footer-wrapper")/i)
  if (end < start) end = html.length
  const article = start >= 0 ? html.slice(start, end) : html

  let out = ""
  let skipDepth = 0 // > 0 while inside a furniture <div>
  let inPre = false
  let last = 0

  const emit = (text: string) => {
    if (skipDepth > 0) return
    out += inPre ? decodeEntities(text) : decodeEntities(text).replace(/\s+/g, " ")
  }

  for (const match of article.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<!--[\s\S]*?-->/g)) {
    emit(article.slice(last, match.index))
    last = match.index + match[0].length
    if (!match[2]) continue

    const closing = match[1] === "/"
    const tag = match[2].toLowerCase()
    const attrs = match[3] ?? ""
    if (VOID_TAGS.has(tag)) {
      if (tag === "br" && skipDepth === 0) out += "\n"
      continue
    }

    if (skipDepth > 0) {
      if (tag === "div") skipDepth += closing ? -1 : 1
      continue
    }
    if (!closing && (tag === "div" || tag === "a") && SKIPPED_BLOCKS.test(attrs)) {
      if (tag === "div") skipDepth = 1
      continue
    }
    if (tag === "script" || tag === "style") {
      const close = article.indexOf(`</${tag}`, last)
      last = close < 0 ? article.length : close
      continue
    }

    if (tag === "pre") {
      inPre = !closing
      out += closing ? "\n```\n" : "\n```csharp\n"
    } else if (/^h[1-6]$/.test(tag)) {
      out += closing ? "\n" : `\n\n${"#".repeat(Math.min(Number(tag[1]), 4))} `
    } else if (tag === "li") {
      if (!closing) out += "\n- "
    } else if (tag === "td" || tag === "th") {
      if (closing) out += " | "
    } else if (tag === "code" && !inPre) {
      out += "`"
    } else if (BLOCK_TAGS.has(tag)) {
      out += "\n"
    }
  }
  emit(article.slice(last))

  const body = out
    .split("\n")
    .map((line) => (line.startsWith("    ") || line.startsWith("\t") ? line.trimEnd() : line.trim()))
    .join("\n")
    .replace(/^Switch to (Manual|Scripting)$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/```csharp\n+/g, "```csharp\n")
    .replace(/\n+```\n/g, "\n```\n")
    .trim()
  return { title, body }
}
