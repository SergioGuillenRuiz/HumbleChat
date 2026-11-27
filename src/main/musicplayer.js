'use strict'
// Reproductor de «Escuchar juntos» (música de YouTube sincronizada en la llamada).
//
// El audio NO pasa por la llamada: cada persona reproduce su copia desde YouTube y la interfaz las mantiene sincronizadas.
// El reproductor de YouTube vive aquí, en una ventana oculta y APARTE de la aplicación: sin acceso a nada de ella, con una sesión
// propia en memoria (nada de cookies de YouTube en la sesión de la app), sin permisos y sin poder navegar. La interfaz le manda
// órdenes por el proceso principal y recibe de vuelta su estado.
//
// La página se sirve desde un servidor local (127.0.0.1) y no desde humble:// porque el reproductor de YouTube exige saber desde qué
// página http(s) se incrusta (referer); con un esquema propio contesta con un error de «configuración del reproductor».
const http = require('http')
const fs = require('fs')
const path = require('path')
const { BrowserWindow, session, ipcMain, net } = require('electron')
const { fetchMeta, fetchThumb } = require('./ytmeta')

const DIR = path.join(__dirname, 'player')
const FILES = { '/player.html': 'text/html; charset=utf-8', '/player.js': 'text/javascript; charset=utf-8', '/fake-yt.js': 'text/javascript; charset=utf-8' }
const ID = /^[\w-]{11}$/
const N = /^[\w-]{4,24}$/
const STATES = new Set(['none', 'loading', 'playing', 'paused', 'buffering', 'ended', 'error'])
const num = (x, min, max) => Math.min(Math.max(Number.isFinite(Number(x)) ? Number(x) : 0, min), max)

/** Una orden de la interfaz, saneada (o null). */
function cleanCommand(c) {
  switch (c?.op) {
    case 'load':
      if (typeof c.v !== 'string' || !ID.test(c.v) || typeof c.n !== 'string' || !N.test(c.n)) return null
      return { op: 'load', v: c.v, n: c.n, pos: num(c.pos, 0, 86400), play: !!c.play }
    case 'seek': return { op: 'seek', pos: num(c.pos, 0, 86400) }
    case 'volume': return { op: 'volume', vol: Math.round(num(c.vol, 0, 100)), mute: !!c.mute }
    case 'play': case 'pause': case 'stop': return { op: c.op }
    default: return null
  }
}

/** Un evento del reproductor, saneado (o null). */
function cleanEvent(e) {
  if (!e || !['state', 'tick', 'error'].includes(e.e)) return null
  return {
    e: e.e,
    n: typeof e.n === 'string' && N.test(e.n) ? e.n : null,
    st: STATES.has(e.st) ? e.st : 'none',
    pos: num(e.pos, 0, 86400),
    dur: num(e.dur, 0, 86400),
    vid: typeof e.vid === 'string' && ID.test(e.vid) ? e.vid : null,
    ...(e.e === 'error' ? { code: Math.trunc(num(e.code, -9, 1000)) } : {})
  }
}

/**
 * @param {object} o
 * @param {(evt: object) => void} o.onEvent lo que cuenta el reproductor (para la interfaz)
 * @param {boolean} [o.fake] pruebas: YT simulado y datos de vídeo inventados (sin red)
 */
function createMusicPlayer({ onEvent, fake = false }) {
  let server = null
  let port = 0
  let win = null
  let volume = { op: 'volume', vol: 60, mute: false }
  let opening = null

  async function ensureServer() {
    if (server) return
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x')
      const type = FILES[u.pathname]
      // El «Host» se comprueba para que una página cualquiera no pueda leer esto resolviendo su dominio a 127.0.0.1
      if (!type || (u.pathname === '/fake-yt.js' && !fake) || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(404); return res.end() }
      fs.readFile(path.join(DIR, u.pathname), (err, body) => {
        if (err) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(body)
      })
    })
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve) })
    server = s
    port = s.address().port
  }

  async function openWindow() {
    await ensureServer()
    const ses = session.fromPartition('humblechat-music') // en memoria: no persiste nada
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    const w = new BrowserWindow({
      show: false, width: 480, height: 320, skipTaskbar: true, focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'player-preload.js'),
        session: ses,
        contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
        backgroundThrottling: false, // oculta, la música no debe pararse ni ir a trompicones
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    win = w
    const wc = w.webContents
    wc.setUserAgent(wc.getUserAgent().replace(/\s(?:Electron|humblechat)\/\S+/gi, '')) // un Chrome normal, como espera YouTube
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.on('render-process-gone', () => { if (win === w) win = null })
    w.on('closed', () => { if (win === w) win = null })
    await w.loadURL(`http://127.0.0.1:${port}/player.html${fake ? '?fake=1' : ''}`)
    return w
  }

  /** La ventana, creándola si hace falta (varias órdenes a la vez comparten la misma creación). */
  async function ensureWindow() {
    if (win && !win.isDestroyed()) return win
    opening ||= openWindow().finally(() => { opening = null })
    return opening
  }

  ipcMain.on('player:evt', (e, raw) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return // solo vale lo que cuenta NUESTRA ventana
    const evt = cleanEvent(raw)
    if (evt) onEvent(evt)
  })

  // Las órdenes se ejecutan de una en una y en orden: crear la ventana tarda y un «parar» no puede adelantarse a un «cargar».
  let chain = Promise.resolve()
  async function run(c) {
    if (c.op === 'volume') volume = c
    if (c.op === 'load') {
      const w = await ensureWindow()
      w.webContents.send('player:cmd', volume) // antes de la primera pista, para que no suene un instante a otro volumen
      w.webContents.send('player:cmd', c)
    } else if (win && !win.isDestroyed()) win.webContents.send('player:cmd', c)
  }

  return {
    /** Una orden de la interfaz. «Cargar» crea el reproductor si no existe; el resto sin reproductor no hace nada. */
    command(raw) {
      const c = cleanCommand(raw)
      if (!c) return false
      chain = chain.then(() => run(c)).catch((e) => console.warn('[musica]', e?.message || e))
      return chain.then(() => true)
    },
    /** Título y canal de un vídeo (null en la respuesta = no se pudo consultar). */
    async meta(id) {
      if (fake) return typeof id === 'string' && id[0] === 'N' ? { ok: false, reason: 'noembed' } : ID.test(id) ? { ok: true, title: 'Canción ' + id.slice(0, 5), author: 'Artista de prueba' } : { ok: false, reason: 'invalid' }
      return fetchMeta(id, (u, o) => net.fetch(u, o))
    },
    async thumb(id) { return fake ? null : fetchThumb(id, (u, o) => net.fetch(u, o)) },
    /** Cierra el reproductor (la música deja de sonar y no queda nada abierto). */
    close() { if (win && !win.isDestroyed()) win.destroy(); win = null },
    dispose() { this.close(); server?.close(); server = null },
    /** Solo pruebas: la ventana del reproductor. */
    _window: () => (win && !win.isDestroyed() ? win : null)
  }
}

module.exports = { createMusicPlayer, cleanCommand, cleanEvent }
