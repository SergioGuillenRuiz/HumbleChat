'use strict'
// Prueba de humo multiplataforma: dos instancias (la app del repo o una ya empaquetada con HC_EXE)
// se encuentran por una DHT local, chatean y entran a una llamada con audio.
//   Linux sin pantalla:  xvfb-run -a node test/smoke.js      Windows:  node test/smoke.js
const { startNet, launch, waitFor } = require('./lib')

// Estado de voz y pestaña Diagnóstico de cada instancia, para poder analizar un fallo intermitente sin reproducirlo.
async function volcarDiagnostico(instancias) {
  for (const [nombre, p] of instancias) {
    try {
      console.error(`--- Diagnóstico de ${nombre} ---`)
      console.error('Usuarios en la llamada:', JSON.stringify(await p.page.$$eval('.vuser', (els) => els.map((e) => ({ texto: e.textContent.trim().slice(0, 30), clases: e.className })))))
      await p.page.locator('.up-btns .icon-btn').last().click({ timeout: 5000 })
      await p.page.locator('.st-item', { hasText: 'Diagnóstico' }).click({ timeout: 5000 })
      await p.page.waitForTimeout(2500)
      console.error(await p.page.locator('pre.diag').textContent({ timeout: 5000 }))
    } catch (err) { console.error(`(no se pudo obtener el diagnóstico de ${nombre}: ${err.message})`) }
  }
}

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
    // si falla en CI, que el registro diga por qué; con tope de tiempo para que una ventana colgada no retrase la salida
    await Promise.race([volcarDiagnostico([['Ana', a], ['Beto', b]]), new Promise((r) => setTimeout(r, 30000))])
  } finally {
    await a.app.close().catch(() => {})
    await b.app.close().catch(() => {})
    await net.testnet.destroy().catch(() => {})
    process.exit(process.exitCode || 0)
  }
})()
