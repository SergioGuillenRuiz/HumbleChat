'use strict'
// Presencia de voz y señales por un tercero (dos amigos sin conexión directa, p. ej. con NAT simétrico).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const createTestnet = require('hyperdht/testnet')
const { ChatNode } = require('../src/core/node')
const { signParts } = require('../src/core/sign')

const key = () => crypto.randomBytes(32).toString('hex')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-relay-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15000, what = 'condición') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40) }
  throw new Error('timeout esperando: ' + what)
}

let testnet
const nodes = []
// Latidos y caducidad cortos: las pruebas no esperan 8 y 25 s.
async function spawn(k, relay = { beatMs: 300, expireMs: 2500 }) {
  const n = new ChatNode({ dir: tmp(), groupKey: k, dht: testnet.createNode(), relay })
  await n.start()
  nodes.push(n)
  return n
}
test.before(async () => { testnet = await createTestnet(3) })
test.after(async () => {
  for (const n of nodes) await n.stop().catch(() => {})
  await testnet.destroy()
})

/** A y B conectados solo a través de C: se corta la conexión directa entre ellos (como haría un NAT que no deja pasar). */
async function triangle() {
  const K = key()
  const [a, b, c] = [await spawn(K), await spawn(K), await spawn(K)]
  await until(() => [a, b, c].every((n) => n.peers.size === 2), 20000, 'malla completa')
  for (const [x, y] of [[a, b], [b, a]]) { x.swarm.peers.get(y.id)?.ban(true); x.peers.get(y.id)?.conn.destroy() }
  await until(() => !a.peers.has(b.id) && !b.peers.has(a.id) && a.peers.has(c.id) && b.peers.has(c.id), 15000, 'A y B sin conexión directa')
  return { a, b, c }
}
const member = (n, id) => n.members().find((m) => m.id === id)

test('la presencia de voz llega a quien no tiene conexión directa, a través de un tercero', async () => {
  const { a, b, c } = await triangle()
  await until(() => member(b, a.id)?.online === true, 8000, 'B ve a A en línea')
  assert.equal(member(b, a.id).indirect, true, 'se marca como alcanzable solo a través de otro')
  assert.equal(member(c, a.id).indirect, undefined, 'el amigo directo no es indirecto')
  a.setVoice({ ch: 'voz-general', mute: true, deaf: false, share: false, cam: true })
  await until(() => member(b, a.id)?.voice?.ch === 'voz-general', 8000, 'B ve a A en la llamada')
  assert.deepEqual(member(b, a.id).voice, { ch: 'voz-general', mute: true, deaf: false, share: false, cam: true })
  a.setVoice(null)
  await until(() => member(b, a.id)?.voice === null, 8000, 'B ve que A salió de la llamada')
})

test('las señales de la llamada llegan por el tercero, en los dos sentidos', async () => {
  const { a, b } = await triangle()
  await until(() => member(b, a.id)?.indirect && member(a, b.id)?.indirect, 8000, 'se ven por el tercero')
  const got = []
  b.on('signal', (from, data) => got.push(['b', from, data]))
  a.on('signal', (from, data) => got.push(['a', from, data]))
  assert.equal(a.signal(b.id, { type: 'offer', sdp: 'v=0 a' }), true)
  assert.equal(b.signal(a.id, { candidate: { c: 'x', n: 1 } }), true)
  await until(() => got.length === 2, 8000, 'las dos señales')
  assert.deepEqual(got.find((g) => g[0] === 'b'), ['b', a.id, { type: 'offer', sdp: 'v=0 a' }])
  assert.deepEqual(got.find((g) => g[0] === 'a'), ['a', b.id, { candidate: { c: 'x', n: 1 } }])
})

test('sin forma de llegar a alguien, la señal no se envía', async () => {
  const K = key()
  const a = await spawn(K)
  assert.equal(a.signal(crypto.randomBytes(32).toString('hex'), { x: 1 }), false)
  assert.equal(a.signal('no-es-un-id', { x: 1 }), false)
})

test('lo retransmitido no se puede alterar, suplantar ni repetir', async () => {
  const { a, b, c } = await triangle()
  const emitted = []
  b.on('signal', (from, data) => emitted.push([from, data]))
  const fake = { id: c.id, send() {} } // el vecino por el que "llega" lo retransmitido
  const frame = (over = {}, author = a) => {
    const f = { f: author.id, to: b.id, ts: Date.now(), id: crypto.randomBytes(8).toString('hex'), d: JSON.stringify({ sdp: 'ok' }), ...over }
    f.sig = signParts(author.identity.keyPair.secretKey, 'humblechat/rsig/v1', [f.f, f.to, f.ts, f.id, f.d])
    return { t: 'rsg', ttl: 3, ...f }
  }
  const ok = frame()
  b.relay.onSignal(fake, ok)
  assert.equal(emitted.length, 1, 'la buena se entrega')
  b.relay.onSignal(fake, ok)
  assert.equal(emitted.length, 1, 'repetirla no sirve')
  b.relay.onSignal(fake, { ...frame(), d: JSON.stringify({ sdp: 'alterado' }) })
  assert.equal(emitted.length, 1, 'cambiar el contenido invalida la firma')
  b.relay.onSignal(fake, { ...frame(), f: c.id })
  assert.equal(emitted.length, 1, 'firmar con una llave y decir que es de otro no sirve')
  b.relay.onSignal(fake, frame({ ts: Date.now() - 5 * 60 * 1000 }))
  assert.equal(emitted.length, 1, 'una señal vieja se descarta')
  b.relay.onSignal(fake, frame({ to: c.id }))
  assert.equal(emitted.length, 1, 'las dirigidas a otro no se entregan aquí')
  b.relay.onSignal(fake, frame({ d: '{no es json' }))
  assert.equal(emitted.length, 1, 'un contenido que no es JSON se descarta')
  b.relay.onSignal(fake, frame({ d: 'x'.repeat(70 * 1024) }))
  assert.equal(emitted.length, 1, 'un mensaje enorme se descarta')
  // otra firma válida de otro autor con su propia clave sí se entrega (c firma lo suyo)
  b.relay.onSignal(fake, frame({}, c))
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1][0], c.id)
})

test('la presencia retransmitida exige firma, secuencia creciente y hora razonable', async () => {
  const { a, b, c } = await triangle()
  const fake = { id: c.id, send() {} }
  const stranger = crypto.randomBytes(32).toString('hex')
  const mk = (over = {}, author = a) => {
    const f = { o: author.id, ts: Date.now(), q: Date.now() + 1e6, voice: { ch: 'voz-juegos', mute: false, deaf: false, share: false, cam: false }, ...over }
    f.sig = signParts(author.identity.keyPair.secretKey, 'humblechat/rpres/v1', [f.o, f.ts, f.q, f.voice ? [f.voice.ch, 0, 0, 0, 0] : null])
    return { t: 'rpr', ttl: 3, ...f }
  }
  const before = member(b, a.id)?.voice?.ch ?? null
  b.relay.onPresence(fake, { ...mk(), voice: { ch: 'voz-general', mute: false, deaf: false, share: false, cam: false } })
  assert.equal(member(b, a.id)?.voice?.ch ?? null, before, 'el contenido alterado no se acepta')
  b.relay.onPresence(fake, { ...mk(), o: stranger })
  assert.equal(member(b, stranger), undefined, 'una presencia con la firma de otro no crea miembros')
  b.relay.onPresence(fake, mk({ ts: Date.now() - 10 * 60 * 1000 }))
  assert.equal(member(b, a.id)?.voice?.ch ?? null, before, 'una hora lejana se descarta')
  b.relay.onPresence(fake, mk({ q: 1 }))
  assert.equal(member(b, a.id)?.voice?.ch ?? null, before, 'una secuencia vieja se descarta')
  b.relay.onPresence(fake, mk())
  assert.equal(member(b, a.id).voice.ch, 'voz-juegos', 'la buena se acepta')
  b.relay.onPresence(fake, mk({ voice: { ch: 'voz-general', mute: false, deaf: false, share: false, cam: false }, q: Date.now() + 5e5 }))
  assert.equal(member(b, a.id).voice.ch, 'voz-juegos', 'una secuencia más baja que la última aceptada no la pisa')
})

test('el amigo que ya no está deja de aparecer: al irse el intermedio o al dejar de dar señales', async () => {
  const { a, b, c } = await triangle()
  await until(() => member(b, a.id)?.online === true, 8000, 'B ve a A')
  await c.stop() // se va el intermedio: nadie más une a A y B
  await until(() => member(b, a.id)?.online === false && member(a, b.id)?.online === false, 8000, 'dejan de verse al irse C')
})

test('si el amigo deja de dar señales de vida, caduca', async () => {
  const { a, b } = await triangle()
  await until(() => member(b, a.id)?.online === true, 8000, 'B ve a A')
  clearInterval(a.relay.timer) // A deja de emitir latidos pero sigue conectado a C
  await until(() => member(b, a.id)?.online === false, 8000, 'caduca')
})

test('los amigos con conexión directa no se tratan como indirectos y no hay presencia duplicada', async () => {
  const K = key()
  const [a, b] = [await spawn(K), await spawn(K)]
  await until(() => a.peers.size === 1 && b.peers.size === 1, 20000, 'conectados')
  a.setVoice({ ch: 'voz-general', mute: false, deaf: false, share: false, cam: false })
  await until(() => member(b, a.id)?.voice?.ch === 'voz-general', 5000, 'B ve la voz')
  assert.equal(member(b, a.id).indirect, undefined)
  assert.equal(b.relay.reachable().size, 0)
  // y una señal directa sigue yendo por la conexión directa
  const got = []
  b.on('signal', (from, data) => got.push([from, data]))
  assert.equal(a.signal(b.id, { sdp: 'directa' }), true)
  await until(() => got.length === 1, 5000, 'señal directa')
  assert.deepEqual(got[0], [a.id, { sdp: 'directa' }])
})

test('cada amigo informa de la versión de su aplicación (para diagnosticar versiones antiguas)', async () => {
  const K = key()
  const mk = async (appVersion) => {
    const n = new ChatNode({ dir: tmp(), groupKey: K, dht: testnet.createNode(), appVersion })
    await n.start(); nodes.push(n); return n
  }
  const [a, b] = [await mk('0.2.2'), await mk('')] // b es de una versión que aún no informaba
  await until(() => a.peers.size === 1 && b.peers.size === 1, 20000, 'conectados')
  assert.equal(a.diagnostics().peers[0].app, null, 'una versión que no informa aparece como desconocida')
  assert.equal(b.diagnostics().peers[0].app, '0.2.2')
})

test('sin ningún amigo conectado se repite la búsqueda con retroceso; con amigos, solo de vez en cuando', async () => {
  const K = key()
  const cfg = { firstMs: 120, maxMs: 480, connectedMs: 5000, tickMs: 20 }
  const a = new ChatNode({ dir: tmp(), groupKey: K, dht: testnet.createNode(), rediscover: cfg })
  await a.start(); nodes.push(a)
  let refreshes = 0
  const orig = a.discovery.refresh.bind(a.discovery)
  a.discovery.refresh = () => { refreshes++; return orig() }
  await sleep(1500)
  assert.ok(refreshes >= 3, 'solo y sin amigos: reintenta (' + refreshes + ')')
  assert.ok(refreshes <= 8, 'pero con retroceso, sin martillear la red (' + refreshes + ')')
  const b = new ChatNode({ dir: tmp(), groupKey: K, dht: testnet.createNode(), rediscover: cfg })
  await b.start(); nodes.push(b)
  await until(() => a.peers.size === 1, 20000, 'se encuentran')
  const n = refreshes
  await sleep(800)
  assert.ok(refreshes - n <= 1, 'con un amigo conectado ya no insiste (' + (refreshes - n) + ')')
})
