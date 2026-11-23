// Sonidos sintetizados (sin archivos): entrar/salir de llamada, silenciar, mensaje.
let ctx = null
let sink = ''

function audio() {
  if (!ctx) {
    try { ctx = new AudioContext() } catch { return null }
    if (sink && ctx.setSinkId) ctx.setSinkId(sink).catch(() => {})
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

export function setSoundOutput(deviceId) {
  sink = deviceId || ''
  if (ctx && ctx.setSinkId) ctx.setSinkId(sink).catch(() => {})
}

function tone(freq, start, dur, vol = 0.06, type = 'sine') {
  const a = audio()
  if (!a) return
  const t = a.currentTime + start
  const o = a.createOscillator()
  const g = a.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(a.destination)
  o.start(t)
  o.stop(t + dur + 0.02)
}

const SOUNDS = {
  join: () => { tone(523, 0, 0.12); tone(784, 0.1, 0.18) },
  leave: () => { tone(784, 0, 0.12); tone(523, 0.1, 0.18) },
  mute: () => tone(330, 0, 0.12, 0.07),
  unmute: () => tone(494, 0, 0.12, 0.07),
  deafen: () => { tone(392, 0, 0.1); tone(262, 0.08, 0.14) },
  undeafen: () => { tone(262, 0, 0.1); tone(392, 0.08, 0.14) },
  message: () => { tone(880, 0, 0.1, 0.04); tone(1175, 0.08, 0.14, 0.04) }
}

export const play = (name) => { try { SOUNDS[name]?.() } catch {} }
