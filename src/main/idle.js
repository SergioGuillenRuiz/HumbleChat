'use strict'
// Cuánto lleva el usuario sin tocar el ordenador (teclado, ratón…), en segundos; null si este sistema no lo puede decir.
// Sirve para el AFK: solo se echa a alguien de una llamada si de verdad se sabe que lleva rato sin hacer nada.
//   · Windows, macOS y Linux con X11: la de Electron (powerMonitor).
//   · Linux con Wayland: Electron no ve lo que ocurre en las aplicaciones nativas de Wayland (daría "inactivo" a quien está
//     jugando o escribiendo en otra ventana), así que se pregunta al escritorio. GNOME lo ofrece por D-Bus; si no hay
//     forma, null y no se actúa.
const { execFile } = require('child_process')

const MUTTER = ['call', '--session', '--dest', 'org.gnome.Mutter.IdleMonitor', '--object-path', '/org/gnome/Mutter/IdleMonitor/Core',
  '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime']

/** "(uint64 1234,)" → 1234 (milisegundos), o null. */
function parseGdbusUint(out) {
  const m = /\(\s*(?:uint(?:32|64)\s+)?(\d+)\s*,?\s*\)/.exec(String(out || ''))
  return m ? Number(m[1]) : null
}

function mutterIdleMs(exec = execFile) {
  return new Promise((resolve) => {
    exec('gdbus', MUTTER, { timeout: 2000 }, (err, stdout) => resolve(err ? null : parseGdbusUint(stdout)))
  })
}

/**
 * @param {object} o
 * @param {{ getSystemIdleTime(): number }} o.powerMonitor
 * @param {boolean} o.wayland
 * @param {string} o.platform
 */
async function osIdleSeconds({ powerMonitor, wayland, platform, env = process.env, exec = execFile }) {
  if (env.HUMBLECHAT_FAKE_IDLE !== undefined && env.HUMBLECHAT_FAKE_IDLE !== '') { // solo pruebas
    const n = Number(env.HUMBLECHAT_FAKE_IDLE)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  if (platform === 'linux' && wayland) {
    const ms = await mutterIdleMs(exec)
    return ms === null ? null : ms / 1000
  }
  try {
    const s = powerMonitor.getSystemIdleTime()
    return Number.isFinite(s) && s >= 0 ? s : null
  } catch { return null }
}

module.exports = { osIdleSeconds, parseGdbusUint }
