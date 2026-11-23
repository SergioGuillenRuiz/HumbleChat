'use strict'
const { app, BrowserWindow, ipcMain, protocol, session, shell, desktopCapturer, powerMonitor, Notification, Menu, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { ChatNode } = require('../core/node')
const { findGroupKey } = require('../core/groupkey')
const { loadNetwork } = require('../core/network')
const { CHANNELS, SERVER_NAME, LIMITS } = require('../core/constants')

const ROOT = path.join(__dirname, '..', '..')
const RENDERER = path.join(__dirname, '..', 'renderer')
const IS_WIN = process.platform === 'win32'
const IS_LINUX = process.platform === 'linux'
const IS_WAYLAND = IS_LINUX && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)
const PROFILE = process.env.HUMBLECHAT_PROFILE // solo para pruebas: varias instancias en una máquina

// ───────────── Ajustes de Chromium (antes de "ready") ─────────────
if (PROFILE) app.setPath('userData', path.resolve(PROFILE))
const enable = []
const disable = ['WebRtcHideLocalIpsWithMdns'] // candidatos ICE con IP local real: mejor en LAN
if (IS_LINUX) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto') // Wayland nativo si hay
  enable.push('WebRTCPipeWireCapturer') // compartir pantalla en Wayland vía portal
}
app.commandLine.appendSwitch('enable-features', enable.join(','))
app.commandLine.appendSwitch('disable-features', disable.join(','))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.env.HUMBLECHAT_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
if (process.env.HUMBLECHAT_FAKE_UI) app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
if (process.env.HUMBLECHAT_FAKE_AUDIO_FILE) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.HUMBLECHAT_FAKE_AUDIO_FILE)
if (process.env.HUMBLECHAT_NO_SANDBOX) app.commandLine.appendSwitch('no-sandbox') // contenedores como root

protocol.registerSchemesAsPrivileged([
  { scheme: 'humble', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

if (!PROFILE && !app.requestSingleInstanceLock()) app.quit()

app.setAppUserModelId('com.humblechat.app')

// Un error de red suelto (peer que se cae a medias) nunca debe abrir un diálogo de "crash" ni tirar la app.
process.on('uncaughtException', (e) => console.error('[humblechat] uncaughtException', e))
process.on('unhandledRejection', (e) => console.error('[humblechat] unhandledRejection', e))

let win = null
let node = null
let rendererReady = false
let quitting = false
let pendingScreenId = null

// getSources a veces devuelve una lista vacía de forma transitoria (equipos lentos, primer fotograma tardío).
// En Wayland cada llamada abre el diálogo del portal del sistema: nunca se reintenta (si cancelas, cancelas).
async function getSources(opts, tries = IS_WAYLAND ? 1 : 5) {
  for (let i = 0; i < tries; i++) {
    const sources = await desktopCapturer.getSources(opts)
    if (sources.length) return sources
  }
  return []
}

const send = (type, data) => {
  if (rendererReady && win && !win.isDestroyed()) win.webContents.send('hc', { type, ...data })
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json'
}

// ───────────── Llave del grupo y nodo P2P ─────────────
function loadKey() {
  const found = findGroupKey({
    userDataDir: app.getPath('userData'),
    resourcesDir: app.isPackaged ? process.resourcesPath : null,
    repoRoot: app.isPackaged ? null : ROOT
  })
  if (found) return found.key
  if (!app.isPackaged) { // desarrollo: crear una al vuelo
    const key = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(path.join(ROOT, 'group.key'), key + '\n', { mode: 0o600 })
    return key
  }
  dialog.showErrorBox('HumbleChat', 'Esta copia de la app no incluye la llave del grupo (group.key). Pide a quien te la pasó una versión completa.')
  app.exit(1)
}

let network = null

async function startNode() {
  network = loadNetwork({
    userDataDir: app.getPath('userData'),
    resourcesDir: app.isPackaged ? process.resourcesPath : null,
    repoRoot: app.isPackaged ? null : ROOT
  })
  let { bootstrap } = network
  let dhtOpts = {}
  if (process.env.HUMBLECHAT_BOOTSTRAP) { // solo pruebas: DHT local en vez de la pública
    bootstrap = [process.env.HUMBLECHAT_BOOTSTRAP]
    dhtOpts = { host: '127.0.0.1' }
  }
  node = new ChatNode({ dir: path.join(app.getPath('userData'), 'data'), groupKey: loadKey(), bootstrap, dhtOpts })
  // Los eventos se agrupan en lotes de 40 ms: al sincronizar un historial largo no se satura la interfaz.
  let batch = []
  node.on('event', (ev) => {
    batch.push(ev)
    if (batch.length === 1) setTimeout(flushEvents, 40)
  })
  function flushEvents() {
    const list = batch
    batch = []
    const evs = []
    const touched = new Set() // mensajes cuya edición/reacciones han cambiado
    for (const ev of list) {
      if (ev.t === 'msg') evs.push(node.store.decorate(ev))
      else if (ev.t === 'edit' || ev.t === 'react') touched.add(ev.x)
      else evs.push(ev)
    }
    const fresh = new Set(evs.filter((e) => e.t === 'msg').map((e) => `${e.a}:${e.n}`))
    const updates = [...touched].filter((id) => !fresh.has(id)).map((id) => node.store.message(id)).filter(Boolean)
    send('events', { evs, updates })
  }
  node.on('typing', (id, ch) => send('typing', { id, ch }))
  node.on('members', (members) => send('members', { members }))
  node.on('status', (status) => send('status', { status }))
  node.on('signal', (from, data) => send('signal', { from, data }))
  await node.start()
}

// ───────────── Ventana ─────────────
function isOurs(url) { return typeof url === 'string' && url.startsWith('humble://app/') }

// Tamaño y posición de la ventana: se recuerdan entre sesiones.
const boundsFile = () => path.join(app.getPath('userData'), 'window.json')
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'))
    const { screen } = require('electron')
    const visible = screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width - 100 && b.y < d.bounds.y + d.bounds.height - 100)
    return { width: b.width, height: b.height, ...(visible ? { x: b.x, y: b.y } : {}), maximized: !!b.maximized }
  } catch { return {} }
}
function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized()) return
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })) } catch {}
}

let forceClose = false

function createWindow() {
  const saved = process.env.HUMBLECHAT_W ? {} : loadBounds()
  win = new BrowserWindow({
    width: Number(process.env.HUMBLECHAT_W) || saved.width || 1280,
    height: Number(process.env.HUMBLECHAT_H) || saved.height || 800,
    ...(saved.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 940,
    minHeight: 560,
    show: false,
    title: SERVER_NAME,
    backgroundColor: '#313338',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    ...(IS_WIN ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1e1f22', symbolColor: '#b5bac1', height: 32 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false // la voz no debe degradarse al minimizar
    }
  })
  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize()
    if (!process.env.HUMBLECHAT_HIDDEN) win.show()
  })
  let boundsTimer = null
  for (const evt of ['resize', 'move']) win.on(evt, () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 600) })
  // Cerrar la ventana en plena llamada la cortaría: se pregunta antes (en Discord se minimiza a la bandeja).
  win.on('close', (e) => {
    saveBounds()
    if (forceClose || quitting || !node?.voice) return
    e.preventDefault()
    dialog.showMessageBox(win, {
      type: 'question', buttons: ['Salir y colgar', 'Quedarme en la llamada'], defaultId: 1, cancelId: 1,
      title: 'Estás en una llamada', message: 'Estás en una llamada de voz.', detail: 'Si cierras HumbleChat, saldrás de la llamada.'
    }).then((r) => { if (r.response === 0) { forceClose = true; win?.close() } })
  })
  win.on('closed', () => { win = null; rendererReady = false })
  win.on('focus', () => win.flashFrame(false))

  const wc = win.webContents
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  wc.on('will-navigate', (e, url) => { if (!isOurs(url)) { e.preventDefault(); openExternal(url) } })
  if (!app.isPackaged || process.env.HUMBLECHAT_DEBUG) {
    wc.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) wc.toggleDevTools()
      if (input.control && input.key.toLowerCase() === 'r') wc.reload()
    })
  }
  wc.on('did-start-loading', () => { rendererReady = false })
  win.loadURL(`humble://app/index.html?platform=${process.platform}`)
}

function openExternal(url) {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString())
  } catch {}
}

// ───────────── Protocolo humble:// (interfaz y adjuntos) ─────────────
function registerProtocol() {
  protocol.handle('humble', async (req) => {
    const url = new URL(req.url)
    try {
      if (url.host === 'app') {
        const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
        const file = path.normalize(path.join(RENDERER, rel))
        if (!file.startsWith(RENDERER + path.sep)) return new Response('forbidden', { status: 403 })
        const body = await fs.promises.readFile(file)
        return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } })
      }
      if (url.host === 'blob') {
        const hash = url.pathname.slice(1)
        const mime = /^image\/[a-z0-9.+-]+$/.test(url.searchParams.get('m') || '') ? url.searchParams.get('m') : 'application/octet-stream'
        if (!/^[0-9a-f]{64}$/.test(hash)) return new Response('bad', { status: 400 })
        const file = await node.whenBlob(hash, 25000)
        const body = await fs.promises.readFile(file)
        return new Response(body, { headers: { 'content-type': mime, 'cache-control': 'max-age=31536000, immutable' } })
      }
    } catch {
      return new Response('not found', { status: 404 })
    }
    return new Response('not found', { status: 404 })
  })
}

// ───────────── Permisos y captura de pantalla ─────────────
function setupSession() {
  const ses = session.defaultSession
  const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed.has(permission) && isOurs(details.requestingUrl)))
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && String(origin).startsWith('humble://app'))
  ses.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      // X11/Windows: el selector ya nos dio el id; no hace falta volver a listar (es lo lento y lo intermitente).
      if (pendingScreenId) {
        const id = pendingScreenId
        pendingScreenId = null
        return callback({ video: { id, name: id } }) // sin audio del sistema: capturaría las voces de los demás
      }
      // Wayland: el portal del sistema pregunta aquí qué compartir.
      const sources = await getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      if (!sources.length) return callback(null)
      callback({ video: sources[0] })
    } catch {
      callback(null)
    }
  }, { useSystemPicker: false })
}

// ───────────── IPC ─────────────
function setupIpc() {
  const guard = (fn) => async (e, ...args) => {
    if (!isOurs(e.senderFrame?.url)) throw new Error('origen no permitido')
    return fn(e, ...args)
  }
  const handle = (name, fn) => ipcMain.handle(name, guard(fn))

  handle('init', () => {
    rendererReady = true
    return {
      ...node.snapshot(),
      server: SERVER_NAME,
      channels: CHANNELS,
      limits: { blob: LIMITS.blob, attachments: LIMITS.attachments, text: LIMITS.text, name: LIMITS.name },
      iceServers: network.iceServers,
      platform: process.env.HUMBLECHAT_FAKE_PLATFORM || process.platform, // solo pruebas: ver la barra de título de Windows
      pickerNeeded: !IS_WAYLAND // en Wayland ya pregunta el portal del sistema
    }
  })
  handle('history', (_e, ch, opts) => (typeof ch === 'string' ? node.history(ch, opts || {}) : []))
  handle('send', (_e, m) => node.send(m.ch, m.text, m.att, m.re))
  handle('edit', (_e, id, text) => node.edit(id, text))
  handle('react', (_e, id, emoji, on) => node.react(id, emoji, on))
  handle('typing', (_e, ch) => node.typing(ch))
  handle('remove', (_e, id) => node.remove(id))
  handle('setName', (_e, name) => node.setName(name))
  handle('setVoice', (_e, v) => node.setVoice(v))
  handle('signal', (_e, to, data) => node.signal(to, data))
  handle('addBlob', (_e, { data, name, mime, w, ht }) => {
    if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime)) throw new Error('Solo se pueden enviar imágenes')
    return node.addBlob(Buffer.from(data), { name, mime, w, ht })
  })
  handle('saveBlob', async (_e, hash, name) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return false
    const file = await node.whenBlob(hash, 5000)
    const r = await dialog.showSaveDialog(win, { defaultPath: String(name || 'imagen').replace(/[\\/:*?"<>|]/g, '_') })
    if (r.canceled || !r.filePath) return false
    await fs.promises.copyFile(file, r.filePath)
    return true
  })
  handle('listScreens', async () => {
    const sources = await getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: false })
    return sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), screen: s.id.startsWith('screen:') }))
  })
  handle('chooseScreen', (_e, id) => { pendingScreenId = typeof id === 'string' ? id : null })
  handle('notify', (_e, { title, body, ch }) => {
    if (!win || win.isFocused() || !Notification.isSupported()) return
    const n = new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200), icon: path.join(__dirname, '..', 'assets', 'icon.png') })
    n.on('click', () => { win.show(); win.focus(); send('open', { ch }) })
    n.show()
    win.flashFrame(true)
  })
  handle('diag', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    network: network.source === 'por defecto' ? 'públicos (DHT Hyperswarm + STUN)' : 'propios (' + path.basename(network.source) + ')',
    ...node.diagnostics()
  }))
  handle('openExternal', (_e, url) => openExternal(url))
}

// ───────────── Ciclo de vida ─────────────
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.on('before-quit', (e) => {
  if (quitting || !node) return
  e.preventDefault()
  quitting = true
  const done = () => app.exit(0)
  node.stop().then(done, done)
  setTimeout(done, 2500).unref?.() // no te quedes colgado si la red no responde
})

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  registerProtocol()
  setupSession()
  setupIpc()
  await startNode()
  powerMonitor.on('suspend', () => node.suspend())
  powerMonitor.on('resume', () => node.resume())
  createWindow()
})
