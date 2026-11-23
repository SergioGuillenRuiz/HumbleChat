'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const Hyperswarm = require('hyperswarm')
const createTestnet = require('hyperdht/testnet')
const { ChatNode } = require('../src/core/node')
const { topicOf } = require('../src/core/groupkey')
const { encodeJSON, Decoder } = require('../src/core/frames')
const { Store } = require('../src/core/store')

const newKey = () => crypto.randomBytes(32).toString('hex')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'))

async function waitFor(fn, ms = 15000, what = 'condición') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error('timeout esperando: ' + what)
}

let testnet
const nodes = []
async function spawn(key, dir = tmp()) {
  const n = new ChatNode({ dir, groupKey: key, dht: testnet.createNode() })
  n.testDir = dir
  await n.start()
  nodes.push(n)
  return n
}
const texts = (n, ch = 'general') => n.history(ch, { limit: 100 }).map((e) => e.text)

test.before(async () => { testnet = await createTestnet(3) })
test.after(async () => {
  for (const n of nodes) await n.stop().catch(() => {})
  await testnet.destroy()
})

test('el primero que abre queda solo; el segundo lo encuentra y recibe el historial', async () => {
  const K = newKey()
  const a = await spawn(K)
  a.send('general', 'hola desde A, nadie conectado')
  const b = await spawn(K)
  await waitFor(() => a.peers.size === 1 && b.peers.size === 1, 15000, 'A y B conectados')
  await waitFor(() => texts(b).includes('hola desde A, nadie conectado'), 5000, 'B recibe historial')
  b.send('general', 'respuesta de B')
  await waitFor(() => texts(a).includes('respuesta de B'), 5000, 'A recibe de B')
  assert.deepEqual(texts(a), texts(b))
})

test('malla de 3 + failover: si el primero se va, el resto sigue y el primero se pone al día al volver', async () => {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  const c = await spawn(K)
  await waitFor(() => [a, b, c].every((n) => n.peers.size === 2), 20000, 'malla completa')
  const aDir = a.testDir
  await a.stop()
  await waitFor(() => b.peers.size === 1 && c.peers.size === 1, 15000, 'B y C notan que A se fue')
  b.send('general', 'mensaje mientras A no está')
  await waitFor(() => texts(c).includes('mensaje mientras A no está'), 5000, 'C recibe sin host')
  const a2 = await spawn(K, aDir) // misma identidad y datos que A
  await waitFor(() => texts(a2).includes('mensaje mientras A no está'), 15000, 'A vuelve y sincroniza')
  assert.equal(a2.id, a.id)
})

test('borrar un mensaje propio se replica; no se pueden borrar los ajenos', async () => {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  await waitFor(() => a.peers.size >= 1 && b.peers.size >= 1, 15000, 'conectados')
  const ev = a.send('general', 'borrame ' + crypto.randomBytes(4).toString('hex'))
  await waitFor(() => texts(b).includes(ev.text), 5000, 'B lo recibe')
  assert.equal(b.remove(`${ev.a}:${ev.n}`), null, 'B no puede borrar mensajes de A')
  a.remove(`${ev.a}:${ev.n}`)
  await waitFor(() => !texts(b).includes(ev.text), 5000, 'B ve el borrado')
  assert.ok(!texts(a).includes(ev.text))
})

test('nombres, presencia de voz y señalización llegan por conexión directa', async () => {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  await waitFor(() => a.peers.has(b.id) && b.peers.has(a.id), 15000, 'conectados')
  a.setName('Ana')
  await waitFor(() => b.members().find((m) => m.id === a.id)?.name === 'Ana', 5000, 'nombre replicado')
  a.setVoice({ ch: 'voz-general', mute: true, deaf: false, share: false })
  await waitFor(() => b.members().find((m) => m.id === a.id)?.voice?.ch === 'voz-general', 5000, 'presencia de voz')
  assert.equal(b.members().find((m) => m.id === a.id).voice.mute, true)
  let got = null
  a.on('signal', (from, data) => { got = { from, data } })
  b.signal(a.id, { k: 'ice', n: 7 })
  await waitFor(() => got, 5000, 'señal')
  assert.equal(got.from, b.id)
  assert.deepEqual(got.data, { k: 'ice', n: 7 })
  a.setVoice(null)
  await waitFor(() => b.members().find((m) => m.id === a.id)?.voice === null, 5000, 'sale de voz')
})

test('los adjuntos se replican por contenido y se verifican', async () => {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  await waitFor(() => a.peers.has(b.id), 15000, 'conectados')
  const img = crypto.randomBytes(300 * 1024) // varios trozos
  const att = a.addBlob(img, { name: 'foto.png', mime: 'image/png', w: 10, ht: 10 })
  a.send('fotos', '', [att])
  await waitFor(() => b.blobs.has(att.h), 10000, 'B descarga el adjunto')
  assert.ok(fs.readFileSync(b.blobs.path(att.h)).equals(img))
  // Un nodo que llega tarde también lo recibe al sincronizar.
  const c = await spawn(K)
  await waitFor(() => c.blobs.has(att.h), 15000, 'C (tardío) descarga el adjunto')
})

test('quien no conoce la llave de grupo es expulsado aunque encuentre el tema', async () => {
  const K = newKey()
  const a = await spawn(K)
  const intruder = new Hyperswarm({ dht: testnet.createNode() })
  let closed = false
  intruder.on('connection', (conn) => {
    conn.on('error', () => {})
    conn.on('close', () => { closed = true })
    conn.write(encodeJSON({ t: 'hello', v: 1, proof: 'aa'.repeat(32), name: 'intruso' }))
  })
  intruder.join(topicOf(K), { server: true, client: true })
  await intruder.flush()
  await waitFor(() => closed, 10000, 'intruso expulsado')
  assert.equal(a.peers.size, 0)
  assert.ok(!a.members().some((m) => m.name === 'intruso'))
  await intruder.destroy()
})

test('si dos amigos no pueden conectarse directamente, los mensajes y adjuntos llegan retransmitidos por un tercero', async () => {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  const c = await spawn(K)
  await waitFor(() => [a, b, c].every((n) => n.peers.size === 2), 20000, 'malla completa')
  // Simula un NAT que impide A<->B: se banean mutuamente y se corta la conexión directa.
  for (const [x, y] of [[a, b], [b, a]]) {
    x.swarm.peers.get(y.id)?.ban(true)
    x.peers.get(y.id)?.conn.destroy()
  }
  await waitFor(() => !a.peers.has(b.id) && !b.peers.has(a.id) && a.peers.has(c.id) && b.peers.has(c.id), 15000, 'A y B desconectados entre sí')
  const ev = a.send('general', 'por el camino largo')
  await waitFor(() => texts(b).includes('por el camino largo'), 8000, 'B recibe vía C')
  const att = a.addBlob(crypto.randomBytes(120 * 1024), { name: 'x.png', mime: 'image/png', w: 5, ht: 5 })
  a.send('fotos', '', [att])
  await waitFor(() => b.blobs.has(att.h), 15000, 'B descarga el adjunto vía C')
  assert.ok(ev)
})

test('el store rechaza basura y reordena por (ts, id); el decoder tolera trozos partidos', () => {
  const dir = tmp()
  const s = new Store(dir)
  s.open()
  const A = 'a'.repeat(64)
  assert.equal(s.add({ a: A, n: 1, ts: 5, t: 'msg', ch: 'nope', text: 'x' }), 'bad')
  assert.equal(s.add({ a: A, n: 1, ts: 5, t: 'msg', ch: 'general', text: '' }), 'bad')
  assert.equal(s.add({ a: A, n: 2, ts: 3, t: 'msg', ch: 'general', text: 'segundo' }), 'new')
  assert.deepEqual(s.vector(), {}) // hueco: falta n=1, el vector no avanza
  assert.equal(s.add({ a: A, n: 1, ts: 9, t: 'msg', ch: 'general', text: 'primero' }), 'new')
  assert.deepEqual(s.vector(), { [A]: 2 })
  assert.deepEqual(s.history('general').map((e) => e.text), ['segundo', 'primero'])
  assert.equal(s.add({ a: A, n: 1, ts: 9, t: 'msg', ch: 'general', text: 'primero' }), 'dup')

  const frames = []
  const d = new Decoder((m) => frames.push(m), () => {}, (e) => { throw e })
  const buf = Buffer.concat([encodeJSON({ x: 1 }), encodeJSON({ y: 'ñ' })])
  for (let i = 0; i < buf.length; i += 3) d.push(buf.subarray(i, i + 3))
  assert.deepEqual(frames, [{ x: 1 }, { y: 'ñ' }])
})

test('persistencia: el historial sobrevive a un reinicio', async () => {
  const dir = tmp()
  const K = newKey()
  const a = await spawn(K, dir)
  a.send('general', 'persistente ' + a.id.slice(0, 4))
  await a.stop()
  const a2 = await spawn(K, dir)
  assert.ok(texts(a2).some((t) => t.startsWith('persistente')))
})
