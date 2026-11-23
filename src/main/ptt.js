'use strict'
// "Pulsar para hablar" con una tecla global: funciona aunque la ventana no esté en primer plano (por ejemplo
// jugando). Solo se engancha al teclado si el usuario lo activa y SOLO atiende a la tecla elegida: las demás
// pulsaciones se descartan sin guardarse ni enviarse a ninguna parte.
// Limitación: en Wayland el sistema no permite ver teclas fuera de la ventana; ahí solo funciona con ella enfocada.
let hook = null
let Keys = null
let started = false
let wanted = null // código de la tecla elegida
let down = false
let recording = null
let notify = () => {}

function load() {
  if (hook) return true
  try {
    if (process.platform === 'linux' && !process.env.DISPLAY) return false
    ;({ uIOhook: hook, UiohookKey: Keys } = require('uiohook-napi'))
    hook.on('keydown', (e) => onKey(e, true))
    hook.on('keyup', (e) => onKey(e, false))
    return true
  } catch { hook = null; return false }
}

const nameOf = (code) => Object.entries(Keys).find(([, c]) => c === code)?.[0] || 'Tecla ' + code

function onKey(e, isDown) {
  if (recording && isDown) {
    const r = recording
    recording = null
    clearTimeout(r.timer)
    r.resolve({ hook: e.keycode, label: nameOf(e.keycode) })
    if (wanted === null) setImmediate(stop)
    return
  }
  if (e.keycode !== wanted || isDown === down) return // otra tecla, o repetición automática
  down = isDown
  notify('ptt', { down })
}

function start() {
  if (!started && load()) { try { hook.start(); started = true } catch { started = false } }
  return started
}

function stop() {
  if (!started) return
  try { hook.stop() } catch {}
  started = false
  down = false
}

module.exports = {
  init(fn) { notify = fn },
  /** Elige la tecla (o desactiva con on=false). Devuelve si la captura global está disponible. */
  configure({ on, hook: code }) {
    wanted = on && Number.isInteger(code) ? code : null
    down = false
    if (wanted !== null) return start()
    if (!recording) stop()
    return false
  },
  /** Espera la siguiente tecla pulsada (hasta 10 s) para asignarla. null si no hay captura global. */
  record() {
    return new Promise((resolve) => {
      if (!start()) return resolve(null)
      recording?.resolve(null)
      recording = { resolve, timer: setTimeout(() => { recording = null; if (wanted === null) stop(); resolve(null) }, 10000) }
    })
  }
}
