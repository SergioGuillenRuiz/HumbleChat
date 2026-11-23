// Markdown estilo Discord, construido con nodos DOM (nunca innerHTML): **negrita**, *cursiva*,
// ~~tachado~~, `código`, ```bloque```, > cita y enlaces automáticos.
import { h } from './util.js'
import { state, member } from './state.js'

const INLINE = new RegExp([
  '(`+)([\\s\\S]*?[^`])\\1(?!`)', // 1,2 código
  '\\*\\*([\\s\\S]+?)\\*\\*(?!\\*)', // 3 negrita
  '(?<![\\w*])\\*([^\\s*](?:[\\s\\S]*?[^\\s*])?)\\*(?![\\w*])', // 4 cursiva *
  '(?<![\\w_])_([^\\s_](?:[\\s\\S]*?[^\\s_])?)_(?![\\w_])', // 5 cursiva _
  '~~([\\s\\S]+?)~~', // 6 tachado
  '(https?:\\/\\/[^\\s<>]+[^\\s<>.,;:!?\'")\\]])', // 7 enlace
  '<@([0-9a-f]{64})>' // 8 mención
].join('|'), 'g')

function inline(text, into) {
  let last = 0
  for (const m of text.matchAll(INLINE)) { // matchAll clona el regex: seguro con recursión
    if (m.index > last) into.append(text.slice(last, m.index))
    if (m[2] !== undefined) into.append(h('code.inline', m[2]))
    else if (m[3] !== undefined) into.append(inline(m[3], h('strong')))
    else if (m[4] !== undefined) into.append(inline(m[4], h('em')))
    else if (m[5] !== undefined) into.append(inline(m[5], h('em')))
    else if (m[6] !== undefined) into.append(inline(m[6], h('s')))
    else if (m[7] !== undefined) into.append(h('a.link', { href: m[7], title: m[7], rel: 'noopener noreferrer' }, m[7]))
    else if (m[8] !== undefined) into.append(h('span.mention' + (m[8] === state.me?.id ? '.me' : ''), { dataset: { uid: m[8] } }, '@' + member(m[8]).name))
    last = m.index + m[0].length
  }
  if (last < text.length) into.append(text.slice(last))
  return into
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u

export function renderMarkdown(text) {
  const root = h('div.md')
  const parts = text.split('```')
  const closed = parts.length % 2 === 1 // ``` sin cerrar se muestra tal cual
  parts.forEach((part, i) => {
    if (i % 2 === 1 && (closed || i < parts.length - 1)) {
      root.append(h('pre.codeblock', h('code', part.replace(/^[a-z0-9+#-]*\n/i, '').replace(/\n$/, ''))))
      return
    }
    if (i % 2 === 1) part = '```' + part
    if (!part) return
    const lines = part.replace(/^\n/, '').replace(/\n$/, '').split('\n')
    lines.forEach((line, j) => {
      const quote = /^>\s?(.*)$/.exec(line)
      const box = quote ? h('div.quote') : h('span.line')
      inline(quote ? quote[1] : line, box)
      root.append(box)
      if (!quote && j < lines.length - 1) root.append('\n')
    })
  })
  if (EMOJI_ONLY.test(text) && [...text.replace(/\s/g, '')].length <= 27) root.classList.add('jumbo')
  return root
}
