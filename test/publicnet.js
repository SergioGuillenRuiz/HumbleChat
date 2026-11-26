'use strict'
// Prueba con Internet de verdad: dos máquinas distintas (por ejemplo, un runner Linux y uno Windows de GitHub, en
// redes distintas) usan la DHT pública de Hyperswarm y los STUN públicos, se encuentran, chatean y hablan.
// Cada máquina ejecuta este script con su papel y la MISMA llave de sala; se sincronizan por el propio chat.
//   node test/publicnet.js ana  <llave-hex-64>
//   node test/publicnet.js beto <llave-hex-64>
// Salida: 0 todo bien · 1 no se encontraron o el chat falló · 3 chat bien pero la voz no se estableció.
const fs = require('fs')
const { launch, waitFor, sleep, capturarFallo } = require('./lib')

const [role, key] = process.argv.slice(2)
if (!['ana', 'beto'].includes(role) || !/^[0-9a-f]{64}$/i.test(key || '')) {
  console.error('Uso: node test/publicnet.js <ana|beto> <llave-hex-de-64-caracteres>')
  process.exit(2)
}
const me = role === 'ana' ? 'Ana' : 'Beto'
const other = role === 'ana' ? 'Beto' : 'Ana'
const SLOW = Number(process.env.HC_PUBLIC_WAIT_MS) || 8 * 60 * 1000 // las dos máquinas no arrancan a la vez

const report = {}
function summary(lines) {
  const text = lines.join('\n') + '\n'
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
}

;(async () => {
  let inst
  let code = 0
  try {
    inst = await launch({ key, bootstrap: process.env.HC_BOOTSTRAP || null }, me, { fakeMedia: true, env: { HUMBLECHAT_UPDATE_DELAY: '3600000' } })
    const { page } = inst
    const say = async (text) => { await page.fill('.composer textarea', text); await page.keyboard.press('Enter') }
    const seen = (text) => page.locator(`.msg:has-text("${text}")`).count().then((n) => n > 0)

    // 1. Encontrarse por la DHT pública (la otra máquina puede tardar minutos en arrancar)
    const t0 = Date.now()
    await waitFor(async () => (await page.locator('.member:not(.offline)').count()) >= 2, SLOW, `encontrar a ${other} por la DHT pública`)
    report.encontrado = Date.now() - t0
    console.log(`${me}: ${other} encontrado en ${Math.round(report.encontrado / 1000)} s`)

    // 2. Chat en los dos sentidos
    const t1 = Date.now()
    await say(`hola de ${me} desde ${process.platform}`)
    await waitFor(() => seen(`hola de ${other}`), 90000, `mensaje de ${other}`)
    report.chat = Date.now() - t1

    // 3. Voz (informativa: depende de lo que permitan las redes de los runners)
    const t2 = Date.now()
    try {
      await page.locator('.vch .ch', { hasText: 'General' }).click()
      await waitFor(async () => (await page.locator(`.vuser:has-text("${other}").speaking`).count()) > 0, 120000, `oír a ${other}`)
      report.voz = Date.now() - t2
      await sleep(3000)
      const diag = await page.evaluate(async () => (await import('/voice.js')).diagnostics())
      report.camino = diag.map((d) => d.path).join(' | ')
    } catch (e) {
      report.vozError = e.message
      code = 3
    }

    // 4. No cerrar antes de que el otro termine (el canal de voz oculta el chat: se vuelve a #general)
    await page.locator('.ch', { hasText: 'general' }).first().click()
    await say(`fin de ${me}`)
    await waitFor(() => seen(`fin de ${other}`), 3 * 60 * 1000, `cierre de ${other}`).catch(() => {})
  } catch (e) {
    report.error = e.message
    code = 1
    if (inst) await capturarFallo(`publica-${me}`)
  } finally {
    await inst?.app.close().catch(() => {})
    const s = (ms) => (ms == null ? '—' : `${Math.round(ms / 1000)} s`)
    summary([
      `### DHT pública: ${me} (${process.platform})`,
      `- Encontrar a ${other}: ${s(report.encontrado)}`,
      `- Chat en los dos sentidos: ${s(report.chat)}`,
      `- Voz: ${report.voz != null ? `${s(report.voz)} · ${report.camino}` : `no se estableció (${report.vozError || 'sin datos'})`}`,
      ...(report.error ? [`- **Error:** ${report.error}`] : [])
    ])
    process.exit(code)
  }
})()
