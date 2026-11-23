'use strict'
const { app, BrowserWindow, ipcMain, protocol, session, shell, desktopCapturer, powerMonitor, Notification, Menu, dialog, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { ChatNode } = require('../core/node')
const { findGroupKey, generateKey, formatCode, parseCode, fingerprint } = require('../core/groupkey')
const { checkNat, EXPLAIN } = require('../core/natcheck')
const { createSettings } = require('./settings')
const { startUpdates } = require('./updates')
const { trayHostAvailable, createTray } = require('./tray')
const ptt = require('./ptt')
const { loadNetwork } = require('../core/network')
const { SERVER_NAME, LIMITS } = require('../core/constants')
const { fetchPreview, extractUrl } = require('../core/linkpreview')

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
let pendingAudio = false
let settings = null
let updates = null
let tray = null
let trayOk = false
let trayNoticeShown = false
let currentKey = null
const START_HIDDEN = process.argv.includes('--hidden') || !!process.env.HUMBLECHAT_HIDDEN

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
const userKeyFile = () => path.join(app.getPath('userData'), 'group.key')

function saveKey(key) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(userKeyFile(), key + '\n', { mode: 0o600 })
}

/**
 * Llave de la sala: variable de entorno > datos del usuario > la que trae la aplicación (se copia a los datos
 * del usuario, así sobrevive a las actualizaciones, que no la incluyen) > desarrollo: se crea una.
 * Devuelve null si no hay ninguna: entonces se pide el código de sala al usuario.
 */
function resolveKey() {
  const found = findGroupKey({
    userDataDir: app.getPath('userData'),
    resourcesDir: app.isPackaged ? process.resourcesPath : null,
    repoRoot: app.isPackaged || process.env.HUMBLECHAT_NO_AUTOKEY ? null : ROOT // NO_AUTOKEY: solo pruebas
  })
  if (found) {
    if (found.source !== 'env' && found.source !== userKeyFile()) saveKey(found.key)
    return found.key
  }
  if (!app.isPackaged && !process.env.HUMBLECHAT_NO_AUTOKEY) {
    const key = generateKey()
    fs.writeFileSync(path.join(ROOT, 'group.key'), key + '\n', { mode: 0o600 })
    saveKey(key)
    return key
  }
  return null
}

let network = null

function readNetwork() {
  network = loadNetwork({
    userDataDir: app.getPath('userData'),
    resourcesDir: app.isPackaged ? process.resourcesPath : null,
    repoRoot: app.isPackaged ? null : ROOT
  })
}

async function startNode(key) {
  readNetwork()
  currentKey = key
  let { bootstrap } = network
  let dhtOpts = {}
  if (process.env.HUMBLECHAT_BOOTSTRAP) { // solo pruebas: DHT local en vez de la pública
    bootstrap = [process.env.HUMBLECHAT_BOOTSTRAP]
    dhtOpts = { host: '127.0.0.1' }
  }
  node = new ChatNode({ dir: path.join(app.getPath('userData'), 'data'), groupKey: key, bootstrap, dhtOpts })
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
    const touched = new Set() // mensajes cuya edición/reacciones/fijado/vista previa han cambiado
    let channelsChanged = false
    for (const ev of list) {
      if (ev.t === 'msg') evs.push(node.store.decorate(ev))
      else if (ev.t === 'dm') { const d = node.openDm(ev); if (d) evs.push(d) } // solo los que son para nosotros, ya descifrados
      else if (ev.t === 'edit' || ev.t === 'react' || ev.t === 'pin' || ev.t === 'emb') touched.add(ev.x)
      else if (ev.t === 'chan') channelsChanged = true
      else evs.push(ev)
    }
    if (channelsChanged) send('channels', { channels: node.store.channels() })
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

/** Vista previa del primer enlace de un mensaje propio: se pide desde aquí (nunca desde los demás) y se reparte firmada. */
async function previewFor(ev) {
  const url = extractUrl(ev.text)
  if (!url) return
  try {
    const meta = await fetchPreview(url, process.env.HUMBLECHAT_TEST_PREVIEW ? { allowPrivate: true } : {})
    if (meta && node) node.embed(`${ev.a}:${ev.n}`, meta)
  } catch {}
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

function createWindow(page = 'index') {
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
    if (process.env.HUMBLECHAT_HIDDEN) return
    if (!(START_HIDDEN && tray)) win.show()
  })
  let boundsTimer = null
  for (const evt of ['resize', 'move']) win.on(evt, () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 600) })
  // Cerrar la ventana: con bandeja disponible la aplicación sigue abierta (y la llamada, si la hay);
  // sin ella, si estás en una llamada se pregunta antes de cortarla.
  win.on('close', (e) => {
    saveBounds()
    if (forceClose || quitting) return
    if (tray && settings.get('tray')) {
      e.preventDefault()
      win.hide()
      if (!trayNoticeShown && Notification.isSupported()) {
        trayNoticeShown = true
        new Notification({ title: 'HumbleChat sigue abierto', body: 'Está en la bandeja del sistema. Pulsa su icono para abrirlo; el menú tiene «Salir».' }).show()
      }
      return
    }
    if (!node?.voice) return
    e.preventDefault()
    dialog.showMessageBox(win, {
      type: 'question', buttons: ['Salir y colgar', 'Quedarme en la llamada'], defaultId: 1, cancelId: 1,
      title: 'Estás en una llamada', message: 'Estás en una llamada de voz.', detail: 'Si cierras HumbleChat, saldrás de la llamada.'
    }).then((r) => { if (r.response === 0) { forceClose = true; win?.close() } })
  })

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
  win.loadURL(`humble://app/${page}.html?platform=${process.platform}`)
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
        const audio = pendingAudio && IS_WIN // audio del sistema: solo Windows, opcional y experimental (puede incluir las voces de la llamada)
        pendingScreenId = null
        pendingAudio = false
        return callback({ video: { id, name: id }, ...(audio ? { audio: 'loopback' } : {}) })
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
      limits: { blob: LIMITS.blob, autoBlob: LIMITS.autoBlob, avatar: LIMITS.avatar, attachments: LIMITS.attachments, text: LIMITS.text, name: LIMITS.name, channelName: LIMITS.channelName },
      iceServers: network.iceServers,
      platform: process.env.HUMBLECHAT_FAKE_PLATFORM || process.platform, // solo pruebas: ver la barra de título de Windows
      pickerNeeded: !IS_WAYLAND, // en Wayland ya pregunta el portal del sistema
      settings: settings.all(),
      version: app.getVersion(),
      room: { fingerprint: fingerprint(currentKey) }
    }
  })
  handle('history', (_e, ch, opts) => {
    if (typeof ch !== 'string') return []
    return ch.startsWith('dm:') ? node.dmHistory(ch.slice(3), opts || {}) : node.history(ch, opts || {})
  })
  handle('send', (_e, m) => {
    const ev = node.send(m.ch, m.text, m.att, m.re)
    if (settings.get('linkPreviews')) previewFor(ev)
    return ev
  })
  handle('dm:send', (_e, to, text) => node.openDm(node.dm(to, text)))
  handle('around', (_e, ch, id) => (typeof ch === 'string' && typeof id === 'string' ? node.store.around(ch, id) : null))
  handle('pinned', (_e, ch) => node.store.pinned(String(ch)))
  handle('pin', (_e, id, on) => node.pin(String(id), !!on))
  handle('search', (_e, q, ch) => node.search(String(q || '').slice(0, 200), { ch: typeof ch === 'string' ? ch : null }))
  handle('channel:create', (_e, kind, name) => node.createChannel(kind === 'voice' ? 'voice' : 'text', name))
  handle('channel:rename', (_e, id, name) => node.renameChannel(String(id), name))
  handle('channel:delete', (_e, id) => node.deleteChannel(String(id)))
  handle('avatar:set', (_e, data) => node.setAvatar(data ? Buffer.from(data) : null))
  handle('blob:fetch', (_e, hash) => /^[0-9a-f]{64}$/.test(hash) ? node.whenBlob(hash, 10 * 60 * 1000).then(() => true) : false)
  handle('blob:progress', (_e, hash) => (/^[0-9a-f]{64}$/.test(hash) ? node.blobProgress(hash) : { done: false, got: 0, total: 0 }))
  handle('edit', (_e, id, text) => node.edit(id, text))
  handle('react', (_e, id, emoji, on) => node.react(id, emoji, on))
  handle('typing', (_e, ch) => node.typing(ch))
  handle('remove', (_e, id) => node.remove(id))
  handle('setName', (_e, name) => node.setName(name))
  handle('setVoice', (_e, v) => node.setVoice(v))
  handle('signal', (_e, to, data) => node.signal(to, data))
  handle('addBlob', (_e, { data, name, mime, w, ht }) => {
    if (typeof mime !== 'string' || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mime) || mime.length > 80) mime = 'application/octet-stream'
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
  handle('chooseScreen', (_e, id, audio) => { pendingScreenId = typeof id === 'string' ? id : null; pendingAudio = !!audio })
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

  // ── Sala (llave del grupo) ──
  handle('room:info', () => ({ code: currentKey ? formatCode(currentKey) : null, fingerprint: currentKey ? fingerprint(currentKey) : null, envKey: !!process.env.HUMBLECHAT_KEY }))
  handle('room:join', async (_e, text) => {
    const key = parseCode(text)
    if (!key) throw new Error('Ese código no es válido. Tiene que ser el que te pasó tu amigo (64 letras y números).')
    await switchRoom(key)
    return true
  })
  handle('room:create', () => formatCode(generateKey())) // solo genera: el usuario lo copia y luego "entra" con room:join

  // ── Preferencias de la aplicación ──
  handle('settings:set', async (_e, patch) => {
    const all = settings.set(patch)
    if ('autostart' in patch) applyAutostart(all.autostart)
    if ('tray' in patch) await applyTray()
    return all
  })
  handle('badge', (_e, n) => setBadge(Number(n) || 0))
  handle('ptt:configure', (_e, cfg) => ptt.configure(cfg || {}))
  handle('ptt:record', () => ptt.record())
  handle('nat:check', async () => { const r = await checkNat(); return { type: r.type, text: EXPLAIN[r.type] } })

  // ── Actualizaciones ──
  handle('update:install', () => updates?.install())
  handle('update:check', () => updates?.check())
}

/** Cambiar de sala sin reiniciar: se guarda la llave, se arranca la red de nuevo y se recarga la interfaz. */
async function switchRoom(key) {
  if (process.env.HUMBLECHAT_KEY) throw new Error('La llave está fijada por la variable HUMBLECHAT_KEY.')
  saveKey(key)
  if (node) { await node.stop().catch(() => {}); node = null }
  rendererReady = false
  await startNode(key)
  if (win && !win.isDestroyed()) win.loadURL(`humble://app/index.html?platform=${process.platform}`)
}

// ───────────── Integración con el sistema: bandeja, inicio automático, insignia ─────────────
async function applyTray() {
  const want = settings.get('tray') && trayOk
  if (want && !tray) {
    try {
      tray = createTray({ onShow: showWindow, onToggleMute: () => send('toggleMute', {}), onQuit: () => { forceClose = true; app.quit() } })
    } catch { tray = null }
  } else if (!want && tray) { tray.destroy(); tray = null }
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function applyAutostart(on) {
  if (!app.isPackaged) return // en desarrollo registraría el binario de Electron
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: on, path: exe, args: ['--hidden'] })
    } else if (process.platform === 'linux') {
      const dir = path.join(os.homedir(), '.config', 'autostart')
      const file = path.join(dir, 'humblechat.desktop')
      if (on) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=HumbleChat\nExec="${exe}" --hidden\nIcon=humblechat\nX-GNOME-Autostart-enabled=true\n`)
      } else fs.rmSync(file, { force: true })
    }
  } catch {}
}

function setBadge(n) {
  try {
    if (process.platform === 'win32' && win && !win.isDestroyed()) {
      win.setOverlayIcon(n > 0 ? nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'badge.png')) : null, n > 0 ? 'Mensajes sin leer' : '')
    } else app.setBadgeCount(n)
  } catch {}
}

// ───────────── Ciclo de vida ─────────────
app.on('second-instance', showWindow)
app.on('activate', showWindow)

app.on('before-quit', (e) => {
  if (quitting || !node) return
  e.preventDefault()
  quitting = true
  updates?.stop()
  const done = () => app.exit(0)
  node.stop().then(done, done)
  setTimeout(done, 2500).unref?.() // no te quedes colgado si la red no responde
})

app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  settings = createSettings(app.getPath('userData'))
  registerProtocol()
  setupSession()
  setupIpc()
  readNetwork()
  ptt.init(send)
  trayOk = await trayHostAvailable()
  const key = resolveKey()
  if (key) await startNode(key)
  powerMonitor.on('suspend', () => node?.suspend())
  powerMonitor.on('resume', () => node?.resume())
  await applyTray()
  createWindow(key ? 'index' : 'setup')
  applyAutostart(settings.get('autostart'))
  updates = startUpdates({ send, enabled: () => settings.get('updates') })
})
