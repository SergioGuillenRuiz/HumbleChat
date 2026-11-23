'use strict'
// Avisos y actualizaciones de versión.
//   · Instalador de Windows (NSIS) y AppImage: electron-updater descarga e instala solo.
//   · .exe portable, .pacman y el resto: se avisa de la versión nueva y se abre la página de descarga.
// Consulta las publicaciones (releases) públicas del repositorio; no envía ningún dato tuyo.
const { app, net } = require('electron')

const REPO = (() => {
  try {
    const url = require('../../package.json').repository?.url || ''
    const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)
    return m ? m[1] : null
  } catch { return null }
})()

const num = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
function isNewer(a, b) { // ¿a es más nueva que b?
  const x = num(a)
  const y = num(b)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  return false
}

function canAutoUpdate() {
  if (!app.isPackaged) return false
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_FILE
  if (process.platform === 'linux') return !!process.env.APPIMAGE
  return false
}

function startUpdates({ send, enabled }) {
  let timer = null
  let updater = null

  async function checkViaReleases() {
    const url = process.env.HUMBLECHAT_UPDATE_URL || (REPO && `https://api.github.com/repos/${REPO}/releases/latest`)
    if (!url) return
    try {
      const res = await net.fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'HumbleChat' } })
      if (!res.ok) return
      const rel = await res.json()
      const version = String(rel.tag_name || '').replace(/^v/, '')
      if (version && isNewer(version, app.getVersion())) send('update', { state: 'available', version, url: rel.html_url })
    } catch {}
  }

  function setupUpdater() {
    try {
      ({ autoUpdater: updater } = require('electron-updater'))
      updater.autoDownload = true
      updater.autoInstallOnAppQuit = true
      updater.logger = null
      updater.on('update-available', (i) => send('update', { state: 'downloading', version: i.version }))
      updater.on('update-downloaded', (i) => send('update', { state: 'ready', version: i.version }))
      updater.on('error', () => {})
      return true
    } catch { updater = null; return false }
  }

  const useUpdater = !process.env.HUMBLECHAT_UPDATE_URL && canAutoUpdate() && setupUpdater()

  async function check() {
    if (!enabled()) return
    if (useUpdater) updater.checkForUpdates().catch(() => {})
    else await checkViaReleases()
  }

  setTimeout(check, Number(process.env.HUMBLECHAT_UPDATE_DELAY) || 8000).unref?.()
  timer = setInterval(check, 6 * 60 * 60 * 1000)
  timer.unref?.()
  return {
    check,
    install() { if (useUpdater) updater.quitAndInstall() },
    stop() { clearInterval(timer) }
  }
}

module.exports = { startUpdates, isNewer }
