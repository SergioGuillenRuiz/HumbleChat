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
    console.log('Sala y código (el bloqueo por versión se prueba en test/gate.js)')
    const a = await mk('Ana')
    const b = await mk('Beto', { noKey: true, ready: '.setup' })
    await b.page.fill('#code', 'esto no vale'); await b.page.click('#join')
    await waitFor(async () => /no es válido/.test(await b.page.textContent('#error')), 5000, 'error de código')
    ok('sin llave arranca en la pantalla de bienvenida y rechaza un código inválido con un mensaje claro')
    await b.page.fill('#code', formatCode(net.key).toUpperCase()); await b.page.click('#join')
    await b.page.waitForSelector('.sb-header', { timeout: 20000 })
    await waitFor(async () => (await count(a, '.member:not(.offline)')) === 2, 25000, 'se ven tras unirse')
    ok('Beto entra pegando el código (en mayúsculas y con guiones) y se encuentra con Ana')
    await b.page.locator('.up-btns .icon-btn').last().click()
    await b.page.locator('.st-item', { hasText: 'Sala' }).click()
    await b.page.waitForSelector('.fp')
    if ((await b.page.textContent('.fp')).replace(/\s/g, '') !== fingerprint(net.key).replace(/\s/g, '')) throw new Error('huella distinta')
    ok('la huella de la sala coincide en los dos equipos')
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

/** Utilidades de la llamada: el resultado lo calcula quien pulsa y lo ven igual todos los de la llamada. */
async function utilidades() {
  const net = await startNet()
  const apps = []
  const close = async () => { for (const p of apps.splice(0)) await p.app.close().catch(() => {}) }
  const abrir = async (p, item) => { await p.page.locator('.vcontrols [data-tools="1"]').click(); await p.page.locator('.ctx-item', { hasText: item }).click() }
  const resultado = async (p, kind) => {
    await p.page.locator(`.util-result[data-kind="${kind}"][data-done="1"]`).waitFor({ timeout: 15000 })
    return p.page.locator('.util-result').getAttribute('data-result')
  }
  const cerrar = (p) => p.page.locator('.util-result .btn.brand').click()
  try {
    console.log('Utilidades de la llamada')
    const a = await launch(net, 'Ana'); apps.push(a)
    const b = await launch(net, 'Beto'); apps.push(b)
    for (const p of [a, b]) await waitFor(async () => (await count(p, '.member:not(.offline)')) === 2, 25000, 'se ven')
    for (const p of [a, b]) await p.page.locator('.vch .ch', { hasText: 'General' }).click()
    for (const p of [a, b]) await waitFor(async () => (await count(p, '.vuser')) === 2 && (await count(p, '.callpanel')) === 1, 20000, 'los dos en la llamada')

    // Ruleta con una opción añadida a mano
    await abrir(a, 'Ruleta')
    const chips = await a.page.locator('.modal .chip').allTextContents()
    if (chips.length !== 2 || !chips.includes('Ana') || !chips.includes('Beto')) throw new Error('la ruleta debería traer un hueco por cada persona de la llamada: ' + chips)
    await a.page.fill('.modal input.text', 'Pizza'); await a.page.keyboard.press('Enter')
    if ((await a.page.locator('.modal .chip').count()) !== 3) throw new Error('no se añadió la opción a mano')
    await a.page.locator('[data-go="wheel"]').click()
    const [ra, rb] = [await resultado(a, 'wheel'), await resultado(b, 'wheel')]
    if (ra !== rb) throw new Error(`la ruleta no cae igual para todos: ${ra} / ${rb}`)
    if (!['Ana', 'Beto', 'Pizza'].includes(ra)) throw new Error('ganador desconocido: ' + ra)
    ok(`ruleta: un hueco por persona de la llamada y una opción propia; a los dos les cae en «${ra}»`)
    await cerrar(a); await cerrar(b)

    // Con una sola opción no gira
    await abrir(a, 'Ruleta')
    await a.page.locator('.modal .chip', { hasText: 'Beto' }).click()
    await a.page.locator('[data-go="wheel"]').click()
    await a.page.locator('.toast', { hasText: 'al menos 2' }).waitFor({ timeout: 5000 })
    await a.page.keyboard.press('Escape')
    ok('con menos de 2 opciones avisa en vez de girar')

    // Equipos
    await abrir(a, 'Equipos')
    await a.page.locator('[data-go="teams"]').click()
    const [ta, tb] = [await resultado(a, 'teams'), await resultado(b, 'teams')]
    if (ta !== tb) throw new Error('los equipos no coinciden: ' + ta + ' / ' + tb)
    if (ta.split('|').length !== 2 || !['Ana|Beto', 'Beto|Ana'].includes(ta)) throw new Error('equipos inesperados: ' + ta)
    ok('equipos aleatorios: dos equipos con una persona cada uno, iguales para los dos')
    await cerrar(a); await cerrar(b)

    // Cara o cruz
    await abrir(b, 'Cara o cruz') // lo lanza Beto: también funciona al revés
    const [ca, cb] = [await resultado(b, 'coin'), await resultado(a, 'coin')]
    if (ca !== cb || !['cara', 'cruz'].includes(ca)) throw new Error('moneda: ' + ca + ' / ' + cb)
    ok(`cara o cruz lanzado por Beto: los dos ven «${ca}»`)
    await cerrar(a); await cerrar(b)

    // Dado y orden
    await abrir(a, 'Dado')
    await a.page.selectOption('.modal select >> nth=0', '20'); await a.page.selectOption('.modal select >> nth=1', '3')
    await a.page.locator('[data-go="dice"]').click()
    const [da, db] = [await resultado(a, 'dice'), await resultado(b, 'dice')]
    if (da !== db || da.split(',').length !== 3 || da.split(',').some((x) => +x < 1 || +x > 20)) throw new Error('dado: ' + da + ' / ' + db)
    ok(`dado: 3 dados de 20 caras, iguales para los dos (${da})`)
    await cerrar(a); await cerrar(b)
    await abrir(a, 'Orden')
    await a.page.locator('[data-go="order"]').click()
    const [oa, ob] = [await resultado(a, 'order'), await resultado(b, 'order')]
    if (oa !== ob || !['Ana>Beto', 'Beto>Ana'].includes(oa)) throw new Error('orden: ' + oa + ' / ' + ob)
    ok('orden aleatorio: igual para los dos')
  } catch (e) {
    await capturarFallo('e2e2-utilidades')
    throw e
  } finally {
    await close()
    await net.testnet.destroy().catch(() => {})
  }
}

/**
 * «Escuchar juntos» con tres aplicaciones reales y un YouTube simulado (HUMBLECHAT_FAKE_MUSIC: el reproductor es el de siempre, en su
 * ventana oculta y aislada, pero con un `YT` de mentira con reloj propio; la primera letra del id decide: S dura 6 s, L 240 s,
 * M 20 s, E da el error 150 y N no se puede incrustar). Lo que NO se puede probar aquí es YouTube de verdad.
 */
async function musica() {
  const net = await startNet()
  const apps = []
  const close = async () => { for (const p of apps.splice(0)) await p.app.close().catch(() => {}) }
  const env = { HUMBLECHAT_FAKE_MUSIC: '1' }
  const [CORTA, LARGA, MEDIA, ERROR, NOINCRUSTA] = ['Scorta00001', 'Larga000001', 'Media000001', 'Error000001', 'Nope0000001']
  // Lo que cuenta el reproductor de cada instancia (su ventana oculta), o null si no tiene
  const reproductor = (p) => p.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('http://127.0.0.1'))
    return w ? w.webContents.executeJavaScript('window.__player ? window.__player.snapshot() : null') : null
  })
  const en = async (p, st) => { const r = await reproductor(p); return r && r.st === st ? r : null }
  const panel = (p) => p.page.locator('.music-dock')
  const abrir = async (p) => { if (!(await panel(p).count())) await p.page.locator('.vcontrols [data-music="1"]').click(); await panel(p).waitFor({ timeout: 5000 }) }
  const pegar = async (p, id) => { await abrir(p); await p.page.fill('.music-dock .mu-add input', 'https://youtu.be/' + id); await p.page.keyboard.press('Enter') }
  const cola = (p) => count(p, '.music-dock .mu-q')
  const entrar = (p) => p.page.locator('.vch .ch', { hasText: 'General' }).click()
  const pulsar = (p, mu) => p.page.locator(`.music-dock [data-mu="${mu}"]`).click()
  const todos = (ps, f, ms, what) => waitFor(async () => { for (const p of ps) if (!(await f(p))) return false; return true }, ms, what)
  try {
    console.log('Escuchar juntos (música sincronizada en la llamada)')
    const a = await launch(net, 'Ana', { env }); apps.push(a)
    const b = await launch(net, 'Beto', { env }); apps.push(b)
    const c = await launch(net, 'Carla', { env }); apps.push(c)
    for (const p of [a, b, c]) await waitFor(async () => (await count(p, '.member:not(.offline)')) === 3, 30000, 'se ven')
    for (const p of [a, b]) await entrar(p)
    for (const p of [a, b]) await waitFor(async () => (await count(p, '.vuser')) === 2 && (await count(p, '.callpanel')) === 1, 20000, 'Ana y Beto en la llamada')

    // Ana pone una canción: suena para ella; Beto se entera pero no la oye hasta que decida
    await pegar(a, LARGA)
    await waitFor(() => en(a, 'playing'), 15000, 'suena en el equipo de Ana')
    if ((await a.page.locator('.music-dock .mu-title').textContent()) !== 'Canción Larga') throw new Error('el título no es el de la consulta (oEmbed)')
    await b.page.locator('.toast', { hasText: 'ha puesto música' }).waitFor({ timeout: 15000 })
    await waitFor(async () => (await b.page.locator('.vcontrols [data-music="1"].ping').count()) === 1, 5000, 'el botón de Beto llama la atención')
    if (await reproductor(b)) throw new Error('Beto no ha elegido escuchar y ya tiene un reproductor')
    await abrir(b)
    await waitFor(async () => (await cola(b)) === 1, 10000, 'Beto ve la cola de Ana')
    if ((await b.page.locator('.music-dock [data-mu="listen"]').textContent()) !== 'Escuchar juntos') throw new Error('el botón de Beto debería ofrecer escuchar')
    ok('Ana pone música: a ella le suena y Beto ve la cola, recibe el aviso y NO la oye hasta decidirlo')
    await pulsar(b, 'listen')
    await waitFor(() => en(b, 'playing'), 15000, 'suena en el equipo de Beto')
    const [pa, pb] = [await reproductor(a), await reproductor(b)]
    if (pa.n !== pb.n || Math.abs(pa.pos - pb.pos) > 4) throw new Error(`no están sincronizados: ${pa.pos} / ${pb.pos}`)
    ok(`Beto elige escuchar y entra en el mismo punto (${pa.pos.toFixed(1)} s / ${pb.pos.toFixed(1)} s)`)

    // Pausa y reanuda: lo ve todo el mundo
    await pulsar(a, 'play')
    await todos([a, b], (p) => en(p, 'paused'), 10000, 'los dos en pausa')
    await pulsar(b, 'play') // y lo reanuda otra persona, no la que pausó
    await todos([a, b], (p) => en(p, 'playing'), 10000, 'los dos suenan otra vez')
    ok('pausar (Ana) y reanudar (Beto) se aplica a los dos')

    // Buscar un punto: clic en la barra (Ana)
    await waitFor(async () => (await a.page.locator('.mu-times span').last().textContent()) === '4:00', 8000, 'se conoce la duración')
    const box = await a.page.locator('.mu-bar').boundingBox()
    await a.page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2)
    await waitFor(async () => { const [x, y] = [await reproductor(a), await reproductor(b)]; return Math.abs(x.pos - 120) < 8 && Math.abs(y.pos - x.pos) < 4 }, 15000, 'los dos saltan a la mitad')
    ok('buscar un punto en la barra: los dos saltan a la mitad de la canción')

    // Un reproductor que se desvía se corrige solo
    await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('http://127.0.0.1')).webContents.executeJavaScript('window.__player.nudge(-60)'))
    await waitFor(async () => { const [x, y] = [await reproductor(a), await reproductor(b)]; return Math.abs(y.pos - x.pos) < 4 }, 20000, 'Beto se vuelve a sincronizar')
    ok('si el reproductor de Beto se atrasa 60 s, vuelve solo a la posición de los demás')

    // Beto añade otra canción: se pone en cola, no interrumpe lo que suena
    await pegar(b, CORTA)
    await waitFor(async () => (await cola(a)) === 2 && (await cola(b)) === 2, 10000, 'las dos colas tienen 2')
    if ((await a.page.locator('.music-dock .mu-q.now .mu-qn').textContent()) !== 'Canción Larga') throw new Error('añadir no debe cambiar lo que suena')
    ok('Beto añade una canción: llega a la cola de Ana y no interrumpe la que suena')

    // Carla llega tarde a la llamada: recibe la cola y la posición de ahora
    await entrar(c)
    await waitFor(async () => (await count(c, '.vuser')) === 3, 20000, 'Carla en la llamada')
    await abrir(c)
    await waitFor(async () => (await cola(c)) === 2, 20000, 'Carla recibe la cola')
    await pulsar(c, 'listen')
    await waitFor(() => en(c, 'playing'), 15000, 'suena en el equipo de Carla')
    const [xa, xc] = [await reproductor(a), await reproductor(c)]
    if (xa.n !== xc.n || Math.abs(xa.pos - xc.pos) > 5) throw new Error(`Carla no entra en el mismo punto: ${xa.pos} / ${xc.pos}`)
    ok(`Carla llega tarde: recibe la cola y entra donde va la música (${xc.pos.toFixed(0)} s)`)

    // Saltar a la corta (la última): al acabar, la cola se agota y todos paran
    await a.page.locator('.music-dock .mu-q').nth(1).click()
    await todos([a, b, c], async (p) => { const r = await reproductor(p); return r && r.dur === 6 && r.st !== 'loading' }, 15000, 'todos cargan la corta')
    await todos([a, b, c], async (p) => (await p.page.locator('.music-dock .mu-empty b').textContent().catch(() => '')) === 'Se acabó la cola', 30000, 'se acaba la cola')
    await todos([a, b, c], async (p) => { const r = await reproductor(p); return r && r.st === 'none' }, 10000, 'los reproductores paran')
    ok('saltar a una canción desde la cola la pone en los tres; al acabar la última, todos paran a la vez')

    // Añadir con la cola agotada vuelve a arrancar para todos los que escuchan
    await pegar(b, MEDIA)
    await todos([a, b, c], (p) => en(p, 'playing'), 15000, 'vuelve a sonar')
    await pulsar(a, 'next')
    await todos([a, b, c], async (p) => (await p.page.locator('.music-dock .mu-empty b').textContent().catch(() => '')) === 'Se acabó la cola', 15000, 'siguiente agota la cola')
    ok('añadir con la cola agotada vuelve a sonar para todos; «siguiente» en la última la agota')

    // Casos de error
    await pegar(a, ERROR)
    await a.page.locator('.toast', { hasText: 'no permite reproducirlo' }).waitFor({ timeout: 15000 })
    await todos([a, b, c], async (p) => (await p.page.locator('.music-dock .mu-empty b').textContent().catch(() => '')) === 'Se acabó la cola', 15000, 'el vídeo roto se salta solo')
    ok('un vídeo que YouTube no deja reproducir avisa y se salta solo')
    const antes = await cola(a)
    await pegar(a, NOINCRUSTA)
    await a.page.locator('.toast', { hasText: 'no permite reproducir ese vídeo' }).waitFor({ timeout: 10000 })
    await a.page.fill('.music-dock .mu-add input', 'https://ejemplo.com/hola')
    await a.page.keyboard.press('Enter')
    await a.page.locator('.toast', { hasText: 'enlace de un vídeo de YouTube' }).waitFor({ timeout: 5000 })
    if ((await cola(a)) !== antes) throw new Error('no debía entrar nada en la cola')
    ok('un vídeo que no se puede incrustar y un enlace que no es de YouTube se rechazan al añadir, sin tocar la cola')

    // Ensordecer silencia la música; el volumen es de cada uno
    await pegar(a, 'Larga000002')
    await todos([a, b, c], (p) => en(p, 'playing'), 15000, 'suena la segunda larga')
    await b.page.evaluate(async () => { const { voice } = await import('/voice.js'); voice.toggleDeafen() })
    await waitFor(async () => (await reproductor(b)).mute === true, 5000, 'Beto, ensordecido, no oye la música')
    if ((await reproductor(a)).mute) throw new Error('la música de Ana no debía silenciarse')
    await b.page.evaluate(async () => { const { voice } = await import('/voice.js'); voice.toggleDeafen() })
    await waitFor(async () => (await reproductor(b)).mute === false, 5000, 'Beto vuelve a oír la música')
    await b.page.evaluate(() => { const s = document.querySelector('.mu-vol'); s.value = 30; s.dispatchEvent(new Event('input')) })
    await waitFor(async () => (await reproductor(b)).vol === 30, 5000, 'el volumen de Beto')
    if ((await reproductor(a)).vol === 30) throw new Error('el volumen es personal')
    ok('ensordecer silencia la música de quien se ensordece; el volumen es de cada uno')

    // Dos personas añaden a la vez: no se pierde ninguna
    const n0 = await cola(a)
    await Promise.all([pegar(a, 'Larga000003'), pegar(b, 'Larga000004')])
    await todos([a, b, c], async (p) => (await cola(p)) === n0 + 2, 15000, 'las dos canciones están en las tres colas')
    const orden = await Promise.all([a, b, c].map((p) => p.page.locator('.music-dock .mu-q').evaluateAll((els) => els.map((e) => e.dataset.n).join(','))))
    if (new Set(orden).size !== 1) throw new Error('las colas no coinciden: ' + orden.join(' | '))
    ok('dos personas añaden a la vez: las dos canciones llegan y las tres colas quedan idénticas')

    // Dejar de escuchar solo apaga lo propio; colgar apaga la música y cierra el reproductor
    await pulsar(c, 'listen')
    await waitFor(async () => (await reproductor(c))?.st === 'none', 8000, 'Carla deja de escuchar')
    if (!(await en(a, 'playing')) || !(await en(b, 'playing'))) throw new Error('los demás debían seguir escuchando')
    await a.page.locator('.callpanel button[aria-label="Desconectar"]').click()
    await waitFor(async () => (await reproductor(a)) === null && (await panel(a).count()) === 0, 10000, 'al colgar se cierra el reproductor de Ana')
    if (!(await en(b, 'playing'))) throw new Error('Beto debía seguir escuchando')
    ok('dejar de escuchar solo apaga la música propia; colgar cierra el reproductor y el panel')
  } catch (e) {
    await capturarFallo('e2e2-musica')
    throw e
  } finally {
    await close()
    await net.testnet.destroy().catch(() => {})
  }
}

/** Inactividad en una llamada, con la aplicación real y tiempos cortos (el sistema "lleva horas inactivo" por HUMBLECHAT_FAKE_IDLE). */
async function afk() {
  const net = await startNet()
  const apps = []
  const close = async () => { for (const p of apps.splice(0)) await p.app.close().catch(() => {}) }
  const tiempos = { muteMs: 2500, leaveMs: 7000, warnMs: 2500, tickMs: 250, ignoreSpeech: true, backMs: 1500 }
  const entrar = (p) => p.page.locator('.vch .ch', { hasText: 'General' }).click()
  const enLlamada = (p) => p.page.locator('.callpanel').count().then((n) => n > 0)
  const silenciado = (p) => p.page.locator('.round[aria-label^="Activar micrófono"]').count().then((n) => n > 0)
  try {
    console.log('Inactividad en una llamada (AFK)')
    // 1. El sistema lleva horas sin actividad: primero se silencia, luego avisa y por fin sale de la llamada
    let a = await launch(net, 'Ana', { env: { HUMBLECHAT_FAKE_IDLE: '99999' } }); apps.push(a)
    await a.page.evaluate((t) => localStorage.setItem('hc.dbg', JSON.stringify({ afk: t })), tiempos)
    await a.page.reload(); await a.page.waitForSelector('.sb-header')
    await entrar(a)
    await waitFor(() => enLlamada(a), 10000, 'Ana entra en la llamada')
    if (await silenciado(a)) throw new Error('no debería entrar silenciada')
    await waitFor(() => silenciado(a), 15000, 'se silencia por inactividad')
    if (!(await enLlamada(a))) throw new Error('al silenciar no debe salir de la llamada')
    ok('con el sistema inactivo, a los 30 min (aquí 2,5 s) se silencia y sigue en la llamada')
    await waitFor(async () => (await a.page.locator('.toast', { hasText: 'saldrás de la llamada' }).count()) > 0, 15000, 'aviso antes de salir')
    ok('avisa antes de sacarte de la llamada')
    await waitFor(async () => !(await enLlamada(a)), 20000, 'sale de la llamada')
    await waitFor(async () => (await a.page.locator('.toast', { hasText: 'Has salido de la llamada' }).count()) > 0, 5000, 'aviso de que salió')
    ok('a la hora (aquí 7 s) sin actividad sale de la llamada y se lo dice')
    await close()

    // 2. El sistema está activo (el usuario hace otras cosas): no se silencia ni se le echa, aunque la ventana esté quieta
    a = await launch(net, 'Ana', { env: { HUMBLECHAT_FAKE_IDLE: '0' } }); apps.push(a)
    await a.page.evaluate((t) => localStorage.setItem('hc.dbg', JSON.stringify({ afk: t })), tiempos)
    await a.page.reload(); await a.page.waitForSelector('.sb-header')
    await entrar(a)
    await waitFor(() => enLlamada(a), 10000, 'Ana entra en la llamada')
    await sleep(tiempos.leaveMs + 4000)
    if (!(await enLlamada(a))) throw new Error('con el sistema activo no se debe salir de la llamada')
    if (await silenciado(a)) throw new Error('con el sistema activo no se debe silenciar')
    ok('si el sistema está en uso (juegas o trabajas en otra ventana), no se silencia ni se te echa')
    await close()

    // 3. Sin poder saber la actividad del sistema (null): se puede silenciar pero nunca echar
    a = await launch(net, 'Ana', { env: { HUMBLECHAT_FAKE_IDLE: 'no-se' } }); apps.push(a)
    await a.page.evaluate((t) => localStorage.setItem('hc.dbg', JSON.stringify({ afk: { ...t, ignoreInput: false } })), tiempos)
    await a.page.reload(); await a.page.waitForSelector('.sb-header')
    await entrar(a)
    await waitFor(() => enLlamada(a), 10000, 'Ana entra en la llamada')
    await waitFor(() => silenciado(a), 15000, 'se silencia aunque no se sepa lo del sistema')
    await sleep(tiempos.leaveMs + 4000)
    if (!(await enLlamada(a))) throw new Error('sin saber lo del sistema no se debe echar a nadie')
    ok('si el escritorio no dice cuánto lleva inactivo, se silencia pero nunca se echa de la llamada')
  } catch (e) {
    await capturarFallo('e2e2-afk')
    throw e
  } finally {
    await close()
    await net.testnet.destroy().catch(() => {})
  }
}

/** Varias salas a la vez, cada una con su historial. */
async function salas() {
  const net = await startNet()
  const apps = []
  const close = async () => { for (const p of apps.splice(0)) await p.app.close().catch(() => {}) }
  const rail = (p) => p.page.locator('.rail-item[data-room]')
  const say = async (p, t) => { await p.page.fill('.composer textarea', t); await p.page.keyboard.press('Enter') }
  const texts = (p) => p.page.locator('.msg').allTextContents()
  const openRoomTab = async (p) => { await p.page.locator('.up-btns .icon-btn').last().click(); await p.page.locator('.st-item', { hasText: 'Sala' }).click(); await p.page.waitForSelector('.fp') }
  try {
    console.log('Varias salas a la vez, con el historial separado')
    const ana = await launch(net, 'Ana'); apps.push(ana)
    let beto = await launch(net, 'Beto', { noKey: true, ready: '.setup' }); apps.push(beto)
    await beto.page.fill('#code', formatCode(net.key)); await beto.page.click('#join')
    await beto.page.waitForSelector('.sb-header', { timeout: 20000 })
    await waitFor(async () => (await count(ana, '.member:not(.offline)')) === 2, 25000, 'se ven')
    if ((await rail(beto).count()) !== 1) throw new Error('debería haber una sala')
    await say(ana, 'mensaje de la sala vieja')
    await waitFor(async () => (await texts(beto)).some((t) => t.includes('mensaje de la sala vieja')), 15000, 'llega a Beto')
    ok('Beto entra en la primera sala con el código y recibe lo de Ana')

    // Beto crea una sala nueva: el modal genera el código y entra en ella
    await openRoomTab(beto)
    await beto.page.locator('.btn', { hasText: 'Añadir otra sala' }).click()
    await beto.page.locator('.seg-item', { hasText: 'Crear una sala nueva' }).click()
    await beto.page.fill('.modal input.text >> nth=0', 'Los del fútbol')
    await beto.page.locator('.modal .btn', { hasText: 'Generar código' }).click()
    await beto.page.waitForSelector('.modal .code-box code')
    const newCode = (await beto.page.textContent('.modal .code-box code')).trim()
    await beto.page.locator('.modal .btn.green').click()
    await beto.page.waitForSelector('.sb-header', { timeout: 20000 })
    await waitFor(async () => (await rail(beto).count()) === 2, 10000, 'dos salas en la barra')
    if (!(await beto.page.locator('.sb-name').textContent()).includes('Los del fútbol')) throw new Error('la sala nueva debería llamarse como se pidió')
    if ((await texts(beto)).some((t) => t.includes('mensaje de la sala vieja'))) throw new Error('el historial de la sala vieja aparece en la nueva')
    ok('crear una sala nueva: aparece en la barra, con su nombre, vacía y sin el historial de la otra')

    // Seguir conectado a la vieja en segundo plano: Ana lo ve en línea y lo que escribe cuenta como no leído
    if ((await count(ana, '.member:not(.offline)')) !== 2) throw new Error('Ana debería seguir viendo a Beto: sigue conectado a la sala vieja')
    await say(ana, 'otro mensaje mientras estás en la otra sala')
    await waitFor(async () => (await beto.page.locator('.rail-item.unread[data-room]').count()) === 1, 15000, 'no leído en segundo plano')
    ok('en la sala que no estás viendo sigues conectado: los amigos te ven y los mensajes cuentan como no leídos')

    // Lo de una sala no llega a la otra
    await say(beto, 'secreto del fútbol')
    await sleep(2500)
    if ((await texts(ana)).some((t) => t.includes('secreto del fútbol'))) throw new Error('lo de la sala nueva llegó a la vieja')
    ok('lo escrito en la sala nueva no llega a la vieja')

    // Volver a la vieja: el historial sigue ahí y ya no hay no leídos
    await rail(beto).first().click()
    await beto.page.waitForSelector('.sb-header', { timeout: 20000 })
    await waitFor(async () => (await texts(beto)).some((t) => t.includes('otro mensaje mientras estás')), 15000, 'historial de la sala vieja')
    if ((await texts(beto)).some((t) => t.includes('secreto del fútbol'))) throw new Error('lo de la sala nueva aparece en la vieja')
    if ((await beto.page.locator('.rail-item.unread[data-room]').count()) !== 0) throw new Error('debería haberse limpiado lo no leído')
    ok('volver a la sala vieja: su historial está entero, sin lo de la otra, y sin no leídos')

    // El tercer amigo entra a la sala nueva con el código y la ve completa (se sincroniza solo ahí)
    const carla = await launch(net, 'Carla', { noKey: true, ready: '.setup' }); apps.push(carla)
    await carla.page.fill('#code', newCode); await carla.page.click('#join')
    await carla.page.waitForSelector('.sb-header', { timeout: 20000 })
    await waitFor(async () => (await texts(carla)).some((t) => t.includes('secreto del fútbol')), 30000, 'Carla recibe el historial de la sala nueva')
    if ((await texts(carla)).some((t) => t.includes('mensaje de la sala vieja'))) throw new Error('Carla recibió el historial de otra sala')
    ok('quien entra en la sala nueva recibe su historial y nada de la otra')

    // Reiniciar: las dos salas siguen y la activa se recuerda
    await beto.app.close()
    beto = await launch(net, 'Beto', { profile: beto.profile, noKey: true }); apps.push(beto)
    await waitFor(async () => (await rail(beto).count()) === 2, 15000, 'las dos salas tras reiniciar')
    ok('al reiniciar la aplicación siguen las dos salas')

    // Salir de la sala nueva (borrando su historial)
    await rail(beto).nth(1).click({ button: 'right' })
    await beto.page.locator('.ctx-item', { hasText: 'Salir de la sala' }).click()
    await beto.page.locator('label.check input').check()
    await beto.page.locator('.modal .btn.danger').click()
    await waitFor(async () => (await rail(beto).count()) === 1, 15000, 'queda una sala')
    await beto.page.waitForSelector('.sb-header', { timeout: 20000 })
    if (!(await texts(beto)).some((t) => t.includes('mensaje de la sala vieja'))) throw new Error('debería quedar en la sala vieja con su historial')
    ok('salir de una sala (borrando su historial) deja la otra intacta')

    // Actualizar desde una versión anterior: historial en data/, llave en group.key y sin rooms.json
    const prev = await launch(net, 'Dani'); apps.push(prev) // con la llave por entorno, como antes de las salas múltiples
    await say(prev, 'historial de antes de actualizar')
    await waitFor(async () => (await texts(prev)).some((t) => t.includes('historial de antes')), 10000, 'se guarda')
    await prev.app.close()
    fs.writeFileSync(path.join(prev.profile, 'group.key'), net.key + '\n') // el formato de llave de antes
    const logAntes = fs.readFileSync(path.join(prev.profile, 'data', 'log', 'events.jsonl'), 'utf8')
    const upd = await launch(net, 'Dani', { profile: prev.profile, noKey: true }); apps.push(upd)
    await waitFor(async () => (await texts(upd)).some((t) => t.includes('historial de antes de actualizar')), 15000, 'el historial de antes sigue ahí')
    const reg = JSON.parse(fs.readFileSync(path.join(prev.profile, 'rooms.json'), 'utf8'))
    if (reg.rooms.length !== 1 || reg.rooms[0].dir !== 'data') throw new Error('la sala de antes debería conservar su carpeta data: ' + JSON.stringify(reg.rooms))
    if (!fs.readFileSync(path.join(prev.profile, 'data', 'log', 'events.jsonl'), 'utf8').startsWith(logAntes)) throw new Error('el historial de antes se alteró')
    ok('actualizar desde una versión anterior: la sala de siempre conserva su historial sin moverlo')
  } catch (e) {
    await capturarFallo('e2e2-salas')
    throw e
  } finally {
    await close()
    await net.testnet.destroy().catch(() => {})
  }
}

/** Voz y cámara sin ningún candidato real de WebRTC: solo el túnel por la red P2P (también se ejecuta en Windows). */
async function tunel() {
  const apps = []
  const close = async () => { for (const p of apps.splice(0)) await p.app.close().catch(() => {}) }
  let n5
  try {
    const env = { HUMBLECHAT_FAKE_AUDIO_FILE: path.join(__dirname, 'speech.wav') }
    const idOf = (p) => p.page.evaluate(() => window.humble.init().then((i) => i.me.id))
    console.log('Voz y vídeo sin conexión WebRTC directa (túnel por la red P2P)')
    n5 = await startNet()
    const [q1, q2] = [await launch(n5, 'Ana', { env }), await launch(n5, 'Beto', { env })]
    apps.push(q1, q2)
    for (const p of [q1, q2]) await waitFor(async () => (await count(p, '.member:not(.offline)')) === 2, 25000, 'se ven')
    const [j1, j2] = [await idOf(q1), await idOf(q2)]
    // Sin candidatos reales: la única forma de que WebRTC conecte es el túnel (como con un CGNAT de datos móviles)
    await q1.page.evaluate((v) => localStorage.setItem('hc.dbg', JSON.stringify({ tunnelOnly: [v], verbose: true })), j2)
    await q2.page.evaluate((v) => localStorage.setItem('hc.dbg', JSON.stringify({ tunnelOnly: [v], verbose: true })), j1)
    await joinVoice([q1, q2])
    await waitFor(() => hears(q2, 'Ana'), 30000, 'Beto oye a Ana por el túnel')
    await waitFor(() => hears(q1, 'Beto'), 30000, 'Ana oye a Beto por el túnel')
    const paths = await q1.page.evaluate(async () => (await (await import('/voice.js')).diagnostics()).map((d) => d.path))
    if (!paths.length || !paths.every((x) => x === 'por túnel de la red P2P')) throw new Error('el camino debería ser el túnel, no: ' + paths.join(', '))
    const dg = await q1.page.evaluate(async () => (await (await import('/voice.js')).diagnostics())[0])
    if (!dg.tunnel || !(dg.tunnel.tx > 0 && dg.tunnel.rx > 0)) throw new Error('el diagnóstico debería contar paquetes del túnel: ' + JSON.stringify(dg.tunnel))
    if (!dg.ice || dg.ice.state !== 'connected' && dg.ice.state !== 'completed') throw new Error('estado ICE inesperado: ' + JSON.stringify(dg.ice))
    ok('sin conexión directa de WebRTC, la voz viaja por el túnel de la red P2P (y el diagnóstico lo cuenta)')
    await q1.page.locator('.round[aria-label="Encender cámara"]').click()
    await waitFor(() => q2.page.evaluate(() => [...document.querySelectorAll('.tile.has-cam video.cam')].some((v) => v.videoWidth > 0)), 30000, 'Beto ve la cámara de Ana por el túnel')
    ok('la cámara también llega por el túnel')
    // Pantalla compartida (Xvfb tarda a veces en dar la lista de pantallas: se reintenta el gesto)
    for (let i = 0; i < 4; i++) {
      await q1.page.locator('.round[aria-label="Compartir pantalla"]').click()
      if (await q1.page.locator('.src-card').first().waitFor({ timeout: 25000 }).then(() => true, () => false)) break
      await q1.page.keyboard.press('Escape')
    }
    await q1.page.locator('.src-card').first().click()
    await waitFor(async () => (await count(q2, '.tile-watch')) > 0, 20000, 'Beto ve el botón de ver pantalla')
    await q2.page.locator('.tile-watch').click()
    await waitFor(() => q2.page.evaluate(() => { const v = document.querySelector('.theater video'); return !!v && v.videoWidth > 0 }), 40000, 'Beto recibe el vídeo de la pantalla por el túnel')
    ok('la pantalla compartida también llega por el túnel')
  } catch (e) {
    await capturarFallo('e2e2-tunel')
    throw e
  } finally {
    await close()
    await n5?.testnet.destroy().catch(() => {})
  }
}

;(async () => {
  if (!only || only === 'contenido') await content()
  if (!only || only === 'sistema') await sistema()
  if (!only || only === 'tunel') await tunel()
  if (!only || only === 'salas') await salas()
  if (!only || only === 'afk') await afk()
  if (!only || only === 'utilidades') await utilidades()
  if (!only || only === 'musica') await musica()
  console.log(`\n${passed} comprobaciones OK`)
  process.exit(0)
})().catch((e) => { console.error('\n✘', e); process.exit(1) })
