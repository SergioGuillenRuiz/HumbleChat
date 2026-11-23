'use strict'
// Prueba de extremo a extremo con instancias REALES de Electron sobre una DHT local.
//   xvfb-run -a node test/e2e.js        (en Linux sin pantalla)
// Cubre: descubrimiento sin configurar, chat, imágenes, borrado, no leídos, voz (audio real por
// WebRTC con micro falso), pantalla compartida y que todo siga si el primero en entrar se va.
const fs = require('fs')
const path = require('path')
const { startNet, launch, sleep, waitFor } = require('./lib')

const SHOTS = path.join(__dirname, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const shot = (p, n) => p.page.screenshot({ path: path.join(SHOTS, n + '.png') })
const say = async (p, text) => { await p.page.fill('.composer textarea', text); await p.page.keyboard.press('Enter') }
const count = (p, sel) => p.page.locator(sel).count()
let passed = 0
const ok = (msg) => { passed++; console.log('  ✔', msg) }

;(async () => {
  const net = await startNet()
  const apps = []
  const spawn = async (name, o) => { const p = await launch(net, name, o); apps.push(p); return p }
  try {
    console.log('Descubrimiento automático (nadie configura nada)')
    const a = await spawn('Sergio') // el primero: hostea la sesión
    await waitFor(async () => (await count(a, '.sb-status')) === 0, 15000, 'A conectado a la red')
    ok('el primero se queda solo y conectado, sin tocar nada')
    const b = await spawn('Marta')
    const c = await spawn('Pablo')
    for (const p of [a, b, c]) await waitFor(async () => (await count(p, '.member:not(.offline)')) === 3, 20000, p.name + ' ve a los 3')
    ok('los 3 se encuentran entre sí')

    console.log('Chat')
    await say(a, 'Hola equipo 👋 esto es **HumbleChat**')
    await say(b, 'Funciona `código` y _cursiva_')
    await waitFor(async () => (await count(c, '.msg')) === 2, 10000, 'C recibe 2 mensajes')
    ok('mensajes llegan a todos')
    const bold = await c.page.locator('.msg strong').first().textContent()
    if (bold !== 'HumbleChat') throw new Error('markdown roto: ' + bold)
    ok('markdown renderizado')

    console.log('Imágenes')
    const png = await a.page.screenshot() // una imagen real
    await b.page.setInputFiles('input[type=file]', { name: 'captura.png', mimeType: 'image/png', buffer: png })
    await waitFor(async () => (await count(b, '.pend')) === 1, 5000, 'adjunto pendiente')
    await b.page.keyboard.press('Enter') // el foco sigue en el textarea
    for (const p of [a, c]) {
      await waitFor(() => p.page.evaluate(() => { const i = document.querySelector('img.att'); return !!i && i.complete && i.naturalWidth > 0 }), 15000, p.name + ' carga la imagen')
    }
    ok('la imagen se replica y se ve en los demás')
    await shot(c, '03-imagen')

    console.log('Borrar mensaje propio')
    const mine = a.page.locator('.msg', { hasText: 'Hola equipo' })
    await mine.hover()
    await mine.locator('.m-actions button').click()
    await a.page.locator('.modal .btn.danger').click()
    for (const p of [a, b, c]) await waitFor(async () => (await count(p, '.msg:has-text("Hola equipo")')) === 0, 8000, p.name + ' ve el borrado')
    ok('el borrado se replica')

    console.log('No leídos')
    await c.page.locator('.ch', { hasText: 'fotos' }).click()
    await say(a, 'mensaje en general')
    await waitFor(async () => (await count(c, '.ch.unread')) === 1, 8000, 'C ve el canal sin leer')
    await shot(c, '04-no-leido')
    await c.page.locator('.ch', { hasText: 'general' }).first().click()
    await waitFor(async () => (await count(c, '.ch.unread')) === 0, 5000, 'se limpia al leer')
    ok('indicador de no leído aparece y se limpia')

    console.log('Voz (WebRTC, micro falso)')
    await a.page.locator('.vch .ch', { hasText: 'General' }).click()
    await waitFor(async () => (await count(a, '.callpanel')) === 1, 8000, 'A en llamada')
    await b.page.locator('.vch .ch', { hasText: 'General' }).click()
    await waitFor(async () => (await count(b, '.vuser')) === 2, 8000, 'B ve a los 2 en la sala')
    ok('entrar a un canal de voz se refleja en los demás')
    // El micro falso emite pitidos: si B oye a A, su medidor marca "hablando" => audio real por WebRTC.
    await waitFor(async () => (await count(b, '.vuser:has-text("Sergio").speaking')) > 0, 25000, 'B oye a Sergio')
    ok('el audio viaja de A a B (detectado en el receptor)')
    await waitFor(async () => (await count(a, '.vuser:has-text("Marta").speaking')) > 0, 25000, 'A oye a Marta')
    ok('y de B a A')
    await shot(b, '05-voz')

    console.log('Pantalla compartida')
    await a.page.locator('.round[title="Compartir pantalla"]').click()
    await a.page.locator('.src-card').first().click()
    await waitFor(async () => (await count(a, '.tile-live')) > 0, 15000, 'A en directo')
    await waitFor(async () => (await count(b, '.tile-watch')) > 0, 10000, 'B ve el botón de ver')
    await b.page.locator('.tile-watch').click()
    await waitFor(() => b.page.evaluate(() => { const v = document.querySelector('.theater video'); return !!v && v.videoWidth > 0 }), 20000, 'B recibe vídeo')
    ok('B ve la pantalla de A (vídeo real recibido)')
    await sleep(500)
    await shot(b, '06-pantalla')
    await a.page.locator('.round.on').click() // dejar de compartir
    await waitFor(async () => (await count(b, '.theater')) === 0, 10000, 'B deja de ver al cortar')
    ok('al dejar de compartir se limpia la vista')

    console.log('Si el primero se va, la sesión sigue')
    const profileA = a.profile
    await a.app.close()
    await waitFor(async () => (await count(b, '.member.offline')) === 1, 25000, 'B ve a A fuera')
    ok('B y C notan que A se fue')
    await b.page.locator('.ch', { hasText: 'general' }).first().click() // B estaba en la vista de voz
    await say(b, 'sigo aquí sin el primero')
    await waitFor(async () => (await count(c, '.msg:has-text("sigo aquí sin el primero")')) === 1, 8000, 'C recibe sin A')
    ok('B y C siguen chateando sin host')
    const a2 = await spawn('Sergio', { profile: profileA })
    await waitFor(async () => (await count(a2, '.msg:has-text("sigo aquí sin el primero")')) === 1, 20000, 'A vuelve y se pone al día')
    ok('A vuelve y recupera lo que se perdió')
    await shot(a2, '07-vuelve')

    console.log(`\n${passed} comprobaciones OK`)
  } catch (e) {
    console.error('\nFALLO:', e.message)
    for (const p of apps) await shot(p, 'fallo-' + p.name).catch(() => {})
    process.exitCode = 1
  } finally {
    for (const p of apps) await p.app.close().catch(() => {})
    await net.testnet.destroy().catch(() => {})
    process.exit(process.exitCode || 0)
  }
})()
