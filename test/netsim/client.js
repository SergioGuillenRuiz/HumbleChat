'use strict'
// Un cliente de la simulación de red. Se ejecuta DENTRO de un espacio de red (lo lanza test/netsim.js) y mide
// con una instancia real de Electron: tiempo hasta verse con los demás, chat y voz, y por dónde viaja el audio.
// Los clientes se sincronizan con ficheros en un directorio compartido (el sistema de ficheros no se aísla).
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { launch, sleep, waitFor, volcarDiagnostico } = require('../lib')

const { HC_NAME: name, HC_KEY: key, HC_BOOT: bootstrap, HC_DIR: dir } = process.env
const peers = (process.env.HC_PEERS || '').split(',').filter(Boolean)
const minVisible = Number(process.env.HC_MIN_VISIBLE) || peers.length + 1 // con NAT simétrico no todos se ven directamente
const turn = process.env.HC_TURN ? JSON.parse(process.env.HC_TURN) : null

const mark = (k) => fs.writeFileSync(path.join(dir, `${k}-${name}`), String(Date.now()))
async function barrier(k, ms = 120000) { // espera a que todos hayan marcado la fase k (o se agote el tiempo)
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (peers.every((p) => fs.existsSync(path.join(dir, `${k}-${p}`)))) return true
    await sleep(250)
  }
  return false
}

;(async () => {
  const result = { name, errors: [] }
  const t0 = Date.now()
  let inst = null
  const step = async (label, fn) => {
    try { await fn() } catch (e) {
      result.errors.push(`${label}: ${e.message}`)
      if (inst && !result.dumped) { result.dumped = true; await Promise.race([volcarDiagnostico([[name, inst]]), sleep(20000)]) } // queda en el registro del cliente
    }
  }
  try {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-net-'))
    fs.mkdirSync(path.join(profile, 'data'), { recursive: true })
    fs.writeFileSync(path.join(profile, 'data', 'identity.json'), JSON.stringify({ seed: crypto.randomBytes(32).toString('hex'), name }))
    fs.writeFileSync(path.join(profile, 'network.json'), JSON.stringify({ stun: ['11.99.0.1:3478'], ...(turn ? { turn: [turn] } : {}) }))
    inst = await launch({ key, bootstrap }, name, { profile, env: { HUMBLECHAT_DHT_HOST: '0.0.0.0' } })
    const { page } = inst
    result.launchMs = Date.now() - t0
    mark('lanzado')

    // 1. Verse con todos
    const t1 = Date.now()
    await step('conexión', async () => {
      await waitFor(async () => (await page.locator('.member:not(.offline)').count()) >= minVisible, Number(process.env.HC_CONNECT_MS) || 120000, `verse con ${minVisible - 1} amigo(s)`)
      result.connectMs = Date.now() - t1
    })
    mark('conectado')
    await barrier('conectado')

    // 2. Chat: cada uno saluda y lee a todos
    const t2 = Date.now()
    await step('chat', async () => {
      await page.fill('.composer textarea', `hola de ${name}`)
      await page.keyboard.press('Enter')
      for (const p of peers) await waitFor(async () => (await page.locator(`.msg:has-text("hola de ${p}")`).count()) >= 1, 60000, `mensaje de ${p}`)
      result.chatMs = Date.now() - t2
    })
    mark('chat')
    await barrier('chat')

    // 3. Voz: todos entran y deben oír a todos
    const t3 = Date.now()
    await step('voz', async () => {
      await page.locator('.vch .ch', { hasText: 'General' }).click()
      for (const p of peers) await waitFor(async () => (await page.locator(`.vuser:has-text("${p}").speaking`).count()) > 0, 90000, `oír a ${p}`)
      result.voiceMs = Date.now() - t3
      await sleep(3000) // deja que las estadísticas se estabilicen
      const diag = await page.evaluate(async () => (await import('/voice.js')).diagnostics())
      result.paths = diag.map((d) => d.path)
      result.states = diag.map((d) => d.state)
    })
    mark('voz')
    await barrier('voz')
  } catch (e) {
    result.errors.push(`general: ${e.message}`)
  } finally {
    fs.writeFileSync(path.join(dir, `resultado-${name}.json`), JSON.stringify(result))
    mark('fin')
    await barrier('fin', 30000) // no cerrar antes que los demás: los otros aún pueden necesitarte
    await inst?.app.close().catch(() => {})
    process.exit(0)
  }
})()
