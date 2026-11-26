'use strict'
// Autoactualización REAL (solo Linux): se construyen dos AppImage (0.0.1 y 0.0.2), la vieja arranca contra un servidor
// local que publica la nueva, y se comprueba de punta a punta que el bloqueo por versión descarga la actualización
// con electron-updater, sustituye el fichero de la AppImage y vuelve a arrancar la aplicación nueva.
//   xvfb-run -a node test/autoupdate.js
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')

if (process.platform !== 'linux') { console.log('autoupdate: solo en Linux, se omite'); process.exit(0) }

const ROOT = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-autoupdate-'))
const MARK = 'hc-au-' + crypto.randomBytes(6).toString('hex')
let passed = 0
const ok = (m) => { passed++; console.log('  ✔ ' + m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

async function until(fn, ms, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(500) }
  throw new Error('timeout esperando: ' + what)
}

/** Procesos que llevan nuestra marca en el entorno (la aplicación reiniciada va desacoplada). */
function marked() {
  const out = []
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/environ`, 'latin1').includes(`AU_MARK=${MARK}`)) continue
      out.push({ pid: Number(pid), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0').join(' ').slice(0, 160) })
    } catch {}
  }
  return out
}
const killMarked = () => { for (const p of marked()) { try { process.kill(p.pid, 'SIGKILL') } catch {} } }

function build(version, out, feed) {
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'electron-builder'), ['--config', 'test/autoupdate/builder.config.js', '--linux', '--x64', '--publish', 'never'],
    { cwd: ROOT, env: { ...process.env, AU_OUT: out, AU_VERSION: version, AU_FEED: feed }, stdio: 'pipe' })
  return path.join(out, `HumbleChat-${version}-x86_64.AppImage`)
}

;(async () => {
  const hits = []
  const newDir = path.join(tmp, 'nuevo')
  // "GitHub" (última versión) y servidor de actualizaciones de electron-updater (con soporte de Range)
  const server = http.createServer((req, res) => {
    hits.push({ path: req.url, at: Date.now() })
    if (req.url === '/api/latest') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ tag_name: 'v0.0.2', html_url: 'http://localhost/descarga' })) }
    const file = path.join(newDir, decodeURIComponent(req.url.split('?')[0]))
    if (!file.startsWith(newDir + path.sep) || !fs.existsSync(file)) { res.statusCode = 404; return res.end() }
    const size = fs.statSync(file).size
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
    if (m) {
      const start = Number(m[1])
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' })
      return fs.createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  let app = null
  let log = ''
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'ensure-key.js')], { stdio: 'ignore' })
    console.log('Construyendo las AppImage 0.0.1 y 0.0.2…')
    const oldImage = build('0.0.1', path.join(tmp, 'viejo'), base + '/')
    const newImage = build('0.0.2', newDir, base + '/')
    const work = path.join(tmp, 'instalada')
    fs.mkdirSync(work, { recursive: true })
    const installed = path.join(work, 'HumbleChat.AppImage')
    fs.copyFileSync(oldImage, installed)
    fs.chmodSync(installed, 0o755)
    const before = sha(installed)
    const target = sha(newImage)
    if (before === target) throw new Error('las dos AppImage son iguales: la prueba no sirve')
    ok('dos AppImage distintas: 0.0.1 instalada y 0.0.2 publicada')

    console.log('Arranque de la versión vieja')
    // electron-updater relanza la AppImage SIN argumentos: lo que necesite el entorno de pruebas (sin sandbox) va por variable de entorno (ELECTRON_DISABLE_SANDBOX)
    app = spawn(installed, ['--disable-gpu'], {
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', AU_MARK: MARK, APPIMAGE_EXTRACT_AND_RUN: '1', HUMBLECHAT_NO_SANDBOX: '1', HUMBLECHAT_NO_UPDATE_GATE: '', HUMBLECHAT_PROFILE: path.join(tmp, 'perfil'), HUMBLECHAT_UPDATE_URL: base + '/api/latest', HUMBLECHAT_UPDATE_AUTO: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true
    })
    app.stdout.on('data', (d) => { log += d }); app.stderr.on('data', (d) => { log += d })
    await until(() => hits.some((h) => h.path === '/api/latest'), 60000, 'la app vieja consulta la última versión')
    ok('la app vieja consulta la última versión publicada antes de arrancar')
    await until(() => hits.some((h) => /latest-linux\.yml/.test(h.path)), 60000, 'el actualizador pide latest-linux.yml')
    ok('electron-updater consulta el servidor de actualizaciones (latest-linux.yml)')
    await until(() => hits.some((h) => /\.AppImage$/.test(h.path)), 60000, 'el actualizador descarga la AppImage nueva')
    ok('descarga la AppImage nueva')
    await until(() => sha(installed) === target, 120000, 'el fichero instalado pasa a ser la versión nueva')
    ok('la AppImage instalada se ha sustituido por la 0.0.2 (mismo contenido que la publicada)')
    const latestHitsBefore = hits.filter((h) => h.path === '/api/latest').length
    await until(() => hits.filter((h) => h.path === '/api/latest').length > latestHitsBefore, Number(process.env.AU_RELAUNCH_MS) || 90000, 'la aplicación nueva arranca y vuelve a consultar')
    ok('la aplicación se reinicia sola con la versión nueva')
    console.log(`\n${passed} comprobaciones OK`)
  } catch (e) {
    console.error('\nFALLO:', e.message)
    console.error('Peticiones al servidor:', hits.map((h) => h.path).join(' '))
    console.error('Procesos de la prueba que siguen vivos:', JSON.stringify(marked()))
    console.error('Salida de la aplicación (final):\n' + log.split('\n').slice(-25).join('\n'))
    process.exitCode = 1
  } finally {
    killMarked()
    server.closeAllConnections?.()
    server.close()
    // Se espera a que las aplicaciones mueran (siguen escribiendo en su perfil) y la limpieza nunca altera el resultado.
    for (let i = 0; i < 20 && marked().length; i++) { killMarked(); await sleep(250) }
    await sleep(1500) // los procesos recién matados terminan de soltar sus ficheros
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }) } catch (e) { console.error('(no se pudo borrar ' + tmp + ': ' + e.code + ')') }
    process.exit(process.exitCode || 0)
  }
})()
