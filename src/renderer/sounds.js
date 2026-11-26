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

/**
 * Una nota con cuerpo: varios parciales (timbre de campana/marimba), ataque corto, caída natural y, si se pide, un
 * deslizamiento de tono. `parts` = [multiplo de frecuencia, volumen relativo].
 */
function note(freq, start, dur, vol = 0.1, { glide = 0, parts = [[1, 1], [2, 0.35], [3, 0.12]], type = 'sine' } = {}) {
  const a = audio()
  if (!a) return
  const t = a.currentTime + start
  const out = a.createGain()
  out.gain.setValueAtTime(0.0001, t)
  out.gain.exponentialRampToValueAtTime(vol, t + 0.008)
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  out.connect(a.destination)
  for (const [mult, rel] of parts) {
    const o = a.createOscillator()
    const g = a.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq * mult, t)
    if (glide) o.frequency.exponentialRampToValueAtTime(glide * mult, t + dur * 0.9)
    g.gain.value = rel
    o.connect(g).connect(out)
    o.start(t)
    o.stop(t + dur + 0.03)
  }
}

const SOFT = { parts: [[1, 1], [2, 0.2]] }
const BELL = { parts: [[1, 1], [2.76, 0.4], [5.4, 0.15]] } // parciales inarmónicos: suena a campanita

// Cada sonido tiene su propia forma para reconocerse sin mirar la pantalla:
//   entrar = arpegio ascendente · salir = dos notas descendentes · silenciar/activar = "pop" que baja/sube
//   ensordecer = grave y apagado · mensaje = campanita doble · llamada propia = acorde ascendente más largo
const SOUNDS = {
  join: () => { note(523, 0, 0.16, 0.11); note(659, 0.09, 0.16, 0.11); note(784, 0.18, 0.34, 0.12) },
  leave: () => { note(784, 0, 0.14, 0.1); note(523, 0.1, 0.14, 0.1); note(392, 0.2, 0.3, 0.09) },
  mute: () => note(520, 0, 0.16, 0.12, { glide: 260, ...SOFT }),
  unmute: () => note(260, 0, 0.16, 0.12, { glide: 520, ...SOFT }),
  deafen: () => { note(330, 0, 0.14, 0.12, { glide: 247, ...SOFT }); note(247, 0.12, 0.22, 0.12, { glide: 165, ...SOFT }) },
  undeafen: () => { note(165, 0, 0.14, 0.12, { glide: 247, ...SOFT }); note(247, 0.12, 0.22, 0.12, { glide: 392, ...SOFT }) },
  message: () => { note(1319, 0, 0.35, 0.1, BELL); note(988, 0.12, 0.5, 0.1, BELL) },
  self: () => { note(392, 0, 0.14, 0.1); note(523, 0.1, 0.14, 0.1); note(659, 0.2, 0.14, 0.1); note(784, 0.3, 0.4, 0.11) }
}

export const play = (name) => { try { SOUNDS[name]?.() } catch {} }
