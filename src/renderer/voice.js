// Llamadas de voz y pantalla: WebRTC en malla (cada par de amigos en la llamada tiene su conexión).
// La señalización viaja por la misma red P2P del chat (window.humble.signal), sin servidores.
import { state, bus } from './state.js'
import { play, setSoundOutput } from './sounds.js'
import { toast, pickScreenSource } from './ui/overlays.js'
import { store } from './util.js'

const links = new Map() // id remoto -> Link
let mic = null
let screen = null
let roster = null // quién estaba en la sala la última vez (para sonidos de entrada/salida)
let ac = null
const meters = new Map() // 'me' | id -> { an, buf, until }
let meterTimer = null
let mutedBeforeDeafen = false

const MAX_SCREEN_BITRATE = 4_000_000

// ───────────── API pública ─────────────
export const voice = {
  join, leave, sync, onSignal, toggleMute, toggleDeafen, startShare, stopShare, watch, getVolume, setVolume, applyDevices
}

export function isMuted() { return !!state.voice && (state.voice.muted || state.voice.deafened) }

function publish() {
  const v = state.voice
  window.humble.setVoice(v ? { ch: v.ch, mute: v.muted || v.deafened, deaf: v.deafened, share: v.sharing } : null).catch(() => {})
}

async function getMic() {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  if (state.prefs.input) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: state.prefs.input } } }) } catch {}
  }
  return navigator.mediaDevices.getUserMedia({ audio: base })
}

async function join(ch) {
  if (state.voice?.ch === ch) return true
  if (state.voice) await leave(false)
  let noMic = false
  try { mic = await getMic() } catch { mic = null; noMic = true }
  state.voice = { ch, muted: noMic, deafened: false, sharing: false, noMic }
  if (noMic) toast('No se pudo usar el micrófono: entras solo para escuchar. Revisa Ajustes → Voz.', 'warn')
  if (mic) startMeter('me', mic)
  applyMute()
  roster = null
  publish()
  play('join')
  bus.emit('voice')
  sync()
  return true
}

async function leave(sound = true) {
  if (!state.voice) return
  stopShare(false)
  for (const id of [...links.keys()]) closeLink(id)
  mic?.getTracks().forEach((t) => t.stop())
  mic = null
  meters.clear()
  clearInterval(meterTimer)
  meterTimer = null
  for (const id of [...state.speaking]) state.speaking.delete(id)
  state.voice = null
  state.watching = null
  state.streams.clear()
  roster = null
  publish()
  if (sound) play('leave')
  bus.emit('voice')
  bus.emit('speaking')
  bus.emit('streams')
}

function applyMute() {
  const off = isMuted()
  mic?.getAudioTracks().forEach((t) => { t.enabled = !off })
  for (const l of links.values()) l.audio.muted = !!state.voice?.deafened
}

function toggleMute() {
  const v = state.voice
  if (!v) return
  if (v.noMic) return toast('No hay micrófono disponible. Revisa Ajustes → Voz.', 'warn')
  if (v.deafened) { v.deafened = false; v.muted = false; play('undeafen') } // como Discord: reactivar el micro al ensordecer-desensordecer
  else { v.muted = !v.muted; play(v.muted ? 'mute' : 'unmute') }
  applyMute(); publish(); bus.emit('voice')
}

function toggleDeafen() {
  const v = state.voice
  if (!v) return
  if (v.deafened) { v.deafened = false; v.muted = mutedBeforeDeafen; play('undeafen') }
  else { mutedBeforeDeafen = v.muted; v.deafened = true; play('deafen') }
  applyMute(); publish(); bus.emit('voice')
}

// ───────────── Sala: quién está conmigo ─────────────
function sync() {
  const v = state.voice
  if (!v) return
  const present = new Set(state.members.filter((m) => m.id !== state.me.id && m.online && m.voice?.ch === v.ch).map((m) => m.id))
  for (const id of present) if (!links.has(id)) openLink(id)
  for (const id of [...links.keys()]) if (!present.has(id)) closeLink(id)
  if (roster) {
    for (const id of present) if (!roster.has(id)) play('join')
    for (const id of roster) if (!present.has(id)) play('leave')
  }
  roster = present
  if (state.watching && state.watching !== state.me.id) {
    const sharer = state.byId.get(state.watching)
    if (!sharer || sharer.voice?.ch !== v.ch || !sharer.voice.share) watch(null)
  }
  for (const id of [...state.speaking]) if (id !== state.me.id && !present.has(id)) { state.speaking.delete(id); bus.emit('speaking') }
}

function onSignal(from, data) {
  if (!state.voice || !data || typeof data !== 'object') return
  const link = links.get(from) || openLink(from)
  link.enqueue(data)
}

// ───────────── Un enlace WebRTC por amigo ─────────────
class Link {
  constructor(id) {
    this.id = id
    this.polite = state.me.id > id // desempate fijo para "perfect negotiation"
    this.makingOffer = false
    this.ignoreOffer = false
    this.settingAnswer = false
    this.viewer = false // ¿me ha pedido ver mi pantalla?
    this.screenSender = null
    this.queue = Promise.resolve()
    this.rebuilds = 0
    this.closed = false

    this.audio = new Audio()
    this.audio.autoplay = true
    this.audio.volume = getVolume(id)
    this.audio.muted = !!state.voice?.deafened
    if (state.prefs.output && this.audio.setSinkId) this.audio.setSinkId(state.prefs.output).catch(() => {})

    const pc = (this.pc = new RTCPeerConnection({ iceServers: state.iceServers }))
    if (mic) for (const t of mic.getAudioTracks()) pc.addTrack(t, mic)
    else pc.addTransceiver('audio', { direction: 'recvonly' })

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await pc.setLocalDescription()
        this.sendDescription()
      } catch (e) { console.warn('negotiation', e) } finally { this.makingOffer = false }
    }
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ k: 'c', c: candidate.toJSON() }) }
    pc.ontrack = (e) => this.onTrack(e)
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce() }

    // Si en 10 s no hay audio fluyendo, rehacer el enlace desde cero en ambos extremos.
    this.watchdog = setTimeout(() => this.stalled(), 10000)
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'connected') clearTimeout(this.watchdog) }
    if (state.watching === id) this.send({ k: 'w', on: true })
  }

  send(msg) { window.humble.signal(this.id, msg).catch(() => {}) }

  // RTCSessionDescription/RTCIceCandidate no sobreviven al IPC: se envían como objetos planos.
  sendDescription() {
    const { type, sdp } = this.pc.localDescription
    this.send({ k: 'd', d: { type, sdp } })
  }

  enqueue(msg) { this.queue = this.queue.then(() => this.handle(msg)).catch((e) => console.warn('signal', e)) }

  async handle(m) {
    if (this.closed) return
    const pc = this.pc
    if (m.k === 'd') {
      const d = m.d
      const ready = !this.makingOffer && (pc.signalingState === 'stable' || this.settingAnswer)
      const collision = d.type === 'offer' && !ready
      this.ignoreOffer = !this.polite && collision
      if (this.ignoreOffer) return
      this.settingAnswer = d.type === 'answer'
      await pc.setRemoteDescription(d)
      this.settingAnswer = false
      if (d.type === 'offer') {
        await pc.setLocalDescription()
        this.sendDescription()
      }
    } else if (m.k === 'c') {
      try { await pc.addIceCandidate(m.c) } catch (e) { if (!this.ignoreOffer) throw e }
    } else if (m.k === 'w') {
      this.viewer = !!m.on
      this.syncScreen()
    } else if (m.k === 'r') { // el otro lado rehízo el enlace
      rebuild(this.id, false)
    }
  }

  onTrack(e) {
    if (e.track.kind === 'audio') {
      const stream = e.streams[0] || new MediaStream([e.track])
      this.audio.srcObject = stream
      this.audio.play().catch(() => {})
      startMeter(this.id, stream)
    } else if (e.track.kind === 'video') {
      state.streams.set(this.id, new MediaStream([e.track]))
      bus.emit('streams')
    }
  }

  syncScreen() {
    const want = this.viewer && screen
    if (want && !this.screenSender) {
      const track = screen.getVideoTracks()[0]
      if (!track) return
      this.screenSender = this.pc.addTrack(track, screen)
      const p = this.screenSender.getParameters()
      p.encodings = p.encodings?.length ? p.encodings : [{}]
      p.encodings[0].maxBitrate = MAX_SCREEN_BITRATE
      this.screenSender.setParameters(p).catch(() => {})
    } else if (!want && this.screenSender) {
      try { this.pc.removeTrack(this.screenSender) } catch {}
      this.screenSender = null
    }
  }

  stalled() {
    if (this.closed || this.pc.connectionState === 'connected') return
    if (this.rebuilds >= 4) return
    rebuild(this.id, true)
  }

  close() {
    this.closed = true
    clearTimeout(this.watchdog)
    this.pc.onnegotiationneeded = this.pc.onicecandidate = this.pc.ontrack = null
    this.pc.close()
    this.audio.srcObject = null
    meters.delete(this.id)
    state.streams.delete(this.id)
  }
}

function openLink(id) {
  const link = new Link(id)
  links.set(id, link)
  return link
}

function closeLink(id) {
  const l = links.get(id)
  if (!l) return
  links.delete(id)
  l.close()
  bus.emit('streams')
}

function rebuild(id, notify) {
  const old = links.get(id)
  const n = (old?.rebuilds || 0) + 1
  if (notify) old?.send({ k: 'r' })
  closeLink(id)
  if (!state.voice) return
  const l = openLink(id)
  l.rebuilds = n
}

// ───────────── Pantalla compartida ─────────────
async function startShare() {
  if (!state.voice || screen) return
  try {
    if (state.pickerNeeded) {
      const id = await pickScreenSource()
      if (!id) return
      await window.humble.chooseScreen(id)
    }
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false })
  } catch (e) {
    screen = null
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast('No se pudo compartir la pantalla.', 'warn')
    return
  }
  const track = screen.getVideoTracks()[0]
  track.contentHint = 'motion'
  track.addEventListener('ended', () => stopShare())
  state.voice.sharing = true
  state.streams.set(state.me.id, screen) // vista previa propia
  for (const l of links.values()) l.syncScreen()
  publish()
  bus.emit('voice')
  bus.emit('streams')
}

function stopShare(update = true) {
  if (!screen) return
  screen.getTracks().forEach((t) => t.stop())
  screen = null
  state.streams.delete(state.me.id)
  if (state.watching === state.me.id) state.watching = null
  for (const l of links.values()) l.syncScreen()
  if (state.voice) state.voice.sharing = false
  if (update) { publish(); bus.emit('voice'); bus.emit('streams') }
}

/** Ver (o dejar de ver) la pantalla de alguien. */
function watch(id) {
  const prev = state.watching
  if (prev === id) return
  if (prev && prev !== state.me.id) { links.get(prev)?.send({ k: 'w', on: false }); state.streams.delete(prev) }
  state.watching = id
  if (id && id !== state.me.id) links.get(id)?.send({ k: 'w', on: true })
  bus.emit('streams')
}

// ───────────── Volumen, dispositivos y medidores ─────────────
function getVolume(id) { return (store('vol') || {})[id] ?? 1 }

function setVolume(id, v) {
  const all = store('vol') || {}
  all[id] = v
  store('vol', all)
  const l = links.get(id)
  if (l) l.audio.volume = v
}

async function applyDevices() {
  setSoundOutput(state.prefs.output)
  for (const l of links.values()) if (l.audio.setSinkId) l.audio.setSinkId(state.prefs.output || '').catch(() => {})
  if (state.voice && mic) { // cambiar de micro en caliente
    try {
      const next = await getMic()
      const track = next.getAudioTracks()[0]
      for (const l of links.values()) for (const s of l.pc.getSenders()) if (s.track?.kind === 'audio') await s.replaceTrack(track)
      mic.getTracks().forEach((t) => t.stop())
      mic = next
      meters.delete('me')
      startMeter('me', mic)
      applyMute()
    } catch { toast('No se pudo cambiar de micrófono.', 'warn') }
  }
}

function startMeter(id, stream) {
  try {
    ac ||= new AudioContext()
    const src = ac.createMediaStreamSource(stream)
    const an = ac.createAnalyser()
    an.fftSize = 512
    src.connect(an)
    meters.set(id, { src, an, buf: new Uint8Array(an.fftSize), until: 0 })
    meterTimer ||= setInterval(tick, 90)
  } catch {}
}

function tick() {
  const now = performance.now()
  let changed = false
  for (const [key, m] of meters) {
    m.an.getByteTimeDomainData(m.buf)
    let sum = 0
    for (const v of m.buf) { const x = (v - 128) / 128; sum += x * x }
    if (Math.sqrt(sum / m.buf.length) > 0.02) m.until = now + 300
    const id = key === 'me' ? state.me.id : key
    const on = now < m.until && !(key === 'me' && isMuted())
    if (on !== state.speaking.has(id)) { on ? state.speaking.add(id) : state.speaking.delete(id); changed = true }
  }
  if (changed) bus.emit('speaking')
}
