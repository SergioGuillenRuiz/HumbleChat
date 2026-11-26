'use strict'
// Prueba de humo multiplataforma: dos instancias (la app del repo o una ya empaquetada con HC_EXE)
// se encuentran por una DHT local, chatean y entran a una llamada con audio.
//   Linux sin pantalla:  xvfb-run -a node test/smoke.js      Windows:  node test/smoke.js
const { startNet, launch, waitFor, capturarFallo } = require('./lib')

;(async () => {
  const net = await startNet()
  const a = await launch(net, 'Ana')
  const b = await launch(net, 'Beto')
  try {
    await waitFor(async () => (await a.page.locator('.member:not(.offline)').count()) === 2, 40000, 'se encuentran')
    console.log('  ok: se encuentran')
    await a.page.fill('.composer textarea', 'hola desde ' + process.platform)
    await a.page.keyboard.press('Enter')
    await waitFor(async () => (await b.page.locator('.msg:has-text("hola desde")').count()) === 1, 15000, 'mensaje')
    console.log('  ok: mensaje')
    for (const p of [a, b]) await p.page.locator('.vch .ch', { hasText: 'General' }).click()
    await waitFor(async () => (await b.page.locator('.vuser:has-text("Ana").speaking').count()) > 0, 40000, 'audio de voz')
    console.log('  ok: audio de voz entre instancias')
    console.log('SMOKE OK en ' + process.platform + (process.env.HC_EXE ? ' (app empaquetada)' : ''))
  } catch (e) {
    console.error('SMOKE FALLO:', e.message)
    process.exitCode = 1
    await capturarFallo('smoke') // si falla en CI, que el registro y los artefactos digan por qué
  } finally {
    await a.app.close().catch(() => {})
    await b.app.close().catch(() => {})
    await net.testnet.destroy().catch(() => {})
    process.exit(process.exitCode || 0)
  }
})()
