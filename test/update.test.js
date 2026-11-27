'use strict'
// Bloqueo por versión obsoleta: lógica pura y máquina de estados (con actualizador simulado, sin Electron).
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { parseVersion, isNewer, decide, fetchLatest } = require('../src/main/versiongate')
const { UpdateController } = require('../src/main/updatecontroller')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(5) } }

test('parseVersion e isNewer', () => {
  assert.equal(parseVersion('v1.2.3'), '1.2.3')
  assert.equal(parseVersion('1.2.3-beta.1'), '1.2.3')
  assert.equal(parseVersion('nada'), null)
  assert.equal(parseVersion(undefined), null)
  assert.ok(isNewer('0.2.1', '0.2.0'))
  assert.ok(isNewer('0.10.0', '0.9.9'), 'compara números, no texto')
  assert.ok(isNewer('1.0.0', '0.99.99'))
  assert.ok(!isNewer('0.2.0', '0.2.0'))
  assert.ok(!isNewer('0.1.9', '0.2.0'))
})

test('decide: bloquea solo si hay una versión más nueva conocida', () => {
  assert.deepEqual(decide({ current: '0.2.0', latest: '0.2.1', latestSeen: '' }), { block: true, latest: '0.2.1', reason: 'outdated' })
  assert.equal(decide({ current: '0.2.1', latest: '0.2.1', latestSeen: '' }).block, false)
  assert.equal(decide({ current: '0.3.0', latest: '0.2.1', latestSeen: '' }).block, false, 'una versión de desarrollo más nueva que la publicada no se bloquea')
  // sin conexión
  assert.equal(decide({ current: '0.2.0', latest: null, latestSeen: '' }).block, false, 'sin poder comprobar y sin nada visto antes: no se bloquea')
  assert.deepEqual(decide({ current: '0.2.0', latest: null, latestSeen: '0.2.5' }), { block: true, latest: '0.2.5', reason: 'known-outdated' })
  assert.equal(decide({ current: '0.2.5', latest: null, latestSeen: '0.2.5' }).block, false)
  assert.equal(decide({ current: '0.2.0', latest: 'basura', latestSeen: '' }).block, false)
})

test('fetchLatest: si la API de GitHub no responde (límite por IP en datos móviles), usa la redirección de /releases/latest', async () => {
  let api = '403'
  const srv = http.createServer((q, r) => {
    if (q.url.startsWith('/api')) { if (api === 'hang') return; r.statusCode = 403; return r.end('rate limit') }
    if (q.url === '/o/r/releases/latest') { r.statusCode = 302; r.setHeader('location', '/o/r/releases/tag/v0.4.1'); return r.end() }
    if (q.url === '/o/r/releases/tag/v0.4.1') { r.statusCode = 200; return r.end('<html>') }
    r.statusCode = 404; r.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    assert.deepEqual(await fetchLatest(fetch, base + '/api', { fallbackUrl: base + '/o/r/releases/latest' }), { version: '0.4.1', url: base + '/o/r/releases/tag/v0.4.1' })
    assert.equal(await fetchLatest(fetch, base + '/api'), null, 'sin canal alternativo, null')
    api = 'hang'
    assert.deepEqual((await fetchLatest(fetch, base + '/api', { timeoutMs: 150, fallbackUrl: base + '/o/r/releases/latest' })).version, '0.4.1', 'también si la API no contesta')
    assert.equal(await fetchLatest(fetch, base + '/api', { fallbackUrl: base + '/nada' }), null, 'si el alternativo tampoco sirve')
  } finally { srv.closeAllConnections?.(); srv.close() }
})

test('fetchLatest: lee la última publicación y nunca lanza', async () => {
  let mode = 'ok'
  const srv = http.createServer((_q, r) => {
    if (mode === 'hang') return
    if (mode === '500') { r.statusCode = 500; return r.end('x') }
    r.setHeader('content-type', 'application/json')
    r.end(mode === 'json' ? '{no es json' : mode === 'notag' ? '{"name":"x"}' : JSON.stringify({ tag_name: 'v1.4.2', html_url: 'https://github.com/x/y/releases/tag/v1.4.2' }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/`
  try {
    assert.deepEqual(await fetchLatest(fetch, url), { version: '1.4.2', url: 'https://github.com/x/y/releases/tag/v1.4.2' })
    for (const m of ['500', 'json', 'notag']) { mode = m; assert.equal(await fetchLatest(fetch, url), null, m) }
    mode = 'hang'
    const t0 = Date.now()
    assert.equal(await fetchLatest(fetch, url, { timeoutMs: 200 }), null)
    assert.ok(Date.now() - t0 < 1500, 'respeta el tiempo máximo')
    assert.equal(await fetchLatest(fetch, 'http://127.0.0.1:1/', { timeoutMs: 500 }), null, 'puerto cerrado')
  } finally { srv.closeAllConnections?.(); srv.close() }
})

/** Un controlador con todo simulado. */
function make(over = {}) {
  const sent = []
  const calls = { stopNetwork: 0, relaunch: 0, forced: 0, lookup: 0, quitAndInstall: [], checkForUpdates: 0 }
  let seen = over.seen ?? ''
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates() { calls.checkForUpdates++; return over.onCheck ? over.onCheck(updater, calls) : Promise.resolve() },
    quitAndInstall(...a) { calls.quitAndInstall.push(a) }
  })
  const lookupResult = { value: 'latest' in over ? over.latest : { version: '0.3.0', url: 'https://github.com/x/y/releases/tag/v0.3.0' } }
  const ctl = new UpdateController({
    current: over.current ?? '0.2.0',
    active: () => over.active ?? true,
    lookup: async () => { calls.lookup++; return lookupResult.value },
    store: { get: () => seen, set: (v) => { seen = v } },
    canAutoUpdate: () => !!over.auto,
    createUpdater: () => updater,
    stopNetwork: async () => { calls.stopNetwork++ },
    relaunch: () => { calls.relaunch++ },
    onForced: () => { calls.forced++ },
    send: (type, msg) => sent.push({ type, ...msg }),
    graceMs: over.graceMs ?? 40,
    retryMs: over.retryMs ?? 30,
    installDelayMs: over.installDelayMs ?? 10
  })
  return { ctl, sent, calls, updater, lookupResult, seen: () => seen }
}

test('arranque con versión obsoleta: bloquea, para la red y pasa a modo manual', async () => {
  const { ctl, sent, calls, seen } = make()
  const r = await ctl.gateAtStartup()
  assert.equal(r.block, true)
  assert.equal(calls.stopNetwork, 1)
  assert.equal(calls.forced, 1)
  assert.equal(ctl.state().state, 'forced')
  assert.equal(ctl.state().mode, 'manual')
  assert.equal(ctl.state().version, '0.3.0')
  assert.equal(ctl.state().current, '0.2.0')
  assert.equal(sent.at(-1).url, 'https://github.com/x/y/releases/tag/v0.3.0')
  assert.equal(seen(), '0.3.0', 'recuerda la última versión vista')
  ctl.stop()
})

test('arranque con la última versión, sin conexión o con el bloqueo inactivo: no bloquea', async () => {
  let m = make({ latest: { version: '0.2.0', url: null } })
  assert.equal((await m.ctl.gateAtStartup()).block, false)
  assert.equal(m.ctl.state(), null)
  assert.equal(m.calls.stopNetwork, 0)
  m = make({ latest: null })
  assert.equal((await m.ctl.gateAtStartup()).block, false, 'sin conexión y sin nada visto')
  m = make({ latest: null, seen: '0.3.0' })
  const r = await m.ctl.gateAtStartup()
  assert.equal(r.block, true, 'sin conexión pero ya se vio una versión más nueva')
  assert.equal(r.reason, 'known-outdated')
  m = make({ active: false })
  assert.equal((await m.ctl.gateAtStartup()).block, false)
  assert.equal(m.calls.lookup, 0, 'inactivo: ni siquiera consulta')
  for (const x of [m]) x.ctl.stop()
})

test('si se retira la versión nueva, se olvida y ya no bloquea sin conexión', async () => {
  const m = make({ latest: { version: '0.3.0', url: null } })
  await m.ctl.gateAtStartup()
  assert.equal(m.seen(), '0.3.0')
  const n = make({ latest: { version: '0.2.0', url: null }, seen: '0.3.0' })
  assert.equal((await n.ctl.gateAtStartup()).block, false)
  assert.equal(n.seen(), '0.2.0', 'lo publicado manda')
  m.ctl.stop(); n.ctl.stop()
})

test('en plena sesión: plazo de gracia con cuenta atrás y después bloqueo', async () => {
  const m = make({ latest: { version: '0.2.0', url: null }, graceMs: 60 })
  await m.ctl.check()
  assert.equal(m.ctl.state(), null, 'al día: nada')
  m.lookupResult.value = { version: '0.3.0', url: 'https://x/y' }
  await m.ctl.check()
  assert.equal(m.ctl.state().state, 'grace')
  assert.ok(m.ctl.state().deadline > Date.now() - 5)
  assert.equal(m.calls.stopNetwork, 0, 'aún no se corta durante el plazo')
  await m.ctl.check() // otra comprobación durante el plazo: no cambia nada
  await until(() => m.ctl.state().state === 'forced')
  assert.equal(m.calls.stopNetwork, 1)
  assert.equal(m.calls.forced, 1)
  m.ctl.stop()
})

test('modo automático: descarga con progreso y se instala sola', async () => {
  const m = make({
    auto: true,
    onCheck: (u) => { setTimeout(() => { u.emit('download-progress', { percent: 41.6 }); u.emit('download-progress', { percent: 100 }); u.emit('update-downloaded') }, 5); return Promise.resolve() }
  })
  await m.ctl.gateAtStartup()
  assert.equal(m.ctl.state().mode, 'auto')
  await until(() => m.calls.quitAndInstall.length === 1)
  assert.deepEqual(m.calls.quitAndInstall[0], [true, true], 'silenciosa y reabre la aplicación')
  const stages = m.sent.filter((x) => x.state === 'forced').map((x) => x.stage + (x.percent != null ? ':' + x.percent : ''))
  assert.deepEqual(stages, ['checking', 'checking', 'downloading:42', 'downloading:100', 'installing'])
  m.ctl.stop()
})

test('modo automático: un error se muestra y se reintenta hasta lograrlo', async () => {
  let n = 0
  const m = make({
    auto: true,
    onCheck: (u) => { n++; setTimeout(() => (n === 1 ? u.emit('error', new Error('sin red')) : u.emit('update-downloaded')), 5); return Promise.resolve() }
  })
  await m.ctl.gateAtStartup()
  await until(() => m.calls.quitAndInstall.length === 1)
  assert.equal(m.calls.checkForUpdates, 2)
  const err = m.sent.find((x) => x.stage === 'error')
  assert.match(err.message, /sin red/)
  m.ctl.stop()
})

test('modo automático: «no hay actualización» del actualizador cuenta como error y reintenta', async () => {
  let n = 0
  const m = make({ auto: true, onCheck: (u) => { n++; setTimeout(() => (n === 1 ? u.emit('update-not-available') : u.emit('update-downloaded')), 5); return Promise.resolve() } })
  await m.ctl.gateAtStartup()
  await until(() => m.calls.quitAndInstall.length === 1)
  assert.match(m.sent.find((x) => x.stage === 'error').message, /todavía no encuentra/)
  m.ctl.stop()
})

test('modo automático sin actualizador disponible cae a manual', async () => {
  const m = make({ auto: true })
  m.ctl.createUpdater = () => { throw new Error('no instalado') }
  await m.ctl.gateAtStartup()
  assert.equal(m.ctl.state().mode, 'manual')
  m.ctl.stop()
})

test('volver a comprobar: si ya no hace falta, se reinicia; si sigue obsoleta, no', async () => {
  const m = make()
  await m.ctl.gateAtStartup()
  assert.equal((await m.ctl.recheck()).block, true)
  assert.equal(m.calls.relaunch, 0)
  m.lookupResult.value = { version: '0.2.0', url: null }
  assert.equal((await m.ctl.recheck()).block, false)
  assert.equal(m.calls.relaunch, 1)
  m.ctl.stop()
})

test('el Diagnóstico sabe cómo fue la última comprobación', async () => {
  const m = make({ latest: null })
  assert.equal(m.ctl.lastCheck(), null)
  await m.ctl.check()
  assert.deepEqual({ ...m.ctl.lastCheck(), at: 0 }, { at: 0, ok: false, latest: null, current: '0.2.0' })
  m.lookupResult.value = { version: '0.2.0', url: null }
  await m.ctl.check()
  assert.equal(m.ctl.lastCheck().ok, true)
  assert.equal(m.ctl.lastCheck().latest, '0.2.0')
  m.ctl.stop()
})

test('el temporizador periódico comprueba y no deja procesos colgados al parar', async () => {
  const m = make({ latest: { version: '0.2.0', url: null }, graceMs: 20 })
  m.ctl.start(15)
  await sleep(60)
  const before = m.calls.lookup
  assert.ok(before >= 2, 'comprueba periódicamente')
  m.lookupResult.value = { version: '0.3.0', url: null }
  await until(() => m.ctl.state()?.state === 'forced')
  m.ctl.stop()
  const after = m.calls.lookup
  await sleep(50)
  assert.equal(m.calls.lookup, after, 'parado: no vuelve a consultar')
})
