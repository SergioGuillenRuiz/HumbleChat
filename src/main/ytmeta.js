'use strict'
// Datos de un vídeo de YouTube para la cola de «Escuchar juntos»: título y canal (oEmbed) y miniatura.
// Sin Electron: la función de red llega por parámetro, para poder probarlo.
//
// Solo lo pide quien añade la canción (y su miniatura, cada uno la suya). A YouTube solo se le dice qué vídeo es: nada de la sala.

const ID = /^[\w-]{11}$/
const clean = (s, max) => (typeof s === 'string' ? s.replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * @returns {Promise<{ok: true, title: string|null, author: string|null, unknown?: true} | {ok: false, reason: 'invalid'|'noembed'|'notfound'}>}
 *   `unknown`: no se pudo consultar (sin conexión, límite…): se deja añadir igualmente y el reproductor avisará si falla.
 */
async function fetchMeta(id, fetchFn, { timeoutMs = 6000 } = {}) {
  if (typeof id !== 'string' || !ID.test(id)) return { ok: false, reason: 'invalid' }
  const unknown = { ok: true, title: null, author: null, unknown: true }
  const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id)
  let res
  try { res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } }) } catch { return unknown }
  if (res.status === 401) return { ok: false, reason: 'noembed' } // su dueño no permite reproducirlo fuera de YouTube
  if (res.status === 404 || res.status === 400) return { ok: false, reason: 'notfound' } // no existe o es privado
  if (!res.ok) return unknown
  try {
    const j = await res.json()
    return { ok: true, title: clean(j.title, 120) || null, author: clean(j.author_name, 60) || null }
  } catch { return unknown }
}

/** Miniatura como `data:` (así la interfaz no necesita permiso para cargar imágenes de YouTube). Null si no se pudo. */
async function fetchThumb(id, fetchFn, { timeoutMs = 6000, maxBytes = 300 * 1024 } = {}) {
  if (typeof id !== 'string' || !ID.test(id)) return null
  try {
    const res = await fetchFn(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok || !/^image\/jpeg\b/.test(res.headers.get('content-type') || '')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > maxBytes) return null
    return 'data:image/jpeg;base64,' + buf.toString('base64')
  } catch { return null }
}

module.exports = { fetchMeta, fetchThumb }
