'use strict'
// Bloqueo por versión obsoleta con Electron real. Un servidor local hace de "GitHub" y publica la versión que se quiera.
//   Obsoleta al arrancar → pantalla de actualización y NINGUNA conexión de red
//   Al día / sin conexión → arranca normal
//   Sin conexión pero con una versión más nueva vista antes → bloqueada
//   Aparece una versión nueva con la aplicación abierta → plazo de gracia, bloqueo y red cortada
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { startNet, launch, waitFor, sleep, capturarFallo } = require('./lib')

let passed = 0
const ok = (m) => { passed++; console.log('  ✔ ' + m) }
const count = (p, sel) => p.page.locator(sel).count()

const state = { version: '9.9.9', down: false }
const server = http.createServer((req, res) => {
  if (state.down) return req.socket.destroy()
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ tag_name: 'v' + state.version, html_url: 'http://localhost/descarga' }))
})

function profile(name, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-gate-'))
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'data', 'identity.json'), JSON.stringify({ seed: crypto.randomBytes(32).toString('hex'), name }))
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings))
  return dir
}

;(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/`
  const gateEnv = (extra = {}) => ({ HUMBLECHAT_NO_UPDATE_GATE: '', HUMBLECHAT_UPDATE_URL: url, ...extra })
  const net = await startNet()
  const apps = []
  const open = async (name, o = {}) => { const p = await launch(net, name, o); apps.push(p); return p }
  try {
    console.log('Versión obsoleta al arrancar')
    state.version = '9.9.9'
    const ana = await open('Ana', { env: gateEnv(), ready: '#gate-download' })
    const texto = await ana.page.textContent('#gate')
    if (!/Actualización obligatoria/.test(texto) || !/9\.9\.9/.test(texto)) throw new Error('la pantalla no explica la actualización: ' + texto)
    ok('la pantalla de actualización obligatoria nombra la versión 9.9.9')
    if ((await count(ana, '.sb-header')) || (await count(ana, '.composer'))) throw new Error('se ve la aplicación')
    ok('no hay chat ni interfaz detrás: solo la actualización')
    const beto = await open('Beto')
    await sleep(9000)
    if ((await count(beto, '.member:not(.offline)')) !== 1) throw new Error('Beto ve a alguien: la red de Ana está en marcha')
    ok('la red de Ana no arrancó: nadie la ve en la sala')
    await ana.app.close(); await beto.app.close(); apps.length = 0

    console.log('Al día, y sin conexión sin nada visto antes')
    state.version = '0.0.1'
    const a2 = await open('Ana', { env: gateEnv() })
    const b2 = await open('Beto')
    await waitFor(async () => (await count(b2, '.member:not(.offline)')) === 2, 25000, 'Beto ve a Ana con la versión al día')
    ok('con la versión al día arranca y se encuentra con sus amigos')
    await a2.app.close(); await b2.app.close(); apps.length = 0
    state.down = true
    const a3 = await open('Ana', { env: gateEnv() })
    await a3.page.waitForSelector('.composer')
    ok('sin poder comprobar la versión no se bloquea')
    await a3.app.close(); apps.length = 0

    console.log('Sin conexión, pero ya se vio una versión más nueva')
    const a4 = await open('Ana', { profile: profile('Ana', { latestSeen: '9.9.9' }), env: gateEnv(), ready: '#gate-download' })
    if (!/No hay conexión para comprobarlo/.test(await a4.page.textContent('#gate'))) throw new Error('no explica el motivo')
    ok('queda bloqueada y dice que no pudo comprobarlo pero ya conocía la versión nueva')
    await a4.app.close(); apps.length = 0
    state.down = false

    console.log('Versión nueva con la aplicación abierta')
    state.version = '0.0.1'
    const e = { HUMBLECHAT_UPDATE_INTERVAL_MS: '1000', HUMBLECHAT_UPDATE_GRACE_MS: '2500' }
    const a5 = await open('Ana', { env: gateEnv(e) })
    const b5 = await open('Beto')
    await waitFor(async () => (await count(b5, '.member:not(.offline)')) === 2, 25000, 'se ven antes de publicar la versión nueva')
    state.version = '9.9.9'
    await a5.page.waitForSelector('.update-bar', { timeout: 15000 })
    if (!/obligatoria/.test(await a5.page.textContent('.update-bar'))) throw new Error('el aviso previo no dice que es obligatoria')
    ok('aparece el aviso con la cuenta atrás y sigue pudiéndose usar durante el plazo')
    await a5.page.waitForSelector('.gate-overlay #gate-download', { timeout: 15000 })
    if (!/9\.9\.9/.test(await a5.page.textContent('.gate-overlay'))) throw new Error('la capa no nombra la versión')
    ok('pasado el plazo, una capa tapa toda la aplicación')
    await waitFor(async () => (await count(b5, '.member:not(.offline)')) === 1, 25000, 'Beto deja de ver a Ana')
    ok('la red se corta: Beto ve a Ana desconectada')
    console.log(`\n${passed} comprobaciones OK`)
  } catch (err) {
    console.error('\nFALLO:', err.message)
    await capturarFallo('gate')
    process.exitCode = 1
  } finally {
    for (const p of apps) await p.app.close().catch(() => {})
    await net.testnet.destroy().catch(() => {})
    server.closeAllConnections?.()
    server.close()
    process.exit(process.exitCode || 0)
  }
})()
