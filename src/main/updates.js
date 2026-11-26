'use strict'
// Actualización OBLIGATORIA. HumbleChat solo funciona si es la última versión publicada:
//   · Al arrancar se consulta la última publicación ANTES de levantar la red. Si la instalada es más antigua, no se
//     conecta a nadie y se muestra la pantalla de actualización.
//   · Mientras está abierta se vuelve a mirar cada 30 minutos: si aparece una versión nueva, hay un plazo de 30 s
//     para terminar lo que se esté haciendo y después se corta la red y se pide actualizar.
//   · Instalador de Windows (NSIS) y AppImage: se descarga e instala sola (electron-updater) y se reinicia.
//   · .exe portable, .pacman y el resto: enlace de descarga; no hay forma de seguir sin actualizar.
//   · Si no se puede comprobar (sin Internet, GitHub caído) NO se bloquea, salvo que ya se hubiera visto una versión
//     más nueva que la instalada. Solo se consultan las publicaciones públicas del repositorio; no se envía ningún dato.
//   · Solo en pruebas/desarrollo: HUMBLECHAT_NO_UPDATE_GATE=1 lo desactiva y HUMBLECHAT_UPDATE_URL apunta a otro servidor
//     (y HUMBLECHAT_UPDATE_AUTO=1 permite la instalación automática con él).
const { app, net } = require('electron')
const { UpdateController } = require('./updatecontroller')
const { fetchLatest, isNewer } = require('./versiongate')

const REPO = (() => {
  try {
    const url = require('../../package.json').repository?.url || ''
    const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)
    return m ? m[1] : null
  } catch { return null }
})()

const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== undefined && v !== '' ? Number(v) : def)

function canAutoUpdate() {
  if (process.env.HUMBLECHAT_UPDATE_URL && !process.env.HUMBLECHAT_UPDATE_AUTO) return false // servidor de pruebas: sin instalador real, salvo test/autoupdate.js
  if (!app.isPackaged) return false
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_FILE
  if (process.platform === 'linux') return !!process.env.APPIMAGE
  return false
}

function createUpdater() {
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  return autoUpdater
}

/** settings: createSettings(...). stopNetwork: detiene la red P2P. onForced: ya no hay vuelta atrás. */
function startUpdates({ send, settings, stopNetwork, onForced }) {
  const url = process.env.HUMBLECHAT_UPDATE_URL || (REPO && `https://api.github.com/repos/${REPO}/releases/latest`)
  const ctl = new UpdateController({
    current: app.getVersion(),
    active: () => !!url && !process.env.HUMBLECHAT_NO_UPDATE_GATE && (app.isPackaged || !!process.env.HUMBLECHAT_UPDATE_URL),
    lookup: () => fetchLatest((u, o) => net.fetch(u, o), url),
    store: { get: () => settings.get('latestSeen'), set: (v) => settings.set({ latestSeen: v }) },
    canAutoUpdate,
    createUpdater,
    stopNetwork,
    onForced,
    relaunch: () => { app.relaunch(); app.exit(0) },
    send,
    graceMs: num(process.env.HUMBLECHAT_UPDATE_GRACE_MS, 30000)
  })
  ctl.beginPeriodic = () => ctl.start(num(process.env.HUMBLECHAT_UPDATE_INTERVAL_MS, 30 * 60 * 1000))
  return ctl
}

module.exports = { startUpdates, isNewer }
