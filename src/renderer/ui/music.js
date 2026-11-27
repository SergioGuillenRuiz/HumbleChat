// «Escuchar juntos»: música de YouTube sincronizada con la llamada. Panel flotante con la cola compartida.
//
// Por la llamada no viaja audio de música: cada persona que decide escuchar reproduce SU copia desde YouTube (en una ventana oculta
// y aislada del proceso principal, ver src/main/musicplayer.js) y todas se mantienen sincronizadas con el estado compartido de
// musiclogic.js. Cualquiera de la llamada puede añadir, pausar, saltar o quitar; escuchar es opcional y cada uno ajusta su volumen.
import { h, store } from '../util.js'
import { icon } from '../icons.js'
import { state, bus } from '../state.js'
import { musicBus, sendToCall, sendToPeer } from '../voice.js'
import { toast } from './overlays.js'
import * as L from '../musiclogic.js'

const MINE_MS = 8000 // cuánto se recuerda una canción recién añadida, por si otra persona añade a la vez y gana el empate
const fresh = () => ({
  s: L.emptyState(), at: 0, // estado compartido y reloj local al que se refiere su `pos`
  listening: false,
  open: false,
  player: { n: null, st: 'none', pos: 0, dur: 0 },
  durs: new Map(), // duración de cada pista (n), la que cuenta el reproductor
  sent: null, lastSeekAt: 0,
  mine: new Map(),
  err: null, errStreak: 0,
  noticed: false, // ya se avisó de que alguien puso música
  deaf: false
})
let M = fresh()
const ui = { dock: null, input: null, add: null, vol: null, volText: null, now: null, err: null, queue: null, fill: null, t0: null, t1: null }
const thumbs = new Map() // vídeo -> data: | null
let volume = Math.min(Math.max(Number(store('musicVol') ?? 60), 0), 100) // sobrevive a las reinicializaciones del estado (colgar y volver a entrar)

const me = () => state.me.id
const now = () => Date.now()
const inCall = () => !!state.voice
const nameOf = (id) => state.byId.get(id)?.name || 'Alguien'
const cmd = (c) => window.humble.musicCmd(c).catch(() => {})

// ───────────── Qué enseñan los botones del resto de la interfaz ─────────────

/** present: hay música en la cola · listening: la oigo yo · ping: la hay y no la oigo (para llamar la atención) */
export function musicInfo() {
  const cur = inCall() ? L.current(M.s) : null
  return { present: !!cur, listening: M.listening && !!cur, ping: !!cur && !M.listening, open: M.open, title: cur?.t || '' }
}

/** Mini reproductor para el panel de llamada de la barra lateral (null si no suena nada). */
export function musicMini() {
  const cur = inCall() ? L.current(M.s) : null
  if (!cur) return null
  return h('div.cp-music', { tip: 'Abrir «Escuchar juntos»', tipPos: 'top', onclick: toggleMusic },
    icon('music', 14), h('span.cp-music-t', cur.t),
    h('button.cp-music-b', { tip: M.s.play ? 'Pausar' : 'Reproducir', tipPos: 'top', onclick: (e) => { e.stopPropagation(); togglePlay() } }, icon(M.s.play ? 'pause' : 'play', 16)))
}

export function toggleMusic() {
  if (!inCall()) return toast('Únete a un canal de voz primero.')
  M.open = !M.open
  bus.emit('music')
  if (M.open) setTimeout(() => ui.input?.focus(), 50)
}

// ───────────── Estado compartido ─────────────

function broadcast() { sendToCall({ k: 'mus', d: { t: 'st', s: M.s } }) }

/** Acción de esta persona: se aplica, se reparte y se refleja en el reproductor. */
function act(fn, { listen = false } = {}) {
  const next = fn(M.s)
  if (next === M.s) return
  M.s = next
  M.at = now()
  if (listen) M.listening = true
  broadcast()
  changed()
}

function changed() {
  const cur = L.current(M.s)
  if (!cur) M.noticed = false
  if (!M.err || M.err.n !== cur?.n) M.err = null
  reconcile()
  bus.emit('music')
}

function reconcile() {
  if (!inCall()) return
  const cmds = L.plan({ state: M.s, at: M.at, now: now(), listening: M.listening, player: M.player, sent: M.sent, lastSeekAt: M.lastSeekAt })
  for (const c of cmds) {
    if (c.op === 'load') M.sent = { n: c.n, at: now() }
    else if (c.op === 'seek') M.lastSeekAt = now()
    else if (c.op === 'stop') { M.sent = null; M.player = { n: null, st: 'none', pos: 0, dur: 0 } }
    cmd(c)
  }
}

function applyAudio() { cmd({ op: 'volume', vol: volume, mute: !!state.voice?.deafened }) }

/** Un estado de otro equipo (o la puesta al día de alguien que llega). */
function onRemote(from, d) {
  const m = L.validateMessage(d)
  if (!m || !inCall()) return
  const before = M.s
  const r = L.merge({ state: M.s, at: M.at }, m.s, now(), M.mine, me())
  if (!r.adopted) return
  M.s = r.state
  M.at = r.at
  for (const n of [...M.mine.keys()]) if (m.s.q.some((t) => t.n === n)) M.mine.delete(n) // ya lo tienen los demás
  if (r.changed) broadcast()
  // Avisos: canciones que han añadido otros y música nueva
  const added = M.s.q.filter((t) => t.by !== me() && !before.q.some((x) => x.n === t.n))
  if (added.length) toast(added.length === 1 ? `${nameOf(added[0].by)} añadió «${added[0].t}»` : `${nameOf(added[0].by)} añadió ${added.length} canciones`, 'info', 3500)
  if (!M.listening && !M.noticed && L.current(M.s) && M.s.play) {
    M.noticed = true
    toast(`${nameOf(from)} ha puesto música. Pulsa el botón ♪ para escucharla juntos.`, 'info', 8000)
  }
  changed()
}

function onLink(id) {
  if (M.s.rev > 0) sendToPeer(id, { k: 'mus', d: { t: 'st', s: L.snapshot(M.s, M.at, now()) } })
}

// ───────────── Reproductor local ─────────────

function onPlayer(e) {
  if (!M.listening && e.st !== 'none') return // un resto de lo que sonaba antes de dejar de escuchar
  if (e.dur > 0 && e.n) M.durs.set(e.n, e.dur)
  M.player = { n: e.n, st: e.st, pos: e.pos, dur: e.dur, vid: e.vid }
  if (e.st === 'playing') { M.errStreak = 0; if (M.err?.n === e.n) { M.err = null; bus.emit('music') } }
  if (e.e === 'error') return onPlayerError(e)
  if (L.shouldAdvance({ state: M.s, player: M.player })) return act((s) => L.advance(s, e.n)) // acabó la pista: cualquiera lo propone, es idéntico
  reconcile()
  if (e.e === 'tick') updateProgress()
  else bus.emit('music')
}

function onPlayerError(e) {
  const tr = M.s.q.find((t) => t.n === e.n)
  M.errStreak++
  M.err = { n: e.n, v: tr?.v, text: `${tr ? `«${tr.t}»` : 'La canción'}: ${L.explainError(e.code)}.`, blocked: L.BLOCKED_ERRORS.has(e.code) || e.code === -2 }
  toast(M.err.text, 'warn', 8000)
  // Un vídeo que no se puede reproducir se salta solo (a la tercera seguida se deja de saltar: el problema no es del vídeo)
  if (L.SKIP_ERRORS.has(e.code) && M.errStreak < 3) {
    setTimeout(() => { if (M.listening && L.current(M.s)?.n === e.n) act((s) => L.advance(s, e.n)) }, 1500)
  }
  bus.emit('music')
}

function setListening(on) {
  if (M.listening === on) return
  M.listening = on
  if (on) M.noticed = true
  else M.err = null
  changed()
}

const togglePlay = () => act((s) => L.setPlay(s, !s.play, L.expectedPos(s, M.at, now()), me()), { listen: true })

// ───────────── Añadir ─────────────

async function addFromInput() {
  const text = ui.input.value.trim()
  if (!text) return
  const v = L.parseYouTube(text)
  if (!v) return toast('Pega el enlace de un vídeo de YouTube (las listas de reproducción todavía no se admiten).', 'warn')
  if (M.s.q.length >= L.LIMITS.queue) return toast(`La cola está llena (máximo ${L.LIMITS.queue} canciones).`, 'warn')
  ui.add.disabled = true
  try {
    const meta = await window.humble.musicMeta(v)
    if (!meta?.ok) return toast(meta?.reason === 'noembed' ? 'Su dueño no permite reproducir ese vídeo fuera de YouTube.' : 'Ese vídeo no existe o es privado.', 'warn')
    if (!inCall()) return
    const track = L.newTrack(v, meta, me())
    M.mine.set(track.n, track)
    setTimeout(() => M.mine.delete(track.n), MINE_MS)
    ui.input.value = ''
    act((s) => L.addTrack(s, track, me()), { listen: !L.current(M.s) || M.listening })
  } catch (e) {
    toast(e.message || 'No se pudo añadir la canción.', 'warn')
  } finally { ui.add.disabled = false }
}

// ───────────── Interfaz ─────────────

function thumb(v) {
  if (thumbs.has(v)) return thumbs.get(v)
  thumbs.set(v, null)
  window.humble.musicThumb(v).then((d) => { if (d) { thumbs.set(v, d); bus.emit('music') } }).catch(() => {})
  return null
}

function updateProgress() {
  if (!ui.fill?.isConnected) return
  const cur = L.current(M.s)
  const pos = cur ? L.expectedPos(M.s, M.at, now()) : 0
  const dur = cur ? M.durs.get(cur.n) || 0 : 0
  ui.t0.textContent = L.fmtTime(pos)
  ui.t1.textContent = dur ? L.fmtTime(dur) : '–:––'
  ui.fill.style.width = dur ? Math.min(100, (pos / dur) * 100) + '%' : '0%'
}

function seekFromClick(e) {
  const cur = L.current(M.s)
  const dur = cur ? M.durs.get(cur.n) : 0
  if (!dur || !M.listening) return toast(dur ? 'Pulsa «Escuchar juntos» para poder avanzar la canción.' : 'La duración se sabe cuando empiezas a escuchar.')
  const r = e.currentTarget.getBoundingClientRect()
  const pos = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * dur
  act((s) => L.seekTo(s, pos, me()), { listen: true })
}

function drawNow() {
  const cur = L.current(M.s)
  const s = M.s
  if (!cur) {
    ui.now.replaceChildren(h('div.mu-empty', icon('music', 40), h('b', s.q.length ? 'Se acabó la cola' : 'No suena nada'),
      h('p', 'Pega abajo el enlace de un vídeo de YouTube y sonará para todos los que quieran escuchar.')))
    return
  }
  const img = thumb(cur.v)
  const bar = h('div.mu-bar', { onclick: seekFromClick }, h('div.mu-fill'))
  ui.fill = bar.firstChild
  ui.t0 = h('span', '0:00')
  ui.t1 = h('span', '–:––')
  ui.now.replaceChildren(
    h('div.mu-track',
      h('div.mu-art', img ? h('img', { src: img, alt: '' }) : icon('music', 28)),
      h('div.mu-meta',
        h('div.mu-title', { title: cur.t }, cur.t),
        h('div.mu-sub', [cur.a, cur.by && `añadida por ${cur.by === me() ? 'ti' : nameOf(cur.by)}`].filter(Boolean).join(' · ')))),
    h('div.mu-times', ui.t0, bar, ui.t1),
    h('div.mu-ctrl',
      h('button.mu-b', { tip: 'Anterior', onclick: () => act((x) => L.prev(x, L.expectedPos(x, M.at, now()), me()), { listen: true }) }, icon('skipPrev', 22)),
      h('button.mu-b.main', { tip: s.play ? 'Pausar' : 'Reproducir', dataset: { mu: 'play' }, onclick: togglePlay }, icon(s.play ? 'pause' : 'play', 26)),
      h('button.mu-b', { tip: 'Siguiente', dataset: { mu: 'next' }, onclick: () => act((x) => L.next(x, me()), { listen: true }) }, icon('skipNext', 22)),
      h('button.btn.small' + (M.listening ? '.secondary' : '.brand'), { dataset: { mu: 'listen' }, onclick: () => setListening(!M.listening) },
        M.listening ? 'Dejar de escuchar' : 'Escuchar juntos')))
  updateProgress()
}

function drawErr() {
  const e = M.err
  ui.err.replaceChildren(...(e ? [
    h('div.mu-err-t', e.text),
    e.blocked && h('div.mu-err-h', 'Si pasa con todas las canciones, YouTube no deja reproducir desde esta aplicación en tu equipo.'),
    e.v && h('button.btn.link.small', { onclick: () => window.humble.openExternal(L.watchUrl(e.v)) }, 'Abrir en YouTube')
  ].filter(Boolean) : []))
  ui.err.classList.toggle('hidden', !e)
}

function drawQueue() {
  const s = M.s
  ui.queue.replaceChildren(...(s.q.length ? [
    h('div.mu-qh', `Cola · ${s.q.length} ${s.q.length === 1 ? 'canción' : 'canciones'}`),
    ...s.q.map((t, i) => h('div.mu-q' + (i === s.i ? '.now' : i < s.i ? '.past' : ''), { dataset: { n: t.n }, onclick: () => act((x) => L.jumpTo(x, t.n, me()), { listen: true }) },
      h('span.mu-qi', i === s.i ? icon('play', 14) : String(i + 1)),
      h('div.mu-qt', h('div.mu-qn', { title: t.t }, t.t), h('div.mu-qs', [t.a, t.by && (t.by === me() ? 'tú' : nameOf(t.by))].filter(Boolean).join(' · '))),
      h('button.mu-x', { tip: 'Quitar de la cola', tipPos: 'left', onclick: (e) => { e.stopPropagation(); act((x) => L.removeTrack(x, t.n, me())) } }, icon('close', 16))))
  ] : []))
}

function buildDock() {
  ui.input = h('input.text', { placeholder: 'Enlace de YouTube', spellcheck: false, maxLength: 200, onkeydown: (e) => { if (e.key === 'Enter') addFromInput() } })
  ui.add = h('button.btn.brand.small', { dataset: { mu: 'add' }, onclick: addFromInput }, 'Añadir')
  ui.now = h('div.mu-now')
  ui.err = h('div.mu-err.hidden')
  ui.queue = h('div.mu-queue')
  ui.volText = h('span.mu-vt', String(volume))
  ui.vol = h('input.mu-vol', {
    type: 'range', min: 0, max: 100, value: volume, 'aria-label': 'Volumen de la música',
    oninput: () => { volume = Number(ui.vol.value); ui.volText.textContent = String(volume); store('musicVol', volume); applyAudio() }
  })
  ui.dock = h('div.music-dock', { dataset: { musicDock: '1' } },
    h('div.mu-head', icon('music', 18), h('b', 'Escuchar juntos'), h('button.icon-btn', { tip: 'Cerrar', tipPos: 'left', onclick: toggleMusic }, icon('close', 20))),
    ui.now, ui.err,
    h('div.mu-add', ui.input, ui.add),
    ui.queue,
    h('div.mu-foot', icon('volume', 16), ui.vol, ui.volText),
    h('div.mu-note', 'Cada uno escucha su propia copia desde YouTube, sincronizada. Por la llamada no viaja audio de música.'))
}

function render() {
  const show = M.open && inCall()
  if (!show) { ui.dock?.remove(); return }
  if (!ui.dock) buildDock()
  if (!ui.dock.isConnected) document.body.append(ui.dock)
  ui.dock.classList.toggle('with-members', state.showMembers)
  drawNow()
  drawErr()
  drawQueue()
}

// ───────────── Arranque ─────────────

export function mountMusic() {
  musicBus.handler = onRemote
  musicBus.onLink = onLink
  musicBus.onPlayer = onPlayer
  bus.on('music', render)
  bus.on('toggleMembers', render)
  bus.on('voice', () => {
    if (!inCall()) { // colgar: se acaba la música (el proceso principal ya cierra el reproductor)
      if (M.s.rev > 0 || M.listening || M.open) { M = fresh(); thumbs.clear(); ui.dock?.remove(); bus.emit('music') }
      return
    }
    const deaf = !!state.voice.deafened
    if (deaf !== M.deaf) { M.deaf = deaf; applyAudio() }
  })
  // Cada segundo: el desfase se corrige solo y la barra avanza (también por si se perdió algún evento del reproductor)
  setInterval(() => { if (inCall() && (M.s.rev > 0 || M.listening)) { reconcile(); updateProgress() } }, 1000)
}
