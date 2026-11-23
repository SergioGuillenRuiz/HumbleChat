// Utilidades pequeñas de DOM y formato.

/** h('div.clase#id', {onclick, dataset:{a:1}}, 'texto', hijo, [hijos]) */
export function h(sel, props, ...kids) {
  const m = /^([a-z0-9]*)((?:[.#][\w-]+)*)$/i.exec(sel)
  const el = document.createElement(m[1] || 'div')
  for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1))
    else el.id = part.slice(1)
  }
  if (props && (props.nodeType || typeof props === 'string' || Array.isArray(props))) { kids.unshift(props); props = null }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k === 'tip') { el.dataset.tip = v; el.setAttribute('aria-label', v) }
    else if (k === 'tipPos') el.dataset.tipPos = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k === 'html') el.innerHTML = v // solo para SVG propios, nunca para texto de usuarios
    else if (k in el && k !== 'list') el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  append(el, kids)
  return el
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue
    el.append(k.nodeType ? k : document.createTextNode(String(k)))
  }
  return el
}

/** Como replaceChildren, pero ignora null/undefined/false (cosa que el nativo convierte en texto). */
export function fill(el, ...kids) {
  el.replaceChildren()
  return append(el, kids)
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

export function debounce(fn, ms) {
  let t
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

// Colores de avatar por defecto, como los de Discord.
const AVATAR_COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#eb459e', '#ed4245', '#1abc9c', '#9b59b6', '#e67e22']
export function colorFor(id) {
  let x = 0
  for (let i = 0; i < Math.min(id.length, 16); i++) x = (x * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[x % AVATAR_COLORS.length]
}

export function avatar(member, size = 40, extra = '') {
  const name = member?.name || '?'
  const el = h('div.avatar' + (extra ? '.' + extra : ''), {
    style: { width: size + 'px', height: size + 'px', background: colorFor(member?.id || name), fontSize: Math.round(size * 0.46) + 'px' }
  }, size >= 20 ? ([...name.trim()][0]?.toUpperCase() || '?') : '')
  if (member?.av) { // foto de perfil encima de la inicial; si aún no ha llegado, se queda la inicial
    const img = h('img.avatar-img', { src: `humble://blob/${member.av}?m=image/webp`, alt: '', draggable: false })
    img.addEventListener('error', () => img.remove())
    el.append(img)
  }
  return el
}

const pad = (n) => String(n).padStart(2, '0')
export const fmtClock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

export function fmtStamp(ts) {
  const day = startOfDay(new Date(ts))
  const today = startOfDay(new Date())
  const d = new Date(ts)
  if (day === today) return `Hoy a las ${fmtClock(ts)}`
  if (day === today - 864e5) return `Ayer a las ${fmtClock(ts)}`
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${fmtClock(ts)}`
}

export const dayKey = (ts) => startOfDay(new Date(ts))
export const fmtDay = (ts) => new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
export const fmtFull = (ts) => new Date(ts).toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'short' })

export function fmtBytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem('hc.' + key))
    localStorage.setItem('hc.' + key, JSON.stringify(value))
  } catch { return null }
}
