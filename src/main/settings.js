'use strict'
// Preferencias de la aplicación (no de la sala): se guardan en settings.json dentro de los datos del usuario.
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  tray: true, // al cerrar la ventana, seguir en la bandeja (si el sistema tiene bandeja)
  autostart: false, // iniciar con el sistema
  latestSeen: '', // la última versión publicada que se llegó a ver (para bloquear una versión vieja aunque no haya conexión)
  linkPreviews: true, // crear vistas previas de los enlaces que envío
  afkMute: true, // en una llamada, silenciar el micrófono tras 30 min de inactividad
  afkLeave: true // y salir de la llamada tras 1 h
}

function createSettings(dir) {
  const file = path.join(dir, 'settings.json')
  let data = {}
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const all = () => ({ ...DEFAULTS, ...data })
  return {
    all,
    get: (k) => all()[k],
    set(patch) {
      for (const [k, v] of Object.entries(patch || {})) if (k in DEFAULTS && typeof v === typeof DEFAULTS[k]) data[k] = v
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)) } catch {}
      return all()
    }
  }
}

module.exports = { createSettings, DEFAULTS }
