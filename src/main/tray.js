'use strict'
// Icono en la bandeja del sistema. En Linux solo se usa si el escritorio ofrece bandeja (StatusNotifier),
// para no dejar la aplicación "escondida" sin forma de recuperarla.
const { Tray, Menu, nativeImage } = require('electron')
const { execFile } = require('child_process')
const path = require('path')

function trayHostAvailable() {
  if (process.env.HUMBLECHAT_FORCE_TRAY) return Promise.resolve(true)
  if (process.platform === 'win32') return Promise.resolve(true)
  if (process.platform !== 'linux') return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('busctl', ['--user', 'list', '--no-pager'], { timeout: 2000 }, (err, out) => resolve(!err && /StatusNotifierWatcher/.test(out)))
  })
}

function createTray({ onShow, onToggleMute, onQuit }) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 24, height: 24 })
  const tray = new Tray(icon)
  tray.setToolTip('HumbleChat')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir HumbleChat', click: onShow },
    { label: 'Silenciar o activar micrófono', click: onToggleMute },
    { type: 'separator' },
    { label: 'Salir', click: onQuit }
  ]))
  tray.on('click', onShow)
  return tray
}

module.exports = { trayHostAvailable, createTray }
