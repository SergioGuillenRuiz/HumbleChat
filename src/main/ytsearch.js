'use strict'
// Búsqueda por nombre y listas de reproducción de YouTube, leyendo su página pública (sin clave de API: esto no es un producto comercial).
// Sin Electron: la función de red llega por parámetro, para poder probarlo.
//
// Es frágil por naturaleza: YouTube cambia su página sin avisar. Por eso se busca por NOMBRE de campo en todo el JSON de la página y
// no por una ruta fija, se admiten las dos maquetas conocidas de resultados y, si no se entiende nada, se falla con un error claro
// (la interfaz pide pegar el enlace). La sonda «YouTube real» del CI avisa cuando se rompa.

const ID = /^[\w-]{11}$/
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
// Las cookies de consentimiento evitan la pantalla «Antes de continuar» que YouTube pone a quien entra desde Europa
const HEADERS = { 'user-agent': UA, 'accept-language': 'es-ES,es;q=0.9,en;q=0.8', cookie: 'CONSENT=YES+cb; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiAo_CmBg' }
const MAX_HTML = 6 * 1024 * 1024

class SearchError extends Error {}

const text = (x) => (typeof x === 'string' ? x : x?.simpleText ?? x?.content ?? (Array.isArray(x?.runs) ? x.runs.map((r) => r.text).join('') : ''))
const clean = (s, max) => String(s ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, max)

/** «3:33» → 213; «1:02:05» → 3725; otra cosa → 0. */
function parseDuration(s) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : 0
}

/** El objeto JSON que empieza en `html[start]` (una llave), respetando las cadenas; null si no cierra. */
function balancedJson(html, start) {
  let depth = 0
  let inStr = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

/** Los datos que YouTube mete en su página (`ytInitialData`). */
function initialData(html) {
  const m = /(?:var\s+ytInitialData|window\[["']ytInitialData["']\])\s*=\s*\{/.exec(html)
  if (!m) throw new SearchError(/consent\.youtube\.com|Before you continue|Antes de continuar/i.test(html) ? 'YouTube pide aceptar las cookies antes de buscar' : 'YouTube ha cambiado su página y no se entiende')
  const data = balancedJson(html, m.index + m[0].length - 1)
  if (!data) throw new SearchError('YouTube ha cambiado su página y no se entiende')
  return data
}

/** Recorre todo el JSON y llama a `fn(clave, valor)` en cada propiedad que sea un objeto (sin recursión: las páginas son muy hondas). */
function walk(root, fn) {
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]); continue }
    for (const k of Object.keys(node).reverse()) {
      const v = node[k]
      if (v && typeof v === 'object') { fn(k, v); stack.push(v) }
    }
  }
}

/** Primer texto con forma de duración dentro de un trozo del JSON (la maqueta nueva la esconde en las insignias de la miniatura). */
function findDuration(node) {
  let found = ''
  walk(node, (k, v) => { if (!found) for (const x of [v.text, v.simpleText, v.content]) if (typeof x === 'string' && /^\d{1,2}(?::\d{2}){1,2}$/.test(x.trim())) found = x.trim() })
  return parseDuration(found)
}

function fromRenderer(v) {
  return { v: v.videoId, t: clean(text(v.title), 120), a: clean(text(v.ownerText) || text(v.longBylineText) || text(v.shortBylineText), 60), d: parseDuration(text(v.lengthText)) || Number(v.lengthSeconds) || 0 }
}

function fromLockup(v) {
  const meta = v.metadata?.lockupMetadataViewModel
  const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows
  return { v: v.contentId, t: clean(text(meta?.title), 120), a: clean(text(rows?.[0]?.metadataParts?.[0]?.text), 60), d: findDuration(v.contentImage) }
}

/** Los vídeos de una página de YouTube, sin repetir y con título. */
function collectVideos(data, limit) {
  const out = []
  const seen = new Set()
  walk(data, (k, v) => {
    if (out.length >= limit) return
    let item = null
    if ((k === 'videoRenderer' || k === 'playlistVideoRenderer' || k === 'compactVideoRenderer' || k === 'gridVideoRenderer') && ID.test(v.videoId || '')) {
      if (v.isPlayable === false) return
      item = fromRenderer(v)
    } else if (k === 'lockupViewModel' && v.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && ID.test(v.contentId || '')) item = fromLockup(v)
    if (!item || !item.t || seen.has(item.v)) return
    seen.add(item.v)
    out.push(item)
  })
  return out
}

async function getHtml(url, fetchFn, timeoutMs) {
  let res
  try { res = await fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) }) } catch { throw new SearchError('no se pudo conectar con YouTube') }
  if (!res.ok) throw new SearchError(`YouTube respondió ${res.status}`)
  const html = await res.text()
  if (html.length > MAX_HTML) throw new SearchError('la respuesta de YouTube es demasiado grande')
  return html
}

/** Busca vídeos por nombre. @returns {Promise<{v: string, t: string, a: string, d: number}[]>} (d = duración en segundos, 0 si se desconoce) */
async function searchVideos(query, fetchFn, { limit = 10, timeoutMs = 10000 } = {}) {
  const q = clean(query, 100)
  if (!q) throw new SearchError('Escribe algo que buscar')
  // sp=EgIQAQ== filtra solo vídeos (sin canales, listas ni anuncios de películas)
  const html = await getHtml(`https://www.youtube.com/results?hl=es&sp=EgIQAQ%253D%253D&search_query=${encodeURIComponent(q)}`, fetchFn, timeoutMs)
  const list = collectVideos(initialData(html), limit)
  if (!list.length) throw new SearchError('No hay resultados para «' + q + '»')
  return list
}

/** Los vídeos de una lista de reproducción pública (los primeros que YouTube da, normalmente hasta 100). */
async function playlistVideos(listId, fetchFn, { limit = 50, timeoutMs = 10000 } = {}) {
  if (typeof listId !== 'string' || !/^[\w-]{13,64}$/.test(listId)) throw new SearchError('Lista de reproducción no válida')
  const html = await getHtml(`https://www.youtube.com/playlist?hl=es&list=${encodeURIComponent(listId)}`, fetchFn, timeoutMs)
  const list = collectVideos(initialData(html), limit)
  if (!list.length) throw new SearchError('La lista está vacía, es privada o no existe')
  return list
}

module.exports = { searchVideos, playlistVideos, SearchError, parseDuration, balancedJson, initialData, collectVideos }
