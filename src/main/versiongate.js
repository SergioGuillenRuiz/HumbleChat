'use strict'
// Lógica pura del bloqueo por versión: sin Electron ni red propia, para poder probarla entera.
//
// Regla: HumbleChat solo funciona si es la última versión publicada. Si hay una más nueva, la aplicación no
// arranca la red ni deja usar el chat hasta actualizar. Si NO se puede comprobar (sin Internet, GitHub caído, límite
// de peticiones), no se bloquea, salvo que ya se hubiera visto antes una versión más nueva que la actual.

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/

/** "v1.2.3" → "1.2.3"; null si no parece una versión. */
function parseVersion(tag) {
  const m = VERSION.exec(String(tag ?? '').trim())
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

const num = (v) => (parseVersion(v) || '0.0.0').split('.').map(Number)

/** ¿a es más nueva que b? Compara mayor, menor y parche. */
function isNewer(a, b) {
  const x = num(a)
  const y = num(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/**
 * Decide si hay que bloquear.
 *   current     versión instalada
 *   latest      última versión publicada, o null si no se pudo comprobar
 *   latestSeen  la más nueva que se vio alguna vez (se guarda en disco), o ''
 */
function decide({ current, latest, latestSeen }) {
  const l = parseVersion(latest)
  if (l) return isNewer(l, current) ? { block: true, latest: l, reason: 'outdated' } : { block: false, latest: l, reason: 'ok' }
  const seen = parseVersion(latestSeen)
  if (seen && isNewer(seen, current)) return { block: true, latest: seen, reason: 'known-outdated' }
  return { block: false, latest: null, reason: 'unverified' }
}

/**
 * Consulta la última publicación. `fetchFn` es `fetch` (o `net.fetch`). Devuelve { version, url } o null si falla
 * por cualquier motivo (red, HTTP distinto de 200, JSON raro, tiempo agotado). Nunca lanza.
 */
async function fetchLatest(fetchFn, url, { timeoutMs = 5000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'HumbleChat' }, signal: ctl.signal })
    if (!res.ok) return null
    const rel = await res.json()
    const version = parseVersion(rel?.tag_name)
    return version ? { version, url: typeof rel.html_url === 'string' ? rel.html_url : null } : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { parseVersion, isNewer, decide, fetchLatest }
