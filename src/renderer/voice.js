// Llamadas de voz y pantalla: WebRTC en malla (cada par de amigos en la llamada tiene su conexión).
// La señalización viaja por la misma red P2P del chat (window.humble.signal), sin servidores.
import { state, bus } from './state.js'
import { play, setSoundOutput } from './sounds.js'
import { toast, openShareDialog } from './ui/overlays.js'
import { store } from './util.js'

const links = new Map() // id remoto -> Link
// Relé de voz por un tercero cuando la conexión directa entre dos amigos falla (NAT estricto):
const relayOffers = new Map() // x -> Set(ids que pueden retransmitir)   (lado que pide)
const relaying = new Map() // 'a|x' -> { a, x, items: [{ to, sender }] }     (lado que retransmite)
const relayedAudio = new Map() // quién -> { stream, via }                      (lado que recibe)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let mic = null
let screen = null
let camStream = null
let roster = null // quién estaba en la sala la última vez (para sonidos de entrada/salida)
let ac = null
const meters = new Map() // 'me' | id -> { an, buf, until }
let meterTimer = null
let mutedBeforeDeafen = false

// ───────────── Calidad ─────────────
const AUDIO_BITRATE = 64_000 // Opus de voz a 64 kbps (el de Chromium por defecto es 32)

/** Calidades de pantalla compartida (como el diálogo de Discord): nitidez para texto, fluidez para juegos. */
export const PRESETS = {
  fluid: { id: 'fluid', label: 'Fluidez', detail: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 6_000_000, hint: 'motion', codecs: ['video/VP8'] },
  sharp: { id: 'sharp', label: 'Nitidez', detail: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 4_000_000, hint: 'detail', codecs: ['video/VP9', 'video/VP8'] }
}
let screenPreset = PRESETS.fluid
const dbg = () => store('dbg') || {} // ajustes de depuración (solo para medir): localStorage hc.dbg

// ───────────── API pública ─────────────
export const voice = {
  join, leave, sync, onSignal, toggleMute, toggleDeafen, startShare, stopShare, watch, getVolume, setVolume, applyDevices, applyCamera, toggleCamera, diagnostics, setPtt, micLevel
}

export async function diagnostics() {
  return Promise.all([...links.values()].map((l) => l.stats().catch(() => ({ id: l.id, state: 'error', path: '—', rtt: null }))))
}

let qualityTimer = null
async function updateQuality() {
  if (!state.voice) return
  const rtts = (await Promise.all([...links.values()].map((l) => l.rtt()))).filter((x) => x !== null)
  const ping = rtts.length ? Math.max(...rtts) : null
  const cur = state.voice.ping
  if (ping === cur || (ping !== null && cur !== null && cur !== undefined && Math.abs(ping - cur) < 15)) return
  state.voice.ping = ping
  bus.emit('voice')
}

export function isMuted() { return !!state.voice && (state.voice.muted || state.voice.deafened) }

function publish() {
  const v = state.voice
  window.humble.setVoice(v ? { ch: v.ch, mute: v.muted || v.deafened, deaf: v.deafened, share: v.sharing, cam: !!v.cam } : null).catch(() => {})
}

async function getMic() {
  // Procesado de voz de Chromium (eco, ruido, ganancia) a 48 kHz mono, con baja latencia.
  const mode = state.prefs.denoise || 'standard' // standard | advanced (estándar + RNNoise) | off
  const base = {
    echoCancellation: true, noiseSuppression: mode !== 'off', autoGainControl: true,
    channelCount: 1, sampleRate: { ideal: 48000 }, sampleSize: { ideal: 16 }, latency: { ideal: 0.02 }
  }
  let stream
  if (state.prefs.input) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: state.prefs.input } } }) } catch {}
  }
  stream ||= await navigator.mediaDevices.getUserMedia({ audio: base })
  for (const t of stream.getAudioTracks()) t.contentHint = 'speech'
  if (mode !== 'advanced') return stream
  try { return await withRnnoise(stream) } catch (e) {
    console.warn('RNNoise no disponible:', e)
    toast('No se pudo activar la supresión avanzada de ruido; se usa la estándar.', 'warn')
    state.prefs.denoise = 'standard'
    store('denoise', 'standard')
    return stream
  }
}

/** Supresión avanzada: la voz pasa por RNNoise (red neuronal) antes de enviarse. Quita bien ventiladores y teclados. */
async function withRnnoise(raw) {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
  try {
    await ctx.audioWorklet.addModule('vendor/rnnoise-worklet.js')
    const wasm = await (await fetch('vendor/rnnoise.wasm')).arrayBuffer()
    const src = ctx.createMediaStreamSource(raw)
    const node = new AudioWorkletNode(ctx, 'rnnoise', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1], processorOptions: { wasm } })
    const dest = ctx.createMediaStreamDestination()
    src.connect(node)
    node.connect(dest)
    const out = dest.stream
    out._raw = raw // el micrófono real (para cerrarlo y para detectar que se desconecta)
    out._ctx = ctx
    for (const t of out.getAudioTracks()) t.contentHint = 'speech'
    return out
  } catch (e) { ctx.close().catch(() => {}); throw e }
}

function stopMic(m) {
  if (!m) return
  for (const t of (m._raw || m).getTracks()) { t.onended = null; t.stop() }
  m._ctx?.close().catch(() => {})
  m.getTracks().forEach((t) => t.stop())
}
const rawTrack = (m) => (m?._raw || m)?.getAudioTracks()[0]

/** Mensaje con instrucciones según el error y el sistema, en lugar de un "no funciona" genérico. */
function explainMediaError(e, what) {
  const dev = what === 'cam' ? 'la cámara' : 'el micrófono'
  const name = e?.name
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return `No se encuentra ${dev}. Conéctalo y vuelve a pulsar el botón; se detecta solo.`
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return state.platform === 'win32'
      ? `Windows no deja usar ${dev} a la app. Abre Configuración → Privacidad y seguridad → ${what === 'cam' ? 'Cámara' : 'Micrófono'} y activa el acceso para aplicaciones de escritorio.`
      : `El sistema no deja usar ${dev}. Comprueba los permisos de audio (PipeWire/PulseAudio) y que no esté silenciado.`
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    return `${what === 'cam' ? 'La cámara' : 'El micrófono'} está en uso por otro programa o no responde. Ciérralo e inténtalo de nuevo.`
  }
  return `No se pudo usar ${dev} (${name || 'error desconocido'}).`
}

async function getCamera() {
  const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
  if (state.prefs.camera) {
    try { return await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: state.prefs.camera } } }) } catch {}
  }
  return navigator.mediaDevices.getUserMedia({ video: base })
}

/** Si un dispositivo guardado ya no existe (auriculares que no están), se vuelve al predeterminado del sistema. */
async function dropMissingDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  if (!devs.some((d) => d.deviceId)) return [] // sin permiso aún: no se ven los ids
  const lost = []
  for (const [pref, kind] of [['input', 'audioinput'], ['output', 'audiooutput'], ['camera', 'videoinput']]) {
    if (state.prefs[pref] && !devs.some((d) => d.kind === kind && d.deviceId === state.prefs[pref])) {
      state.prefs[pref] = ''
      store(pref, '')
      lost.push(pref)
    }
  }
  return lost
}

async function join(ch) {
  if (state.voice?.ch === ch) return true
  if (state.voice) await leave(false)
  await dropMissingDevices()
  let noMic = false
  let micErr = null
  try { mic = await getMic() } catch (e) { mic = null; noMic = true; micErr = e }
  state.voice = { ch, muted: noMic, deafened: false, sharing: false, noMic, cam: false }
  if (noMic) toast('Entras solo para escuchar. ' + explainMediaError(micErr, 'mic'), 'warn', 10000)
  if (mic) { startMeter('me', mic); watchMic(); clearInterval(gateTimer); gateTimer = setInterval(gateTick, 25) }
  navigator.mediaDevices.ondevicechange = onDeviceChange
  applyMute()
  roster = null
  publish()
  play('join')
  clearInterval(qualityTimer)
  qualityTimer = setInterval(updateQuality, 3000)
  bus.emit('voice')
  sync()
  return true
}

async function leave(sound = true) {
  if (!state.voice) return
  stopShare(false)
  stopCamera(false)
  navigator.mediaDevices.ondevicechange = null
  for (const id of [...links.keys()]) closeLink(id)
  stopMic(mic)
  mic = null
  clearInterval(gateTimer)
  pttDown = false
  clearInterval(qualityTimer)
  for (const k of [...meters.keys()]) dropMeter(k)
  clearInterval(meterTimer)
  meterTimer = null
  for (const id of [...state.speaking]) state.speaking.delete(id)
  state.voice = null
  state.watching = null
  state.streams.clear()
  state.cams.clear()
  roster = null
  publish()
  if (sound) play('leave')
  bus.emit('voice')
  bus.emit('speaking')
  bus.emit('streams')
}

let pttDown = false
let gateTimer = null
let gateUntil = 0
let gateOpen = true

/** Nivel instantáneo (RMS 0..1) del micrófono local. */
function micLevel() {
  const m = meters.get('me')
  if (!m) return 0
  m.an.getByteTimeDomainData(m.buf)
  let sum = 0
  for (const v of m.buf) { const x = (v - 128) / 128; sum += x * x }
  return Math.sqrt(sum / m.buf.length)
}

/**
 * ¿Se transmite ahora el micrófono? Silenciado = no. Con "pulsar para hablar", solo mientras se mantiene la tecla.
 * Con umbral de sensibilidad, solo cuando el nivel lo supera (con 350 ms de margen para no cortar palabras).
 */
function gateTick() {
  if (!state.voice || !mic) return
  const { ptt, gate } = state.prefs
  if (ptt?.on) gateOpen = pttDown
  else if (gate?.on) {
    if (micLevel() > gate.level) gateUntil = performance.now() + 350
    gateOpen = performance.now() < gateUntil
  } else gateOpen = true
  const on = !isMuted() && gateOpen
  for (const t of mic.getAudioTracks()) if (t.enabled !== on) t.enabled = on
}

function setPtt(down) {
  if (!state.prefs.ptt?.on || pttDown === down) return
  pttDown = down
  gateTick()
  bus.emit('voice')
}

function applyMute() {
  const off = isMuted()
  gateTick()
  for (const l of links.values()) l.audio.muted = !!state.voice?.deafened
}

function toggleMute() {
  const v = state.voice
  if (!v) return
  if (v.noMic) return void reacquireMic('Micrófono listo: ya puedes hablar.') // sin micro: el botón vuelve a intentarlo
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
  let cams = false
  for (const id of [...state.cams.keys()]) if (id !== state.me.id && !state.byId.get(id)?.voice?.cam) { state.cams.delete(id); cams = true }
  if (cams) bus.emit('streams')
}

function onSignal(from, data) {
  if (!state.voice || !data || typeof data !== 'object') return
  const link = links.get(from) || openLink(from)
  link.enqueue(data)
}

/** Pone primero los códecs de vídeo preferidos (los demás quedan como alternativa). */
function preferCodecs(transceiver, order) {
  try {
    const caps = RTCRtpSender.getCapabilities('video')?.codecs || []
    const rank = (c) => { const i = order.indexOf(c.mimeType); return i === -1 ? order.length : i }
    transceiver.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)))
  } catch {}
}

/**
 * Sube el bitrate de ARRANQUE del vídeo que enviamos (x-google-start-bitrate). Sin esto, el estimador de
 * ancho de banda empieza en ~300 kbps, el codificador baja la resolución y tarda en recuperarla
 * (los primeros segundos salen borrosos). Se aplica a la descripción REMOTA: el emisor lee ahí sus parámetros.
 */
function tuneRemoteSdp(sdp) {
  if (dbg().noSdp) return sdp
  const start = Math.round((dbg().bitrate || screenPreset.bitrate) / 1000 * 0.6)
  const min = Math.round(start / 4)
  const ext = `x-google-start-bitrate=${start};x-google-min-bitrate=${min}`
  const out = []
  let inVideo = false
  const video = new Set()
  for (const l of sdp.split('\r\n')) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video')
    const m = inVideo && /^a=rtpmap:(\d+) (VP8|VP9|AV1|H264)\//.exec(l)
    if (m) video.add(m[1])
  }
  inVideo = false
  for (const l of sdp.split('\r\n')) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video')
    const f = inVideo && /^a=fmtp:(\d+) (.*)$/.exec(l)
    if (f && video.has(f[1])) { out.push(`a=fmtp:${f[1]} ${f[2]};${ext}`); continue }
    out.push(l)
    const r = inVideo && /^a=rtpmap:(\d+) (VP8|VP9|AV1|H264)\//.exec(l)
    if (r && !sdp.includes(`a=fmtp:${r[1]} `)) out.push(`a=fmtp:${r[1]} ${ext}`)
  }
  return out.join('\r\n')
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
    this.camSender = null
    this.remoteCam = null // id del flujo de cámara y de pantalla del otro (para distinguir los vídeos)
    this.remoteScr = null
    this.unknown = []
    this.viaMap = new Map() // id de flujo -> de quién es la voz (si nos la retransmite este amigo)
    this.audioSids = new Set()
    this.pendingAudio = []
    this.remoteStream = null
    this.relayedBy = null // si la voz de este amigo nos llega retransmitida por otro
    this.failedOnce = false
    this.queue = Promise.resolve()
    this.rebuilds = 0
    this.closed = false

    this.audio = new Audio()
    this.audio.autoplay = true
    this.audio.volume = getVolume(id)
    this.audio.muted = !!state.voice?.deafened
    if (state.prefs.output && this.audio.setSinkId) this.audio.setSinkId(state.prefs.output).catch(() => {})

    const blocked = (dbg().blockDirect || []).includes(id) // solo pruebas: simula un NAT que impide la conexión directa
    const pc = (this.pc = new RTCPeerConnection({ iceServers: state.iceServers, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 2, ...(blocked ? { iceTransportPolicy: 'relay' } : {}) }))
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
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { clearTimeout(this.watchdog); this.failedOnce = false; this.tune(); this.directRecovered() }
      else if (pc.connectionState === 'failed') this.onFailed()
    }
    pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable') this.tune() }
    this.tune()
    if (state.watching === id) this.send({ k: 'w', on: true })
    if (camStream) this.syncCamera()
    this.sendRoles()
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
      await pc.setRemoteDescription({ type: d.type, sdp: tuneRemoteSdp(d.sdp) })
      this.settingAnswer = false
      if (d.type === 'offer') {
        await pc.setLocalDescription()
        this.sendDescription()
      }
    } else if (m.k === 'c') {
      try { await pc.addIceCandidate(m.c) } catch (e) { if (!this.ignoreOffer) throw e }
    } else if (m.k === 's') { // qué flujo es cámara y cuál pantalla
      this.remoteCam = typeof m.cam === 'string' ? m.cam : null
      this.remoteScr = typeof m.scr === 'string' ? m.scr : null
      if (!this.remoteCam && state.cams.delete(this.id)) bus.emit('streams')
      if (!this.remoteScr && this.id !== state.watching && state.streams.delete(this.id)) bus.emit('streams')
      const pending = this.unknown
      this.unknown = []
      for (const u of pending) this.classify(u.sid, u.track)
    } else if (m.k === 'w') {
      this.viewer = !!m.on
      this.syncScreen()
    } else if (m.k === 'r') { // el otro lado rehízo el enlace
      rebuild(this.id, false)
    } else if (m.k === 'rq') { // "¿alguien puede retransmitir entre a y x?"
      const a = links.get(this.id)
      const x = links.get(m.x)
      if (a?.pc.connectionState === 'connected' && x?.pc.connectionState === 'connected') this.send({ k: 'rk', x: m.x })
    } else if (m.k === 'rk') relayOffers.get(m.x)?.add(this.id)
    else if (m.k === 'rp') startRelay(this.id, m.x)
    else if (m.k === 'rd') stopRelay(this.id, m.x)
    else if (m.k === 'via') {
      this.viaMap.set(m.sid, m.who)
      const i = this.pendingAudio.findIndex((x) => x.stream.id === m.sid)
      if (i >= 0) attachRelayed(m.who, this.pendingAudio.splice(i, 1)[0].stream, this.id)
    }
  }

  onTrack(e) {
    if (e.track.kind === 'audio') {
      const stream = e.streams[0] || new MediaStream([e.track])
      if (this.viaMap.has(stream.id)) return attachRelayed(this.viaMap.get(stream.id), stream, this.id)
      if (this.audioSids.size && !this.audioSids.has(stream.id)) { // segundo flujo de audio: voz de otro, retransmitida
        const item = { stream }
        this.pendingAudio.push(item)
        setTimeout(() => { this.pendingAudio = this.pendingAudio.filter((x) => x !== item) }, 8000)
        return
      }
      this.audioSids.add(stream.id)
      this.remoteStream = stream
      if (!this.relayedBy) { // si ya nos llega por relé, el directo se guarda para cuando el relé termine
        this.audio.srcObject = stream
        this.audio.play().catch(() => {})
        startMeter(this.id, stream)
      }
    } else if (e.track.kind === 'video') {
      this.classify(e.streams[0]?.id, e.track)
    }
  }

  /** ¿Cámara o pantalla? Lo dice el id del flujo, que el otro nos anuncia con {k:'s'}. */
  classify(sid, track) {
    if (sid && sid === this.remoteCam) state.cams.set(this.id, new MediaStream([track]))
    else if (sid && sid === this.remoteScr) state.streams.set(this.id, new MediaStream([track]))
    else { this.unknown.push({ sid, track }); return }
    bus.emit('streams')
  }

  sendRoles() { this.send({ k: 's', cam: camStream?.id ?? null, scr: screen?.id ?? null }) }

  syncCamera() {
    if (camStream && !this.camSender) {
      this.camSender = this.pc.addTrack(camStream.getVideoTracks()[0], camStream)
      const tr = this.pc.getTransceivers().find((t) => t.sender === this.camSender)
      if (tr) preferCodecs(tr, ['video/VP8'])
      this.tune()
    } else if (!camStream && this.camSender) {
      const tr = this.pc.getTransceivers().find((t) => t.sender === this.camSender)
      try { this.pc.removeTrack(this.camSender) } catch {}
      try { tr?.stop() } catch {}
      this.camSender = null
    }
  }

  /** Calidad de los emisores. Se reintenta tras negociar porque antes puede no haber "encodings". */
  tune() {
    if (this.closed) return
    // En malla se codifica una vez POR espectador/amigo: con muchos se baja la resolución para cuidar CPU y subida.
    const viewers = [...links.values()].filter((l) => l.screenSender).length
    const screenScale = viewers >= 3 ? 1.5 : 1
    const camScale = links.size >= 4 ? 1.5 : 1
    for (const sender of this.pc.getSenders()) {
      if (!sender.track) continue
      const audio = sender.track.kind === 'audio'
      const cam = sender === this.camSender
      const scale = audio ? 1 : cam ? camScale : screenScale
      const fps = cam ? 30 : dbg().fps || screenPreset.fps
      const maxBitrate = audio ? dbg().audioBitrate || AUDIO_BITRATE : cam ? Math.round(1_200_000 / scale) : Math.round((dbg().bitrate || screenPreset.bitrate) / (scale > 1 ? 1.6 : 1))
      try {
        const p = sender.getParameters()
        if (!p.encodings?.length) continue
        const e = p.encodings[0]
        if (e.maxBitrate === maxBitrate && (audio || (e.maxFramerate === fps && (e.scaleResolutionDownBy || 1) === scale))) continue
        e.maxBitrate = maxBitrate
        e.priority = e.networkPriority = audio ? 'high' : 'medium'
        if (!audio) { e.maxFramerate = fps; e.scaleResolutionDownBy = scale }
        sender.setParameters(p).catch(() => {})
      } catch {}
    }
  }

  syncScreen() {
    const want = this.viewer && screen
    if (want && !this.screenSender) {
      const track = screen.getVideoTracks()[0]
      if (!track) return
      this.screenSender = this.pc.addTrack(track, screen)
      const tr = this.pc.getTransceivers().find((t) => t.sender === this.screenSender)
      if (tr) preferCodecs(tr, dbg().codec ? [dbg().codec] : screenPreset.codecs)
      for (const l of links.values()) l.tune() // el número de espectadores cambia la calidad de todos
    } else if (!want && this.screenSender) {
      // Se detiene el transceptor (no solo se quita la pista): al volver a compartir se crea un flujo nuevo con
      // su propio bitrate de arranque. Reutilizarlo dejaba el vídeo a ~1 fps durante minutos.
      const tr = this.pc.getTransceivers().find((t) => t.sender === this.screenSender)
      try { this.pc.removeTrack(this.screenSender) } catch {}
      try { tr?.stop() } catch {}
      this.screenSender = null
      queueMicrotask(() => { for (const l of links.values()) l.tune() })
    }
  }

  async rtt() {
    try {
      const st = await this.pc.getStats()
      let rtt = null
      st.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = Math.round(r.currentRoundTripTime * 1000) })
      return rtt
    } catch { return null }
  }

  /** Estado detallado de este enlace para la pestaña Diagnóstico (las tasas se calculan entre llamadas). */
  async stats() {
    const out = { id: this.id, state: this.relayedBy ? 'retransmitido' : this.pc.connectionState, path: this.relayedBy ? `retransmitido por ${state.byId.get(this.relayedBy)?.name || 'un amigo'}` : '—', rtt: null }
    const st = await this.pc.getStats()
    const byId = new Map()
    st.forEach((r) => byId.set(r.id, r))
    let pair = null
    st.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId) })
    if (!pair) st.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r })
    if (pair) {
      if (pair.currentRoundTripTime != null) out.rtt = Math.round(pair.currentRoundTripTime * 1000)
      const types = [byId.get(pair.localCandidateId)?.candidateType, byId.get(pair.remoteCandidateId)?.candidateType]
      if (!this.relayedBy) out.path = types.includes('relay') ? 'por relé TURN' : types.every((t) => t === 'host') ? 'red local' : 'directa (atravesando NAT)'
    }
    const prev = this.prev || {}
    const cur = {}
    const best = {}
    st.forEach((r) => {
      if (r.type !== 'outbound-rtp' && r.type !== 'inbound-rtp') return
      const key = r.kind + (r.type === 'outbound-rtp' ? 'Out' : 'In')
      const bytes = r.bytesSent ?? r.bytesReceived ?? 0
      cur[r.id] = { bytes, ts: r.timestamp }
      const p = prev[r.id]
      const got = r.packetsReceived ?? 0
      const row = {
        kbps: p ? Math.round(((bytes - p.bytes) * 8) / (r.timestamp - p.ts)) : null,
        codec: byId.get(r.codecId)?.mimeType?.replace(/^(audio|video)\//, ''),
        w: r.frameWidth, h: r.frameHeight,
        fps: r.framesPerSecond != null ? Math.round(r.framesPerSecond) : null,
        limit: r.qualityLimitationReason && r.qualityLimitationReason !== 'none' ? r.qualityLimitationReason : null,
        jitter: r.jitter != null ? Math.round(r.jitter * 1000) : null,
        lostPct: r.packetsLost != null && got + r.packetsLost > 0 ? +((100 * r.packetsLost) / (got + r.packetsLost)).toFixed(1) : null
      }
      // Tras parar y volver a compartir quedan flujos antiguos en las estadísticas: se muestra el que está activo.
      if (!best[key] || (row.kbps ?? -1) >= (best[key].kbps ?? -1)) best[key] = row
    })
    Object.assign(out, best)
    this.prev = cur
    return out
  }

  stalled() {
    if (this.closed || this.pc.connectionState === 'connected') return
    this.onFailed()
    if (this.rebuilds >= 4) return
    // Se sigue intentando la conexión directa de vez en cuando; mientras tanto, la voz va por relé.
    setTimeout(() => { if (!this.closed && links.get(this.id) === this && this.pc.connectionState !== 'connected') rebuild(this.id, true) }, 30000)
  }

  /** La conexión directa no se establece: se pide a un tercero que retransmita el audio. */
  onFailed() {
    if (this.failedOnce) return
    this.failedOnce = true
    requestRelay(this.id)
  }

  /** La directa ha vuelto a funcionar: se cancela el relé. */
  directRecovered() {
    if (!this.relayedBy) return
    const via = this.relayedBy
    this.relayedBy = null
    relayedAudio.delete(this.id)
    links.get(via)?.send({ k: 'rd', x: this.id })
    if (this.remoteStream) { this.audio.srcObject = this.remoteStream; this.audio.play().catch(() => {}); startMeter(this.id, this.remoteStream) }
  }

  close() {
    this.closed = true
    clearTimeout(this.watchdog)
    this.pc.onnegotiationneeded = this.pc.onicecandidate = this.pc.ontrack = null
    this.pc.close()
    if (!relayedAudio.has(this.id)) this.audio.srcObject = null
    meters.delete(this.id)
    state.streams.delete(this.id)
    state.cams.delete(this.id)
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
  // Si este amigo retransmitía para otros, se corta; si nos retransmitía a nosotros, se vuelve a pedir otro.
  for (const r of [...relaying.values()]) if (r.a === id || r.x === id) stopRelay(r.a, r.x)
  for (const [who, r] of [...relayedAudio]) {
    if (r.via !== id && who !== id) continue
    relayedAudio.delete(who)
    const t = links.get(who)
    if (!t) continue
    t.relayedBy = null
    t.audio.srcObject = null
    meters.delete(who)
    if (t.pc.connectionState !== 'connected') { t.failedOnce = false; setTimeout(() => t.onFailed(), 1000) }
  }
  bus.emit('streams')
}

// ───────────── Relé de voz por un tercero ─────────────
/** Pide a los demás que retransmitan entre yo y x. Lo inicia el de id menor para que no lo pidan los dos. */
function requestRelay(x) {
  if (!state.voice || state.me.id > x) return
  relayOffers.set(x, new Set())
  for (const [id, l] of links) if (id !== x) l.send({ k: 'rq', x })
  setTimeout(() => {
    const offers = relayOffers.get(x)
    relayOffers.delete(x)
    const link = links.get(x)
    if (!link || link.pc.connectionState === 'connected') return
    if (!offers?.size) { // nadie puede: se reintenta más tarde
      setTimeout(() => { const l = links.get(x); if (l && l.pc.connectionState !== 'connected') { l.failedOnce = false; l.onFailed() } }, 8000)
      return
    }
    links.get([...offers].sort()[0])?.send({ k: 'rp', x }) // el de id menor retransmite
  }, 1500)
}

/** Yo soy el relé: reenvío la voz de a hacia x y la de x hacia a. */
function startRelay(a, x) {
  const key = [a, x].sort().join('|')
  const la = links.get(a)
  const lx = links.get(x)
  if (relaying.has(key) || !la || !lx) return
  const rec = { a, x, items: [] }
  relaying.set(key, rec)
  const forward = async (from, to) => {
    for (let i = 0; i < 25 && !from.remoteStream; i++) await sleep(300)
    if (!from.remoteStream || relaying.get(key) !== rec || to.closed) return
    const sender = to.pc.addTrack(from.remoteStream.getAudioTracks()[0], from.remoteStream)
    rec.items.push({ to, sender })
    to.send({ k: 'via', who: from.id, sid: from.remoteStream.id })
  }
  forward(la, lx)
  forward(lx, la)
}

function stopRelay(a, x) {
  const key = [a, x].sort().join('|')
  const rec = relaying.get(key)
  if (!rec) return
  relaying.delete(key)
  for (const { to, sender } of rec.items) {
    if (to.closed) continue
    const tr = to.pc.getTransceivers().find((t) => t.sender === sender)
    try { to.pc.removeTrack(sender) } catch {}
    try { tr?.stop() } catch {}
  }
}

/** Me llega la voz de `who` retransmitida por `via`: se reproduce en lugar de la conexión directa. */
function attachRelayed(who, stream, via) {
  const t = links.get(who)
  if (!t || t.pc.connectionState === 'connected') return
  t.relayedBy = via
  relayedAudio.set(who, { stream, via })
  t.audio.srcObject = stream
  t.audio.play().catch(() => {})
  startMeter(who, stream)
  bus.emit('voice')
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
    const choice = await openShareDialog({ needSource: state.pickerNeeded })
    if (!choice) return
    screenPreset = PRESETS[choice.preset] || PRESETS.fluid
    if (choice.id) await window.humble.chooseScreen(choice.id)
    const p = screenPreset
    screen = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps, max: p.fps } },
      audio: false
    })
  } catch (e) {
    screen = null
    console.warn('compartir pantalla:', e?.name, e?.message)
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast('No se pudo compartir la pantalla.', 'warn')
    return
  }
  const track = screen.getVideoTracks()[0]
  track.contentHint = screenPreset.hint
  track.addEventListener('ended', () => stopShare())
  state.voice.sharing = true
  state.streams.set(state.me.id, screen) // vista previa propia
  for (const l of links.values()) { l.syncScreen(); l.sendRoles() }
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
  for (const l of links.values()) { l.syncScreen(); l.sendRoles() }
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
  if (state.voice && mic) await reacquireMic() // cambiar de micro en caliente
}

// ───────────── Cámara ─────────────
async function startCamera() {
  const v = state.voice
  if (!v || camStream) return
  try { camStream = await getCamera() } catch (e) { camStream = null; toast(explainMediaError(e, 'cam'), 'warn', 10000); return }
  const track = camStream.getVideoTracks()[0]
  track.contentHint = 'motion'
  track.addEventListener('ended', () => { if (camStream) { stopCamera(); toast('Se ha desconectado la cámara.', 'warn') } })
  v.cam = true
  state.cams.set(state.me.id, camStream)
  for (const l of links.values()) { l.syncCamera(); l.sendRoles() }
  publish()
  bus.emit('voice')
  bus.emit('streams')
}

function stopCamera(update = true) {
  if (!camStream) return
  camStream.getTracks().forEach((t) => t.stop())
  camStream = null
  state.cams.delete(state.me.id)
  if (state.voice) state.voice.cam = false
  for (const l of links.values()) { l.syncCamera(); l.sendRoles() }
  if (update) { publish(); bus.emit('voice'); bus.emit('streams') }
}

async function toggleCamera() {
  if (!state.voice) return
  if (camStream) stopCamera()
  else await startCamera()
}

/** Cambio de cámara desde Ajustes: si está encendida, se reinicia con la nueva. */
async function applyCamera() {
  if (!camStream) return
  stopCamera(false)
  await startCamera()
}

// ───────────── Micrófono en caliente (conectar/desconectar auriculares) ─────────────
function watchMic() {
  const t = rawTrack(mic)
  if (t) t.onended = () => reacquireMic('Se desconectó tu micrófono: se usa el predeterminado del sistema.')
}

async function setMicTrack(track) {
  for (const l of links.values()) {
    const tr = l.pc.getTransceivers().find((x) => x.receiver.track.kind === 'audio')
    if (!tr) continue
    await tr.sender.replaceTrack(track)
    if (tr.direction === 'recvonly') tr.direction = 'sendrecv' // entraste sin micro: ahora ya envías
  }
}

async function reacquireMic(message) {
  if (!state.voice) return false
  const wasNoMic = state.voice.noMic
  let next
  try { next = await getMic() } catch (e) { toast(explainMediaError(e, 'mic'), 'warn', 10000); return false }
  if (!state.voice) return next.getTracks().forEach((t) => t.stop())
  await setMicTrack(next.getAudioTracks()[0])
  stopMic(mic)
  mic = next
  watchMic()
  dropMeter('me')
  startMeter('me', mic)
  state.voice.noMic = false
  if (wasNoMic) state.voice.muted = false
  clearInterval(gateTimer)
  gateTimer = setInterval(gateTick, 25)
  applyMute()
  for (const l of links.values()) l.tune()
  publish()
  bus.emit('voice')
  if (message) toast(message, 'ok')
  return true
}

let lastDefaultIn = ''
let deviceTimer = null
function onDeviceChange() {
  clearTimeout(deviceTimer)
  deviceTimer = setTimeout(handleDevices, 500)
}

async function handleDevices() {
  if (!state.voice) return
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const ins = devs.filter((d) => d.kind === 'audioinput')
  const def = ins.find((d) => d.deviceId === 'default')?.groupId || ''
  const curId = rawTrack(mic)?.getSettings().deviceId
  if (state.voice.noMic && ins.length) await reacquireMic('Se ha detectado un micrófono: ya puedes hablar.')
  else if (mic && curId && !ins.some((d) => d.deviceId === curId)) await reacquireMic('Se desconectó tu micrófono: se usa el predeterminado del sistema.')
  else if (mic && !state.prefs.input && def && lastDefaultIn && def !== lastDefaultIn) await reacquireMic('Has cambiado el micrófono predeterminado: la app lo sigue.')
  lastDefaultIn = def
  const lost = await dropMissingDevices()
  if (lost.includes('output')) {
    await applyDevices()
    toast('Se desconectó la salida de audio elegida: se usa la predeterminada del sistema.', 'warn')
  }
  if (camStream) {
    const id = camStream.getVideoTracks()[0]?.getSettings().deviceId
    if (id && !devs.some((d) => d.kind === 'videoinput' && d.deviceId === id)) { stopCamera(); toast('Se ha desconectado la cámara.', 'warn') }
  }
}

/** Los medidores de nivel. El del micrófono propio escucha una COPIA de la pista: la original se desactiva al
 *  silenciar o con el umbral/pulsar-para-hablar, y el medidor debe seguir viendo la voz para poder reabrirla. */
function startMeter(id, stream) {
  try {
    ac ||= new AudioContext()
    let clone = null
    if (id === 'me') { clone = stream.getAudioTracks()[0].clone(); stream = new MediaStream([clone]) }
    const src = ac.createMediaStreamSource(stream)
    const an = ac.createAnalyser()
    an.fftSize = 512
    src.connect(an)
    meters.set(id, { src, an, buf: new Uint8Array(an.fftSize), until: 0, clone })
    meterTimer ||= setInterval(tick, 90)
  } catch {}
}

function dropMeter(id) {
  meters.get(id)?.clone?.stop()
  meters.delete(id)
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
    const on = now < m.until && !(key === 'me' && (isMuted() || !gateOpen))
    if (on !== state.speaking.has(id)) { on ? state.speaking.add(id) : state.speaking.delete(id); changed = true }
  }
  if (changed) bus.emit('speaking')
}
