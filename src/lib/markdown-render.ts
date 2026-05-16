/**
 * Minimal HTML-safe Markdown → HTML renderer for the Ask Compass chat.
 *
 * Why we have our own renderer (vs. `react-markdown` or `marked`):
 *   - The assistant's reply is the only place we render LLM output. We
 *     do NOT want to pull a 30 KB Markdown library + an HTML sanitizer
 *     just for that one panel. The existing `markdownToHtml` helper in
 *     `KnowledgeBase.tsx` covers headings/lists/bold/italic/code/links
 *     and proved enough for a year of knowledge editing — we mirror its
 *     subset here.
 *   - The output is bound to React via `dangerouslySetInnerHTML`, so the
 *     escape pass below is the whole security story. Everything that
 *     isn't a recognised inline / block construct is emitted as escaped
 *     plain text so an LLM injecting raw `<script>` (or even just
 *     `<img onerror=…>`) can't get HTML through.
 *
 * Supported:
 *   - Headings #/##/###
 *   - Bold `**…**`, italic `*…*`, inline code `` `…` ``
 *   - Markdown links `[text](url)` — `href` is sanitised to http(s) only
 *   - Unordered lists `- …`, ordered `1. …`
 *   - Blockquotes `> …`
 *   - Fenced code blocks ```lang …``` rendered as <pre><code>
 *   - Inline `[N]` citation markers — left in place; the chat panel
 *     pairs them with the Sources panel.
 *
 * Anything else (HTML, tables, images, etc.) is escaped to plain text.
 */

const SAFE_HREF = /^(https?:|mailto:)/i

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;'
  )
}

function renderInline(text: string): string {
  // Order matters: escape first, then re-introduce safe constructs so
  // user text inside `<>` etc. survives without leaking real HTML.
  let out = escapeHtml(text)
  // inline code
  out = out.replace(/`([^`]+?)`/g, (_m, body) => `<code>${body}</code>`)
  // bold + italic — bold first so `***x***` lands as bold-italic
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
  // links — restrict to safe schemes; everything else falls through as
  // bare bracketed text so a malicious `javascript:` URL just renders.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label: string, url: string) => {
    if (!SAFE_HREF.test(url)) return full
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })
  return out
}

export function renderAssistantMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block. Capture everything verbatim — no inline pass.
    const fenceMatch = line.match(/^```(\w*)\s*$/)
    if (fenceMatch) {
      const lang = fenceMatch[1]
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      // Skip closing fence (if present — be tolerant of unclosed blocks).
      if (i < lines.length) i++
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    // Headings
    const m = line.match(/^(#{1,3})\s+(.+)$/)
    if (m) {
      const tag = `h${m[1].length}`
      out.push(`<${tag}>${renderInline(m[2])}</${tag}>`)
      i++
      continue
    }

    // Blockquote — collect consecutive `> ` lines.
    if (/^>\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^>\s/.test(lines[i])) {
        items.push(renderInline(lines[i].replace(/^>\s/, '')))
        i++
      }
      out.push(`<blockquote>${items.map((b) => `<p>${b}</p>`).join('')}</blockquote>`)
      continue
    }

    // Ordered list — `1.` / `2.` / etc.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Unordered list — `- ` or `* ` (NOT `**` which is bold).
    if (/^[-*]\s+/.test(line) && !/^\*\*/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i]) && !/^\*\*/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // Blank line
    if (line.trim() === '') {
      i++
      continue
    }

    // Regular paragraph — coalesce consecutive non-special lines so
    // a wrapped sentence renders as one <p> instead of N.
    const buf: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,3}\s|>\s|[-*]\s|\d+\.\s|```)/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    out.push(`<p>${renderInline(buf.join(' '))}</p>`)
  }

  return out.join('\n')
}

// Exported for unit tests.
export const _internal = { escapeHtml, renderInline }
