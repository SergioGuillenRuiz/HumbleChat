'use strict'
// Prueba de extremo a extremo con instancias REALES de Electron sobre una DHT local.
//   xvfb-run -a node test/e2e.js        (en Linux sin pantalla)
// Cubre: descubrimiento sin configurar, chat, imágenes, borrado, no leídos, voz (audio real por
// WebRTC con micro falso), pantalla compartida y que todo siga si el primero en entrar se va.
const fs = require('fs')
const path = require('path')
const { startNet, launch, sleep, waitFor } = require('./lib')
const { file: WAV } = require('./make-wav') // audio tipo voz para medir el bitrate real de Opus

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
  const spawn = async (name, o = {}) => { const p = await launch(net, name, { ...o, env: { HUMBLECHAT_FAKE_AUDIO_FILE: WAV, ...o.env } }); apps.push(p); return p }
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

    await waitFor(async () => (await count(a, '.cp-ping')) === 1, 15000, 'ping visible en el panel de llamada')
    ok('el panel de llamada muestra el ping')
    await a.page.locator('.up-btns .icon-btn').last().click() // Ajustes
    await a.page.locator('.st-item', { hasText: 'Diagnóstico' }).click()
    let kbps = 0
    await waitFor(async () => {
      const t = await a.page.locator('pre.diag').textContent()
      const m = /audio ↑ opus (\d+) kbps/.exec(t)
      kbps = m ? Number(m[1]) : 0
      return kbps > 0
    }, 20000, 'diagnóstico con bitrate de audio')
    if (kbps < 45 || kbps > 90) throw new Error('bitrate de audio fuera de lo esperado (64 kbps): ' + kbps)
    ok(`diagnóstico: Opus a ${kbps} kbps (objetivo 64)`)
    const rep = await a.page.locator('pre.diag').textContent()
    if (/\d+\.\d+\.\d+\.\d+/.test(rep.replace(/HumbleChat \d+\.\d+\.\d+/, '').replace(/Electron \d+\.\d+\.\d+/, ''))) throw new Error('el informe no debe contener IPs')
    ok('el informe de diagnóstico no contiene IPs')
    await shot(a, '09-diagnostico')
    await a.page.keyboard.press('Escape')

    console.log('Pantalla compartida')
    await a.page.locator('.round[title="Compartir pantalla"]').click()
    await a.page.locator('.seg-item', { hasText: 'Nitidez' }).click() // elegir calidad en el diálogo
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

    // Volver a compartir en la misma llamada (antes degradaba a ~1 fps por reutilizar el transceptor).
    await a.page.locator('.round[title="Compartir pantalla"]').click()
    if ((await a.page.locator('.seg-item.active').textContent()).indexOf('Nitidez') < 0) throw new Error('la calidad elegida no se recuerda')
    await a.page.locator('.src-card').first().click()
    await waitFor(async () => (await count(b, '.tile-watch')) > 0, 20000, 'B ve de nuevo el botón')
    await b.page.locator('.tile-watch').click()
    await waitFor(() => b.page.evaluate(() => { const v = document.querySelector('.theater video'); return !!v && v.videoWidth > 0 }), 20000, 'B recibe vídeo otra vez')
    await sleep(9000)
    await a.page.evaluate(async () => (await import('/voice.js')).diagnostics())
    await sleep(3000)
    const d2 = (await a.page.evaluate(async () => (await import('/voice.js')).diagnostics())).find((x) => x.videoOut)
    if (!d2 || d2.videoOut.fps < 15 || d2.videoOut.w < 1280) throw new Error('el 2.º vídeo compartido sale degradado: ' + JSON.stringify(d2?.videoOut))
    ok(`recompartir funciona: ${d2.videoOut.codec} ${d2.videoOut.w}x${d2.videoOut.h} @${d2.videoOut.fps} fps`)
    await a.page.locator('.round.on').click()
    await waitFor(async () => (await count(b, '.theater')) === 0, 10000, 'B deja de ver')

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
