// Inactividad en una llamada: a los 30 min sin actividad te silencia, avisa antes de la hora y a la hora te saca de la llamada.
// La decisión está en afklogic.js (pura y probada). Aquí solo se mide la actividad y se ejecuta lo decidido.
import { store } from './util.js'
import { state, bus } from './state.js'
import { voice, isMuted } from './voice.js'
import { toast } from './ui/overlays.js'
import { AFK, idleOf, afkStep } from './afklogic.js'

let lastInput = Date.now() // última vez que se tocó algo en la ventana de la aplicación
let lastSpoke = Date.now() // última vez que se te oyó hablar
let flags = { muted: false, warned: false }
let timer = null

const dbg = () => (store('dbg') || {}).afk || {} // solo pruebas: tiempos cortos y actividad simulada

export function startAfk() {
  const touch = () => { lastInput = Date.now() }
  for (const evt of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'focus']) window.addEventListener(evt, touch, { passive: true, capture: true })
  bus.on('speaking', () => { if (state.speaking.has(state.me?.id) && !dbg().ignoreSpeech) lastSpoke = Date.now() })
  bus.on('voice', () => { if (!state.voice) flags = { muted: false, warned: false } })
  clearInterval(timer)
  timer = setInterval(tick, dbg().tickMs || 15000)
}

async function tick() {
  const v = state.voice
  if (!v) { lastSpoke = Date.now(); return } // fuera de una llamada no hay nada que vigilar
  const d = dbg()
  const limits = { ...AFK, ...(d.muteMs ? { muteAfterMs: d.muteMs } : {}), ...(d.leaveMs ? { leaveAfterMs: d.leaveMs } : {}), ...(d.warnMs ? { warnBeforeMs: d.warnMs } : {}), ...(d.backMs ? { backMs: d.backMs } : {}) }
  const os = await window.humble.idleSeconds().catch(() => null)
  const osMs = Number.isFinite(os) ? os * 1000 : null
  const now = Date.now()
  const idleMs = idleOf({ osMs, windowMs: d.ignoreInput ? null : now - lastInput, speechMs: now - lastSpoke })
  const r = afkStep({
    idleMs, osKnown: osMs !== null, muted: isMuted(), flags,
    muteOn: state.settings.afkMute !== false, leaveOn: state.settings.afkLeave !== false, limits
  })
  flags = r.flags
  const min = (ms) => Math.max(1, Math.round(ms / 60000))
  if (r.action === 'mute') {
    voice.toggleMute()
    toast(`Te hemos silenciado: llevas ${min(limits.muteAfterMs)} min sin actividad. Cuando vuelvas, activa el micrófono.`, 'warn', 12000)
  } else if (r.action === 'warn') {
    toast(`Llevas mucho rato inactivo: saldrás de la llamada en ${min(limits.warnBeforeMs)} min si no haces nada.`, 'warn', 20000)
    window.humble.notify({ title: 'HumbleChat', body: 'Saldrás de la llamada por inactividad si no haces nada.', ch: v.ch }).catch(() => {})
  } else if (r.action === 'leave') {
    await voice.leave()
    toast(`Has salido de la llamada: llevabas ${min(limits.leaveAfterMs)} min sin actividad.`, 'warn', 15000)
    window.humble.notify({ title: 'HumbleChat', body: 'Has salido de la llamada por inactividad.', ch: v.ch }).catch(() => {})
  }
}
