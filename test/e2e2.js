'use strict'
// Segunda tanda e2e (instancias reales de Electron sobre una DHT local): canales dinámicos, mensajes directos,
// archivos, avatares, vistas previas de enlaces, búsqueda y fijados; y la sala/código, avisos de versión,
// relé de voz, bandeja y audio del sistema.   xvfb-run -a node test/e2e2.js [contenido|sistema]
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { startNet, launch, sleep, waitFor, capturarFallo } = require('./lib')
const { file: WAV } = require('./make-wav')
const { execSync } = require('child_process')
const { formatCode, fingerprint } = require('../src/core/groupkey')

const only = process.argv[2]
const count = (p, sel) => p.page.locator(sel).count()
const say = async (p, text) => { await p.page.fill('.composer textarea', text); await p.page.keyboard.press('Enter') }
let passed = 0
const ok = (msg) => { passed++; console.log('  ✔', msg) }
const tmpFile = (name, bytes) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-f-')), name); fs.writeFileSync(f, bytes); return f }
const everyone = (ps, fn) => Promise.all(ps.map(fn))
const cancel = (e) => { throw e }

async function content() {
  const net = await startNet()
  // Servidor de pruebas con Open Graph (la app solo permite direcciones públicas salvo con esta variable de pruebas).
  let visits = 0
  const web = http.createServer((_q, r) => { visits++; r.setHeader('content-type', 'text/html; charset=utf-8'); r.end('<html><head><title>Receta de tortilla</title><meta property="og:description" content="La mejor tortilla de patatas"><meta property="og:site_name" content="Cocina Fácil"></head><body>hola</body></html>') })
  await new Promise((r) => web.listen(0, '127.0.0.1', r))
  const apps = []
  const spawn = async (name, env = {}) => { const p = await launch(net, name, { env: { HUMBLECHAT_TEST_PREVIEW: '1', ...env } }); apps.push(p); return p }
  try {
    const a = await spawn('Ana'); const b = await spawn('Beto'); const c = await spawn('Carla')
    const all = [a, b, c]
    for (const p of all) await waitFor(async () => (await count(p, '.member:not(.offline)')) === 3, 25000, p.name + ' ve a los 3')

    console.log('Canales dinámicos')
    await a.page.locator('.cat', { hasText: 'Canales de texto' }).hover()
    await a.page.locator('.cat-add').first().click()
    await a.page.fill('.modal input.text', 'Receta Ideas')
    await a.page.locator('.modal .btn.brand').click()
    for (const p of all) await waitFor(async () => (await count(p, '.ch .ch-name:text-is("receta-ideas")')) === 1, 10000, p.name + ' ve #receta-ideas')
    ok('Ana crea #receta-ideas (nombre normalizado) y los tres lo ven')
    await waitFor(async () => /receta-ideas/.test(await a.page.textContent('.header .h-title')), 5000, 'Ana abre el canal nuevo')
    await say(a, 'primer mensaje en el canal nuevo')
    await waitFor(async () => (await count(c, '.msg')) === 0, 2000, 'sin mensajes en general')
    await c.page.locator('.ch', { hasText: 'receta-ideas' }).click()
    await waitFor(async () => (await count(c, '.msg')) === 1, 10000, 'Carla lee el mensaje del canal nuevo')
    ok('se escribe y se lee en el canal nuevo')
    await b.page.locator('.cat', { hasText: 'Canales de voz' }).hover()
    await b.page.locator('.cat-add').nth(1).click()
    await b.page.locator('.kind', { hasText: 'Voz' }).waitFor()
    await b.page.fill('.modal input.text', 'Sala de estudio')
    await b.page.locator('.modal .btn.brand').click()
    for (const p of all) await waitFor(async () => (await count(p, '.vch .ch-name:text-is("Sala de estudio")')) === 1, 10000, p.name + ' ve la sala de voz')
    ok('Beto crea un canal de voz y aparece para todos')
    // renombrar con el engranaje y borrar con confirmación
    await c.page.locator('.ch', { hasText: 'receta-ideas' }).hover()
    await c.page.locator('.ch', { hasText: 'receta-ideas' }).locator('.ch-gear').click()
    await c.page.fill('.modal input.text', 'recetas')
    await c.page.locator('.modal .btn.brand').click()
    for (const p of all) await waitFor(async () => (await count(p, '.ch .ch-name:text-is("recetas")')) === 1, 10000, p.name + ' ve el renombrado')
    ok('Carla renombra el canal y se refleja en todos')
    await a.page.locator('.ch', { hasText: 'recetas' }).click({ button: 'right' })
    await a.page.locator('.ctxmenu', { hasText: 'Eliminar canal' }).locator('button', { hasText: 'Eliminar canal' }).click()
    await a.page.locator('.modal .btn.danger').click()
    for (const p of all) await waitFor(async () => (await count(p, '.ch .ch-name:text-is("recetas")')) === 0, 10000, p.name + ' ya no ve #recetas')
    await waitFor(async () => /general/.test(await a.page.textContent('.header .h-title')), 5000, 'Ana vuelve a #general')
    ok('al borrar el canal desaparece para todos y quien lo miraba pasa a #general')

    console.log('Búsqueda y fijados')
    await say(a, 'La reunión del viernes es a las diez')
    await say(b, 'Traigo las patatas para la tortilla')
    await say(c, 'Reunión cancelada, mejor el sábado')
    await waitFor(async () => (await count(a, '.msg')) === 3, 10000, 'Ana ve 3 mensajes')
    await a.page.fill('.h-search input', 'REUNION')
    await a.page.waitForSelector('.side-panel:not(.hidden) .sr')
    await waitFor(async () => (await count(a, '.sr')) === 2, 5000, '2 resultados')
    const titles = await a.page.locator('.sp-head b').textContent()
    if (!/2 resultados/.test(titles)) throw new Error('título del panel: ' + titles)
    const marks = await a.page.locator('.sr mark').allTextContents()
    if (!marks.length) throw new Error('sin resaltado')
    ok('buscar "REUNION" (sin acento ni mayúsculas) encuentra 2 mensajes y los resalta')
    await a.page.locator('.sr', { hasText: 'cancelada' }).click()
    await waitFor(() => a.page.evaluate(() => !!document.querySelector('.msg.flash')), 5000, 'salto al mensaje')
    ok('pulsar un resultado salta al mensaje y lo resalta')
    await a.page.locator('.hs-clear').click()
    await waitFor(async () => (await count(a, '.side-panel:not(.hidden)')) === 0, 3000, 'panel cerrado')
    // fijar con la barra del mensaje
    await b.page.locator('.msg', { hasText: 'patatas' }).hover()
    await b.page.locator('.msg', { hasText: 'patatas' }).locator('.m-actions .icon-btn[aria-label="Fijar mensaje"]').click()
    for (const p of all) await waitFor(async () => (await count(p, '.msg.pinned')) === 1, 10000, p.name + ' ve el mensaje fijado')
    await c.page.locator('.h-tools .icon-btn[aria-label="Mensajes fijados"]').click()
    await c.page.waitForSelector('.side-panel:not(.hidden) .sr')
    if (!/patatas/.test(await c.page.textContent('.side-panel .sr'))) throw new Error('el fijado no aparece en el panel')
    ok('fijar un mensaje lo marca para todos y aparece en el panel de fijados')
    await c.page.locator('.side-panel .sr .icon-btn').click()
    await waitFor(async () => (await count(c, '.side-panel .sr')) === 0, 5000, 'desfijado')
    await waitFor(async () => (await count(a, '.msg.pinned')) === 0, 10000, 'Ana ve el desfijado')
    ok('quitar el fijado desde el panel se replica')
    await c.page.locator('.h-tools .icon-btn[aria-label="Mensajes fijados"]').click()

    console.log('Mensajes directos')
    await a.page.locator('.member', { hasText: 'Beto' }).click()
    await a.page.locator('.profile-card .btn', { hasText: 'Enviar mensaje' }).click()
    await a.page.waitForSelector('.ch.dm.selected')
    if (!/@Beto/.test(await a.page.getAttribute('.composer textarea', 'placeholder'))) throw new Error('placeholder de DM')
    if (await a.page.locator('.attach[aria-label="Adjuntar archivo"]').isVisible()) throw new Error('los directos no admiten adjuntos')
    const secret = 'el código del candado es 4711'
    await say(a, secret)
    await waitFor(async () => (await count(b, '.ch.dm')) === 1, 10000, 'Beto ve la conversación')
    await waitFor(async () => (await count(b, '.ch.dm.unread')) === 1, 5000, 'indicador de no leído en el directo')
    ok('el directo llega a Beto como conversación nueva con indicador de no leído')
    await b.page.locator('.ch.dm').click()
    await waitFor(async () => (await count(b, '.msg')) === 1, 5000, 'Beto lee el directo')
    if (!(await b.page.textContent('.msg .m-text')).includes('4711')) throw new Error('texto del directo')
    await say(b, 'recibido')
    await waitFor(async () => (await count(a, '.msg')) === 2, 10000, 'Ana recibe la respuesta')
    if ((await count(c, '.ch.dm')) !== 0) throw new Error('Carla no debería ver ninguna conversación')
    const leaked = await c.page.evaluate(() => document.body.innerText.includes('4711'))
    if (leaked) throw new Error('Carla ve el contenido del directo')
    const carlaStore = fs.readFileSync(path.join(c.profile, 'data', 'log', 'events.jsonl'), 'utf8')
    if (carlaStore.includes('candado')) throw new Error('el texto en claro se guardó en el disco de Carla')
    if (!carlaStore.includes('"t":"dm"')) throw new Error('Carla debería replicar el evento cifrado')
    ok('el tercero replica el evento pero no lo lee: ni en pantalla ni en su disco')
    await a.page.locator('.msg', { hasText: '4711' }).hover()
    await a.page.locator('.msg', { hasText: '4711' }).locator('.m-actions .icon-btn.danger').click()
    await a.page.locator('.modal .btn.danger').click()
    await waitFor(async () => (await count(b, '.msg')) === 1, 10000, 'Beto ve el borrado')
    ok('el autor borra su directo y desaparece en los dos lados')
    await a.page.locator('.ch:has(.ch-name:text-is("general"))').click()

    console.log('Archivos')
    await b.page.locator('.ch:has(.ch-name:text-is("general"))').click()
    const pdf = crypto.randomBytes(2 * 1024 * 1024)
    const f = tmpFile('informe final.pdf', pdf)
    await a.page.setInputFiles('input[type=file]', f)
    await waitFor(async () => (await count(a, '.pend')) === 1, 5000, 'archivo pendiente')
    if ((await count(a, '.pend img')) !== 0) throw new Error('un PDF no debe mostrarse como imagen')
    await a.page.keyboard.press('Enter')
    await waitFor(async () => (await count(b, '.file')) === 1, 10000, 'tarjeta de archivo en Beto')
    const sizeText = await b.page.textContent('.file .f-info small')
    if (!/PDF/.test(sizeText)) throw new Error('tipo de archivo: ' + sizeText)
    await new Promise((r) => setTimeout(r, 2000))
    if (fs.existsSync(path.join(b.profile, 'data', 'blobs', crypto.createHash('sha256').update(pdf).digest('hex')))) throw new Error('el PDF se descargó solo')
    ok('un PDF aparece como tarjeta y no se descarga hasta que se pide')
    await b.page.locator('.file .btn', { hasText: 'Descargar' }).click()
    await b.page.locator('.file .btn', { hasText: 'Guardar como' }).waitFor({ timeout: 20000 })
    const h = crypto.createHash('sha256').update(pdf).digest('hex')
    if (!fs.readFileSync(path.join(b.profile, 'data', 'blobs', h)).equals(pdf)) throw new Error('contenido distinto')
    ok('"Descargar" lo trae (verificado por hash) y ofrece "Guardar como…"')

    console.log('Avatares')
    await a.page.locator('.up-id').click()
    await a.page.locator('.st-item', { hasText: 'Mi cuenta' }).click()
    const shot = await b.page.screenshot() // una imagen real cualquiera
    await a.page.setInputFiles('.st-content input[type=file]', { name: 'yo.png', mimeType: 'image/png', buffer: shot })
    await a.page.locator('.btn', { hasText: 'Quitar' }).waitFor({ timeout: 10000 })
    await a.page.keyboard.press('Escape')
    for (const p of [b, c]) await waitFor(() => p.page.evaluate(() => [...document.querySelectorAll('.member .avatar-img')].some((i) => i.complete && i.naturalWidth > 0)), 15000, p.name + ' ve el avatar de Ana')
    ok('el avatar nuevo de Ana se ve (imagen real) en la lista de los demás')
    const w = await b.page.evaluate(() => { const i = [...document.querySelectorAll('.member .avatar-img')].find((x) => x.naturalWidth); return i.naturalWidth })
    if (w !== 256) throw new Error('el avatar debería ser de 256 px, es ' + w)
    ok('se recorta al centro y se reduce a 256 px')

    console.log('Vistas previas de enlaces')
    await say(c, `mirad esto http://127.0.0.1:${web.address().port}/receta`)
    for (const p of all) await waitFor(async () => (await count(p, '.embed')) === 1, 15000, p.name + ' ve la vista previa')
    const e = await a.page.textContent('.embed')
    if (!/Receta de tortilla/.test(e) || !/La mejor tortilla/.test(e) || !/Cocina Fácil/.test(e)) throw new Error('contenido de la vista previa: ' + e)
    await sleep(1500)
    if (visits !== 1) throw new Error('la página se visitó ' + visits + ' veces; debería hacerlo solo quien envía')
    ok('Carla envía un enlace y los tres ven título, descripción y sitio; la página se visitó una sola vez (la de quien lo envía)')
    // sin la variable de pruebas, un servidor local NO se visita
    const d = await spawn('Dani', { HUMBLECHAT_TEST_PREVIEW: '' })
    await waitFor(async () => (await count(d, '.member:not(.offline)')) === 4, 25000, 'Dani entra')
    let hits = 0
    web.removeAllListeners('request')
    web.on('request', (_q, r) => { hits++; r.end('<title>x</title>') })
    await say(d, `http://127.0.0.1:${web.address().port}/secreto`)
    await sleep(3500)
    if (hits) throw new Error('la app visitó un servidor local')
    if ((await count(a, '.embed')) !== 1) throw new Error('no debería haber vista previa de una dirección privada')
    ok('un enlace a la red local no se visita ni se previsualiza (protección SSRF en la app real)')
  } catch (e) {
    await capturarFallo('e2e2')
    throw e
  } finally {
    for (const p of apps) await p.app.close().catch(() => {})
    web.close()
    await net.testnet.destroy()
  }
}


const hears = (p, who) => p.page.locator(`.vuser:has-text("${who}").speaking`).count().then((n) => n > 0)
const joinVoice = (ps) => everyone(ps, (p) => p.page.locator('.vch .ch', { hasText: 'General' }).click())
const evalApp = (p, fn, arg) => p.page.evaluate(fn, arg)

async function sistema() {
  const net = await startNet()
  const apps = []
  const mk = async (name, o = {}) => { const p = await launch(net, name, o); apps.push(p); return p }
  const close = async () => { for (const p of apps.splice(0)) await p.app.close().catch(() => {}) }
  try {
    console.log('Sala, código y avisos de versión')
    const web = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'http://localhost/descarga' })) })
    await new Promise((r) => web.listen(0, '127.0.0.1', r))
    const a = await mk('Ana', { env: { HUMBLECHAT_UPDATE_URL: `http://127.0.0.1:${web.address().port}/`, HUMBLECHAT_UPDATE_DELAY: '500' } })
    const b = await mk('Beto', { noKey: true, ready: '.setup' })
    await b.page.fill('#code', 'esto no vale'); await b.page.click('#join')
    await waitFor(async () => /no es válido/.test(await b.page.textContent('#error')), 5000, 'error de código')
    ok('sin llave arranca en la pantalla de bienvenida y rechaza un código inválido con un mensaje claro')
    await b.page.fill('#code', formatCode(net.key).toUpperCase()); await b.page.click('#join')
    await b.page.waitForSelector('.sb-header', { timeout: 20000 })
    await waitFor(async () => (await count(a, '.member:not(.offline)')) === 2, 25000, 'se ven tras unirse')
    ok('Beto entra pegando el código (en mayúsculas y con guiones) y se encuentra con Ana')
    await a.page.waitForSelector('.update-bar', { timeout: 15000 })
    if (!/9\.9\.9/.test(await a.page.textContent('.update-bar'))) throw new Error('el aviso no menciona la versión')
    ok('Ana ve el aviso de la versión 9.9.9 publicada')
    await b.page.locator('.up-btns .icon-btn').last().click()
    await b.page.locator('.st-item', { hasText: 'Sala' }).click()
    await b.page.waitForSelector('.fp')
    if ((await b.page.textContent('.fp')).replace(/\s/g, '') !== fingerprint(net.key).replace(/\s/g, '')) throw new Error('huella distinta')
    ok('la huella de la sala coincide en los dos equipos')
    await b.page.locator('.btn', { hasText: 'Crear una sala nueva' }).click()
    await b.page.locator('.modal .btn.brand').click()
    await b.page.waitForSelector('.modal .code-box code')
    await b.page.locator('.modal .btn.green').click()
    await b.page.waitForSelector('.sb-header', { timeout: 20000 })
    await waitFor(async () => (await count(a, '.member.offline')) === 1, 30000, 'A ya no ve a B')
    ok('rotación de llave: con la sala nueva, Ana y Beto dejan de verse')
    web.close()
    await close()

    console.log('Audio: supresión de ruido, umbral y pulsar para hablar')
    const env = { HUMBLECHAT_FAKE_AUDIO_FILE: path.join(__dirname, 'speech.wav') }
    const n2 = await startNet()
    const x = await launch(n2, 'Ana', { env }); const y = await launch(n2, 'Beto', { env }); apps.push(x, y)
    await waitFor(async () => (await count(y, '.member:not(.offline)')) === 2, 25000, 'se ven')
    await joinVoice([x, y])
    await waitFor(() => hears(y, 'Ana'), 40000, 'Beto oye a Ana')
    ok('con la supresión estándar, Beto oye a Ana')
    const mod = (p, what, arg) => p.page.evaluate(async ({ what, arg }) => {
      const { state } = await import('/state.js'); const { voice } = await import('/voice.js')
      if (what === 'denoise') { state.prefs.denoise = arg; await voice.applyDevices() }
      if (what === 'gate') state.prefs.gate = arg
      if (what === 'ptt') state.prefs.ptt = { on: true, key: { code: arg.code, hook: arg.hook, label: 'F9' } }
      if (what === 'ptt-global') { state.prefs.ptt = { on: true, key: { code: null, hook: arg, label: 'F9' } }; await window.humble.pttConfigure({ on: true, hook: arg }) }
    }, { what, arg })
    await mod(x, 'denoise', 'advanced')
    await sleep(3000)
    if ((await x.page.locator('.toast.warn').allTextContents()).some((t) => /avanzada/.test(t))) throw new Error('la supresión avanzada avisó de un fallo')
    await waitFor(() => hears(y, 'Ana'), 20000, 'Beto oye a Ana con RNNoise')
    ok('con la supresión avanzada (RNNoise en WebAssembly sobre el micrófono real) Beto sigue oyendo a Ana')
    await mod(x, 'denoise', 'standard')
    await mod(x, 'gate', { on: true, level: 0.9 })
    await sleep(2500)
    if (await hears(y, 'Ana')) throw new Error('con el umbral alto debería haber silencio')
    await mod(x, 'gate', { on: true, level: 0.003 })
    await waitFor(() => hears(y, 'Ana'), 15000, 'Beto oye a Ana con umbral bajo')
    ok('umbral de sensibilidad: alto = silencio, bajo = se oye')
    await mod(x, 'gate', { on: false, level: 0.05 })
    await mod(x, 'ptt', { code: 'F9', hook: 67 })
    await sleep(2500)
    if (await hears(y, 'Ana')) throw new Error('sin pulsar la tecla debería haber silencio')
    await x.page.keyboard.down('F9')
    await waitFor(() => hears(y, 'Ana'), 15000, 'PTT en ventana')
    await x.page.keyboard.up('F9')
    await sleep(2500)
    if (await hears(y, 'Ana')) throw new Error('al soltar la tecla debería volver el silencio')
    ok('pulsar para hablar (tecla con la ventana enfocada): silencio, se oye mientras se pulsa, silencio al soltar')
    let xdotool = false
    try { execSync('xdotool version', { stdio: 'ignore' }); xdotool = process.platform === 'linux' } catch {}
    if (xdotool) {
      const { UiohookKey } = require('uiohook-napi')
      await mod(x, 'ptt-global', UiohookKey.F9)
      await sleep(1500)
      if (await hears(y, 'Ana')) throw new Error('PTT global: debería haber silencio')
      execSync('xdotool keydown F9')
      await waitFor(() => hears(y, 'Ana'), 12000, 'PTT global')
      execSync('xdotool keyup F9')
      ok('pulsar para hablar con tecla GLOBAL (gancho del sistema): se oye al pulsar')
    } else console.log('  - PTT global omitido (sin xdotool o fuera de Linux)')
    await close()
    await n2.testnet.destroy()

    console.log('Voz sin conexión directa (relé por un tercero)')
    const n3 = await startNet()
    const [p1, p2, p3] = [await launch(n3, 'Ana', { env }), await launch(n3, 'Beto', { env }), await launch(n3, 'Carlos', { env })]
    apps.push(p1, p2, p3)
    for (const p of [p1, p2, p3]) await waitFor(async () => (await count(p, '.member:not(.offline)')) === 3, 25000, 'se ven')
    const idOf = (p) => p.page.evaluate(() => window.humble.init().then((i) => i.me.id))
    const [i1, i2] = [await idOf(p1), await idOf(p2)]
    await p1.page.evaluate((v) => localStorage.setItem('hc.dbg', JSON.stringify({ blockDirect: [v] })), i2)
    await p2.page.evaluate((v) => localStorage.setItem('hc.dbg', JSON.stringify({ blockDirect: [v] })), i1)
    await joinVoice([p1, p2, p3])
    await waitFor(() => hears(p2, 'Ana'), 90000, 'Beto oye a Ana por relé')
    await waitFor(() => hears(p1, 'Beto'), 40000, 'Ana oye a Beto por relé')
    ok('Ana y Beto, sin conexión directa entre ellos, se oyen a través de Carlos')
    await close()
    await n3.testnet.destroy()

    console.log('Integración con el sistema: bandeja y audio al compartir pantalla')
    const n4 = await startNet()
    const t = await launch(n4, 'Ana', { env: { HUMBLECHAT_FORCE_TRAY: '1' } }); apps.push(t)
    const hidden = await t.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.close(); return { visible: w.isVisible(), destroyed: w.isDestroyed() } })
    if (hidden.visible || hidden.destroyed) throw new Error('con bandeja, cerrar debe ocultar la ventana sin destruirla')
    await t.app.evaluate(({ app }) => app.emit('second-instance'))
    if (!(await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))) throw new Error('la ventana no volvió a mostrarse')
    ok('cerrar la ventana con bandeja la oculta (la app sigue viva) y abrir de nuevo la muestra')
    await close()
    const w = await launch(n4, 'Ana', { env: { HUMBLECHAT_FAKE_PLATFORM: 'win32' } }); const l = await launch(n4, 'Beto'); apps.push(w, l)
    await waitFor(async () => (await count(l, '.member:not(.offline)')) === 2, 25000, 'se ven')
    await joinVoice([w, l])
    await waitFor(async () => (await count(w, '.vuser')) === 2, 10000, 'sala')
    for (let i = 0; i < 4; i++) {
      await w.page.locator('.round[aria-label="Compartir pantalla"]').click()
      if (await w.page.locator('.src-card').first().waitFor({ timeout: 25000 }).then(() => true, () => false)) break
      await w.page.keyboard.press('Escape')
    }
    if ((await count(w, '.chk')) !== 1) throw new Error('en Windows debería ofrecerse el audio del sistema')
    await w.page.keyboard.press('Escape')
    await l.page.locator('.round[aria-label="Compartir pantalla"]').click()
    for (let i = 0; i < 4 && !(await count(l, '.src-card')); i++) await sleep(1500)
    if ((await count(l, '.chk')) !== 0) throw new Error('fuera de Windows no debe ofrecerse el audio del sistema')
    ok('la casilla "audio del sistema" aparece en Windows y no en Linux')
  } catch (e) {
    await capturarFallo('e2e2')
    throw e
  } finally {
    for (const p of apps) await p.app.close().catch(() => {})
    await net.testnet.destroy().catch(() => {})
  }
}

;(async () => {
  if (!only || only === 'contenido') await content()
  if (!only || only === 'sistema') await sistema()
  console.log(`\n${passed} comprobaciones OK`)
  process.exit(0)
})().catch((e) => { console.error('\n✘', e); process.exit(1) })
