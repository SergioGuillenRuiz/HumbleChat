'use strict'
// Utilidades para pruebas e2e: DHT local + varias instancias reales de Electron (Playwright).
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { _electron } = require('playwright')
const createTestnet = require('hyperdht/testnet')

const ROOT = path.join(__dirname, '..')
const electronPath = process.env.HC_EXE || require('electron') // HC_EXE: probar la app ya empaquetada
const packaged = !!process.env.HC_EXE

async function startNet() {
  const testnet = await createTestnet(3)
  const b = testnet.bootstrap[0]
  return { testnet, bootstrap: `${b.host}:${b.port}`, key: crypto.randomBytes(32).toString('hex') }
}

async function launch(net, name, { fakeMedia = true, size = [1280, 800], profile = null, env: extraEnv = {}, noKey = false, ready = '.sb-header' } = {}) {
  if (!profile) {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-e2e-'))
    fs.mkdirSync(path.join(profile, 'data'), { recursive: true })
    fs.writeFileSync(path.join(profile, 'data', 'identity.json'), JSON.stringify({ seed: crypto.randomBytes(32).toString('hex'), name }))
  }
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    HUMBLECHAT_PROFILE: profile,
    ...(net.bootstrap ? { HUMBLECHAT_BOOTSTRAP: net.bootstrap } : {}),
    ...(packaged || noKey ? {} : { HUMBLECHAT_KEY: net.key }), // empaquetada: usa la group.key incluida
    ...(noKey ? { HUMBLECHAT_NO_AUTOKEY: '1' } : {}),
    HUMBLECHAT_NO_SANDBOX: '1',
    ...(fakeMedia ? { HUMBLECHAT_FAKE_MEDIA: '1' } : {}),
    HUMBLECHAT_W: String(size[0]),
    HUMBLECHAT_H: String(size[1]),
    ...extraEnv
  }
  const app = await _electron.launch({ executablePath: electronPath, args: [...(packaged ? [] : [ROOT]), '--no-sandbox', '--disable-gpu'], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: size[0], height: size[1] }).catch(() => {})
  page.on('pageerror', (e) => console.log(`[${name}] pageerror:`, e.message))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name}] console.${m.type()}:`, m.text()) })
  await page.waitForSelector(ready, { timeout: 20000 })
  return { app, page, name, profile }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms = 15000, what = 'condición') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return } catch {}
    await sleep(100)
  }
  throw new Error('timeout esperando: ' + what)
}

module.exports = { startNet, launch, sleep, waitFor, ROOT }
