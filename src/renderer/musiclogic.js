// Escuchar juntos: lógica pura (sin pantalla, red ni reproductor) del estado compartido de la música de una llamada.
//
// Cada persona de la llamada reproduce SU copia desde YouTube (por la llamada no viaja audio de música) y todas se mantienen
// sincronizadas con un estado pequeño que se reparte por los enlaces de la llamada:
//
//   { rev, by, q: [pista…], i, play, pos }
//
// `i` es la pista actual (si i >= q.length no hay ninguna), `play` si suena y `pos` la posición (s) en el instante en que se creó
// el estado. Cada acción crea un estado con rev+1; entre dos estados gana el de mayor `rev` y, a igualdad, el de `by` mayor:
// todos los equipos convergen al mismo sin necesitar a nadie "al mando". El fin de una pista lo propone cualquiera que la esté
// oyendo con un estado que es idéntico en todos (`advance`, by ''), de modo que dos propuestas a la vez no se pisan.

export const LIMITS = { queue: 50, title: 120, author: 60, maxPos: 24 * 3600 }
/** Cuánto se puede desviar un reproductor (s) antes de forzarlo a la posición esperada. */
export const DRIFT_SEC = 3
export const SEEK_COOLDOWN_MS = 4000
/** Tras mandar «cargar», cuánto se espera a que el reproductor lo confirme antes de volver a mandarlo. */
export const LOAD_GRACE_MS = 3000

const ID = /^[\w-]{11}$/
const HEX64 = /^[0-9a-f]{64}$/
const clean = (s, max) => String(s ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, max)
const clampPos = (p) => Math.min(Math.max(Number.isFinite(p) ? p : 0, 0), LIMITS.maxPos)

// ───────────── Enlaces ─────────────

/** Identificador de un vídeo de YouTube a partir de un enlace (o del propio identificador). Las listas de reproducción no se admiten. */
export function parseYouTube(input) {
  const s = String(input ?? '').trim()
  if (ID.test(s)) return s
  let u
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  let id = null
  if (host === 'youtu.be') id = u.pathname.split('/')[1]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v')
    else id = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1] ?? null
  }
  return ID.test(id || '') ? id : null
}

export const watchUrl = (v) => `https://www.youtube.com/watch?v=${v}`

/** 83 → «1:23»; 3725 → «1:02:05». */
export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

// ───────────── Pistas y estado ─────────────

/** Pista: v = vídeo, n = identificador único de esta entrada de la cola, t = título, a = canal, by = quién la añadió. */
export function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null
  if (typeof t.v !== 'string' || !ID.test(t.v)) return null
  if (typeof t.n !== 'string' || !/^[\w-]{4,24}$/.test(t.n)) return null
  return {
    v: t.v, n: t.n,
    t: clean(t.t, LIMITS.title) || 'Vídeo de YouTube',
    a: clean(t.a, LIMITS.author),
    by: typeof t.by === 'string' && HEX64.test(t.by) ? t.by : ''
  }
}

const randomN = () => Array.from(crypto.getRandomValues(new Uint32Array(2)), (x) => x.toString(36).padStart(7, '0')).join('')

export const newTrack = (v, meta, by) => cleanTrack({ v, n: randomN(), t: meta?.title, a: meta?.author, by })

export const emptyState = () => ({ rev: 0, by: '', q: [], i: 0, play: false, pos: 0 })

const has = (s) => s.i >= 0 && s.i < s.q.length
export const current = (s) => (has(s) ? s.q[s.i] : null)

/** Estado recibido de otro equipo: se acepta solo si tiene la forma exacta; si no, null. */
export function validateState(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.q) || s.q.length > LIMITS.queue) return null
  if (!Number.isInteger(s.rev) || s.rev < 0 || s.rev > 1e9) return null
  if (!(s.by === '' || (typeof s.by === 'string' && HEX64.test(s.by)))) return null
  const q = []
  const seen = new Set()
  for (const x of s.q) {
    const t = cleanTrack(x)
    if (!t || seen.has(t.n)) return null
    seen.add(t.n)
    q.push(t)
  }
  if (!Number.isInteger(s.i) || s.i < 0 || s.i > q.length) return null
  const pos = Number(s.pos)
  if (!Number.isFinite(pos)) return null
  const live = s.i < q.length
  return { rev: s.rev, by: s.by, q, i: s.i, play: live && s.play === true, pos: live ? clampPos(pos) : 0 }
}

/** El mensaje de música que viaja por la llamada: solo hay uno, «estado». */
export function validateMessage(d) {
  if (!d || d.t !== 'st') return null
  const s = validateState(d.s)
  return s ? { t: 'st', s } : null
}

// Lo que distingue dos estados con el mismo rev y by (puede pasar con las propuestas automáticas, by ''): cola, pista y si suena.
// La posición no cuenta: la misma versión contada en dos momentos distintos no es una versión nueva.
const key = (s) => JSON.stringify([s.q.map((t) => t.n), s.i, s.play])

/** ¿`a` gana a `b`? Mayor rev; a igualdad, mayor `by`; y si aún empatan, el contenido (un orden total: todos eligen el mismo). */
export const newer = (a, b) => a.rev > b.rev || (a.rev === b.rev && (a.by > b.by || (a.by === b.by && key(a) > key(b))))

// ───────────── Acciones (cada una devuelve un estado nuevo con rev+1, o el mismo si no hay nada que hacer) ─────────────

const bump = (s, by, patch) => ({ ...s, ...patch, rev: s.rev + 1, by })

/** Añade al final. Si no sonaba nada, empieza a sonar. */
export function addTrack(s, track, me) {
  if (s.q.length >= LIMITS.queue) throw new RangeError(`La cola está llena (máximo ${LIMITS.queue} canciones)`)
  const q = [...s.q, track]
  return has(s) ? bump(s, me, { q }) : bump(s, me, { q, i: q.length - 1, play: true, pos: 0 })
}

/** Quita una pista. Si era la actual, pasa a sonar la siguiente (o se para si no hay más). */
export function removeTrack(s, n, me) {
  const k = s.q.findIndex((t) => t.n === n)
  if (k < 0) return s
  const q = s.q.filter((_, j) => j !== k)
  if (k < s.i) return bump(s, me, { q, i: s.i - 1 })
  if (k > s.i) return bump(s, me, { q })
  return k < q.length ? bump(s, me, { q, pos: 0 }) : bump(s, me, { q, i: q.length, play: false, pos: 0 })
}

/** Reproducir o pausar; `pos` es la posición actual (la que se oye ahora). */
export function setPlay(s, play, pos, me) {
  return has(s) ? bump(s, me, { play: !!play, pos: clampPos(pos) }) : s
}

export function seekTo(s, pos, me) {
  return has(s) ? bump(s, me, { pos: clampPos(pos) }) : s
}

/** Ir a una pista de la cola. */
export function jumpTo(s, n, me) {
  const k = s.q.findIndex((t) => t.n === n)
  return k < 0 ? s : bump(s, me, { i: k, play: true, pos: 0 })
}

const following = (s, me) => (s.i + 1 < s.q.length
  ? bump(s, me, { i: s.i + 1, play: true, pos: 0 })
  : bump(s, me, { i: s.q.length, play: false, pos: 0 }))

export function next(s, me) {
  return has(s) ? following(s, me) : s
}

/** «Anterior»: pasados 3 s de la pista, la reinicia; si no, vuelve a la anterior. */
export function prev(s, pos, me) {
  if (!has(s)) return s
  return pos > 3 || s.i === 0 ? bump(s, me, { pos: 0 }) : bump(s, me, { i: s.i - 1, play: true, pos: 0 })
}

/** Fin de la pista `endedN`: la propone quien la oye acabar. Idéntica en todos los equipos (by ''), así que no entra en conflicto. */
export function advance(s, endedN) {
  return has(s) && s.q[s.i].n === endedN ? following(s, '') : s
}

export function clear(s, me) {
  return s.q.length ? bump(s, me, { q: [], i: 0, play: false, pos: 0 }) : s
}

// ───────────── Tiempo ─────────────

/** Posición que debería tener ahora la música: `pos` al crearse el estado (o recibirse, en `at`) más lo transcurrido si suena. */
export function expectedPos(s, at, now) {
  return has(s) && s.play ? clampPos(s.pos + Math.max(0, now - at) / 1000) : s.pos
}

/** El estado tal como se le cuenta a alguien que llega ahora: con la posición de este instante. */
export const snapshot = (s, at, now) => ({ ...s, pos: expectedPos(s, at, now) })

// ───────────── Mezcla ─────────────

/**
 * Ante un estado recibido (ya validado): ¿se adopta? Si gana el de fuera, las canciones que acabo de añadir y que no trae se
 * vuelven a añadir (dos personas pegando a la vez): entonces `changed` es true y hay que repartir el estado resultante.
 * @param {{state: object, at: number}} local
 * @param {Map<string, object>} mine pistas mías recién añadidas, por `n`
 */
export function merge(local, remote, now, mine = new Map(), me = '') {
  if (!newer(remote, local.state)) return { adopted: false, state: local.state, at: local.at, changed: false }
  let state = remote
  for (const t of mine.values()) {
    if (!state.q.some((x) => x.n === t.n) && state.q.length < LIMITS.queue) state = addTrack(state, t, me)
  }
  return { adopted: true, state, at: now, changed: state !== remote }
}

// ───────────── Reconciliar el estado con el reproductor ─────────────

/**
 * Qué hay que decirle al reproductor local para que suene lo que dice el estado.
 * @param {object} o
 * @param {object} o.state estado compartido y `at` (reloj local) del instante al que se refiere su `pos`
 * @param {boolean} o.listening ¿esta persona está escuchando? (si no, el reproductor se para)
 * @param {{n: string|null, st: string, pos: number}} o.player lo que el reproductor cuenta: pista cargada, estado
 *   (none|loading|playing|paused|buffering|ended|error) y posición
 * @param {{n: string, at: number}|null} [o.sent] último «cargar» mandado, para no repetirlo mientras se confirma
 * @param {number} [o.lastSeekAt] cuándo se corrigió la posición por última vez
 */
export function plan({ state, at, now, listening, player, sent = null, lastSeekAt = 0 }) {
  const cur = current(state)
  if (!listening || !cur) return player.n || (sent && now - sent.at < LOAD_GRACE_MS) ? [{ op: 'stop' }] : []
  const want = expectedPos(state, at, now)
  if (player.n !== cur.n) {
    if (sent && sent.n === cur.n && now - sent.at < LOAD_GRACE_MS) return []
    return [{ op: 'load', v: cur.v, n: cur.n, pos: want, play: state.play }]
  }
  if (player.st === 'loading' || player.st === 'error') return []
  // Suena otro vídeo que el pedido: es un anuncio de YouTube. No se toca (cada uno ve los suyos y se corregiría en vano).
  if (player.ad || (player.vid && player.vid !== cur.v)) return []
  const cmds = []
  const sounding = player.st === 'playing' || player.st === 'buffering'
  if (state.play && player.st === 'paused') cmds.push({ op: 'play' })
  if (!state.play && sounding) cmds.push({ op: 'pause' })
  const drift = Math.abs((player.pos || 0) - want)
  if (state.play && player.st === 'playing' && drift > DRIFT_SEC && now - lastSeekAt > SEEK_COOLDOWN_MS) cmds.push({ op: 'seek', pos: want })
  else if (!state.play && player.st === 'paused' && drift > 1.5 && now - lastSeekAt > 1000) cmds.push({ op: 'seek', pos: want })
  return cmds
}

/** ¿Hay que proponer el paso a la siguiente pista? (el reproductor llegó al final de la que toca) */
export const shouldAdvance = ({ state, player }) => player.st === 'ended' && !!player.n && current(state)?.n === player.n

/** Códigos de error de YouTube que son del vídeo (no del equipo): vale la pena saltarlo. */
export const SKIP_ERRORS = new Set([2, 100, 101, 150])
/** Códigos que indican que YouTube no deja reproducir desde esta aplicación (no es culpa del vídeo). */
export const BLOCKED_ERRORS = new Set([152, 153])

/** Mensaje claro para un error del reproductor de YouTube. */
export function explainError(code) {
  if (code === 100) return 'el vídeo ya no existe o es privado'
  if (code === 101 || code === 150) return 'su dueño no permite reproducirlo fuera de YouTube'
  if (code === 2) return 'el enlace no es válido'
  if (code === -2) return 'no se pudo cargar el reproductor de YouTube (¿sin conexión?)'
  if (code === 5) return 'el reproductor de YouTube falló en este equipo'
  if (BLOCKED_ERRORS.has(code)) return 'YouTube no deja reproducirlo desde esta aplicación'
  return 'no se pudo reproducir (código ' + code + ')'
}
