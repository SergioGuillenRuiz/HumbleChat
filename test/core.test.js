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
const { topicOf, generateKey, formatCode, parseCode, fingerprint } = require('../src/core/groupkey')
const { encodeJSON, Decoder } = require('../src/core/frames')
const { Store } = require('../src/core/store')
const { sign } = require('../src/core/sign')
const { PROTOCOL } = require('../src/core/constants')
const { proofOf } = require('../src/core/groupkey')
const DHT = require('hyperdht')

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
  // Reintento de búsqueda rápido: si en una máquina cargada la primera búsqueda se pierde, se recupera dentro del plazo de la prueba
  const n = new ChatNode({ dir, groupKey: key, dht: testnet.createNode(), rediscover: { firstMs: 3000, maxMs: 6000, connectedMs: 60000 } })
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

test('un amigo con otra versión de la app se detecta y se avisa; un extraño sin la llave no puede provocar el aviso', async () => {
  const K = newKey()
  const a = await spawn(K)
  const old = new Hyperswarm({ dht: testnet.createNode() })
  const stranger = new Hyperswarm({ dht: testnet.createNode() })
  old.on('connection', (conn) => { conn.on('error', () => {}); conn.write(encodeJSON({ t: 'hello', v: 1, proof: proofOf(K, conn.handshakeHash), name: 'viejo' })) })
  old.join(topicOf(K), { server: true, client: true })
  await old.flush()
  await waitFor(() => a.status().mismatch === true, 10000, 'aviso de versión distinta')
  await old.destroy()

  const b = await spawn(newKey())
  stranger.on('connection', (conn) => { conn.on('error', () => {}); conn.write(encodeJSON({ t: 'hello', v: 1, proof: 'bb'.repeat(32), name: 'x' })) })
  stranger.join(topicOf(b.groupKey), { server: true, client: true })
  await stranger.flush()
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(b.status().mismatch, undefined, 'sin la llave no se provoca el aviso')
  await stranger.destroy()
})

test('el store rechaza basura y reordena por (ts, id); el decoder tolera trozos partidos', () => {
  const dir = tmp()
  const s = new Store(dir)
  s.open()
  const kp = DHT.keyPair()
  const A = kp.publicKey.toString('hex')
  const mk = (n, ts, fields) => { const e = { a: A, n, ts, ...fields }; e.sig = sign(kp.secretKey, e); return e }
  assert.equal(s.add(mk(1, 5, { t: 'msg', ch: 'No Válido!', text: 'x' })), 'bad')
  assert.equal(s.add(mk(1, 5, { t: 'msg', ch: 'general', text: '' })), 'bad')
  assert.equal(s.add(mk(2, 3, { t: 'msg', ch: 'general', text: 'segundo' })), 'new')
  assert.deepEqual(s.vector(), {}) // hueco: falta n=1, el vector no avanza
  assert.equal(s.add(mk(1, 9, { t: 'msg', ch: 'general', text: 'primero' })), 'new')
  assert.deepEqual(s.vector(), { [A]: 2 })
  assert.deepEqual(s.history('general').map((e) => e.text), ['segundo', 'primero'])
  assert.equal(s.add(mk(1, 9, { t: 'msg', ch: 'general', text: 'primero' })), 'dup')

  const frames = []
  const d = new Decoder((m) => frames.push(m), () => {}, (e) => { throw e })
  const buf = Buffer.concat([encodeJSON({ x: 1 }), encodeJSON({ y: 'ñ' })])
  for (let i = 0; i < buf.length; i += 3) d.push(buf.subarray(i, i + 3))
  assert.deepEqual(frames, [{ x: 1 }, { y: 'ñ' }])
})

test('firmas: no se puede suplantar, alterar ni borrar lo de otro', () => {
  const s = new Store(tmp())
  s.open()
  const victim = DHT.keyPair()
  const attacker = DHT.keyPair()
  const V = victim.publicKey.toString('hex')
  const real = { a: V, n: 1, ts: 100, t: 'msg', ch: 'general', text: 'lo dije yo' }
  real.sig = sign(victim.secretKey, real)

  // 1) El atacante firma con SU clave un evento que dice ser de la víctima.
  const forged = { a: V, n: 1, ts: 100, t: 'msg', ch: 'general', text: 'dinero a esta cuenta' }
  forged.sig = sign(attacker.secretKey, forged)
  assert.equal(s.add(forged), 'bad', 'suplantación rechazada')
  // 2) Sin firma, o con la firma de otro mensaje.
  assert.equal(s.add({ ...real, sig: undefined }), 'bad', 'sin firma')
  assert.equal(s.add({ ...real, text: 'otra cosa' }), 'bad', 'texto alterado tras firmar')
  assert.equal(s.add({ ...real, ts: 101 }), 'bad', 'fecha alterada')
  assert.equal(s.add({ ...real, ch: 'fotos' }), 'bad', 'canal alterado')
  // 3) La auténtica entra, y la falsa ya no puede "pisar" el n=1.
  assert.equal(s.add(real), 'new')
  assert.equal(s.add(forged), 'dup')
  assert.deepEqual(s.history('general').map((e) => e.text), ['lo dije yo'])
  // 4) Borrar el mensaje de otro: el atacante firma un "del" como si fuera la víctima.
  const evilDel = { a: V, n: 2, ts: 200, t: 'del', x: `${V}:1` }
  evilDel.sig = sign(attacker.secretKey, evilDel)
  assert.equal(s.add(evilDel), 'bad')
  assert.equal(s.history('general').length, 1)
})

test('un compañero con la llave pero malicioso no puede inyectar mensajes en nombre de otro', async () => {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  await waitFor(() => a.peers.has(b.id), 15000, 'conectados')
  // Un tercero con la llave correcta (pasa la autenticación de grupo) intenta suplantar a A ante B.
  const mal = new Hyperswarm({ dht: testnet.createNode() })
  const ev = { a: a.id, n: 999, ts: Date.now(), t: 'msg', ch: 'general', text: 'MENSAJE FALSO de ' + a.name }
  ev.sig = sign(mal.keyPair.secretKey, ev)
  mal.on('connection', (conn) => {
    conn.on('error', () => {})
    conn.write(encodeJSON({ t: 'hello', v: PROTOCOL, proof: proofOf(K, conn.handshakeHash), name: 'mal' }))
    conn.write(encodeJSON({ t: 'ev', e: ev }))
    conn.write(encodeJSON({ t: 'evs', list: [ev] }))
  })
  mal.join(topicOf(K), { server: true, client: true })
  await mal.flush()
  await waitFor(() => b.peers.size === 2, 10000, 'B ve al malicioso')
  await new Promise((r) => setTimeout(r, 800))
  assert.ok(!texts(b).some((t) => t.includes('FALSO')), 'B no acepta el evento falso')
  assert.ok(!texts(a).some((t) => t.includes('FALSO')))
  await mal.destroy()
})

test('editar, reaccionar y responder: se replican, solo el autor edita y las reacciones se pueden quitar', async () => {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  await waitFor(() => a.peers.has(b.id), 15000, 'conectados')
  const m1 = a.send('general', 'texto con errata')
  const id1 = `${m1.a}:${m1.n}`
  await waitFor(() => texts(b).includes('texto con errata'), 5000, 'B recibe')
  const view = (n, id) => n.history('general', { limit: 50 }).find((e) => `${e.a}:${e.n}` === id)

  // editar: el autor sí, otro no
  assert.equal(b.edit(id1, 'b intenta editar lo de a'), null)
  a.edit(id1, 'texto corregido')
  await waitFor(() => view(b, id1)?.text === 'texto corregido', 5000, 'B ve la edición')
  assert.equal(view(b, id1).edited, true)
  assert.equal(view(a, id1).edited, true)

  // reacciones: dos usuarios, y quitar
  b.react(id1, '👍', true)
  a.react(id1, '👍', true)
  a.react(id1, '🎉', true)
  await waitFor(() => view(a, id1)?.reactions?.find((r) => r.e === '👍')?.users.length === 2, 5000, 'dos 👍')
  await waitFor(() => view(b, id1)?.reactions?.length === 2, 5000, 'B ve las 2 reacciones')
  b.react(id1, '👍', false)
  await waitFor(() => view(a, id1)?.reactions?.find((r) => r.e === '👍')?.users.length === 1, 5000, 'B quita su 👍')
  a.react(id1, '🎉', false)
  await waitFor(() => view(b, id1)?.reactions?.length === 1, 5000, 'desaparece 🎉')

  // responder: la respuesta lleva vista previa del original; si se borra, queda como "no disponible"
  const r = b.send('general', 'respuesta', [], id1)
  await waitFor(() => view(a, `${r.a}:${r.n}`)?.reply?.text === 'texto corregido', 5000, 'A ve la respuesta con vista previa')
  assert.equal(view(a, `${r.a}:${r.n}`).reply.a, a.id)
  a.remove(id1)
  await waitFor(() => view(b, `${r.a}:${r.n}`)?.reply?.missing === true, 5000, 'original borrado')

  // "está escribiendo…" llega a los conectados
  let who = null
  a.on('typing', (id, ch) => { who = { id, ch } })
  b.typing('general')
  await waitFor(() => who, 5000, 'typing')
  assert.deepEqual(who, { id: b.id, ch: 'general' })
})

test('ediciones y reacciones válidas llegan aunque el mensaje original llegue después, y las falsas se ignoran', () => {
  const s = new Store(tmp())
  s.open()
  const A = DHT.keyPair()
  const B = DHT.keyPair()
  const ha = A.publicKey.toString('hex')
  const hb = B.publicKey.toString('hex')
  const mk = (kp, n, fields) => { const e = { a: kp.publicKey.toString('hex'), n, ts: 100 + n, ...fields }; e.sig = sign(kp.secretKey, e); return e }
  const target = `${ha}:1`
  assert.equal(s.add(mk(A, 2, { t: 'edit', x: target, text: 'editado' })), 'new') // la edición llega primero
  assert.equal(s.add(mk(B, 1, { t: 'edit', x: target, text: 'edición ajena' })), 'new') // firmada por B pero el mensaje es de A
  assert.equal(s.add(mk(B, 2, { t: 'react', x: target, e: '👍', on: true })), 'new')
  assert.equal(s.add(mk(A, 1, { t: 'msg', ch: 'general', text: 'original' })), 'new')
  const m = s.history('general')[0]
  assert.equal(m.text, 'editado', 'solo cuenta la edición del autor')
  assert.deepEqual(m.reactions, [{ e: '👍', users: [hb] }])
  assert.equal(s.add(mk(A, 3, { t: 'react', x: target, e: 'con espacio', on: true })), 'bad', 'emoji inválido')
  assert.equal(s.add(mk(A, 3, { t: 'edit', x: target, text: '   ' })), 'bad', 'edición vacía')
  assert.equal(s.add(mk(A, 3, { t: 'msg', ch: 'general', text: 'x', re: 'no-es-un-id' })), 'bad', 'respuesta con id inválido')
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

// ───────────── Red: nodos en caché, nodo propio, STUN ─────────────
const dgram = require('dgram')
const { startOwnNode } = require('../scripts/own-node')
const { loadNetwork } = require('../src/core/network')

function loopbackNode(dir, key, extra = {}) {
  const n = new ChatNode({ dir, groupKey: key, dhtOpts: { host: '127.0.0.1' }, ...extra })
  n.testDir = dir
  nodes.push(n)
  return n
}

test('los nodos de la DHT se guardan y permiten arrancar sin nodos de arranque', async () => {
  const K = newKey()
  const dirX = tmp()
  const x = loopbackNode(dirX, K, { bootstrap: testnet.bootstrap })
  await x.start()
  await waitFor(() => x.ready, 15000, 'X listo')
  await x.stop()
  const cached = JSON.parse(fs.readFileSync(path.join(dirX, 'dht-nodes.json'), 'utf8'))
  assert.ok(cached.length >= 1, 'se guardaron nodos')

  const z = loopbackNode(tmp(), K, { bootstrap: testnet.bootstrap })
  await z.start()
  // Y no tiene NINGÚN nodo de arranque: solo la caché de X.
  const y = loopbackNode(dirX, K, { bootstrap: [] })
  await y.start()
  await waitFor(() => y.peers.has(z.id) && z.peers.has(y.id), 20000, 'Y encuentra a Z solo con la caché')

  // Control: sin caché y sin nodos de arranque, nadie puede encontrar a nadie.
  const w = loopbackNode(tmp(), K, { bootstrap: [] })
  await w.start()
  await new Promise((r) => setTimeout(r, 3000))
  assert.equal(w.peers.size, 0, 'sin caché no hay descubrimiento')
})

test('nodo propio (DHT + STUN): los amigos se encuentran sin ningún servicio público', async () => {
  const own = await startOwnNode({ host: '127.0.0.1', dhtPort: 0 + 41000 + Math.floor(Math.random() * 2000), stunPort: 43000 + Math.floor(Math.random() * 2000), bind: '127.0.0.1' })
  try {
    const K = newKey()
    const boot = [`127.0.0.1:${own.dht.address().port}`]
    const a = loopbackNode(tmp(), K, { bootstrap: boot })
    const b = loopbackNode(tmp(), K, { bootstrap: boot })
    await a.start(); await b.start()
    a.send('general', 'por mi propio nodo')
    await waitFor(() => a.peers.has(b.id) && texts(b).includes('por mi propio nodo'), 20000, 'A y B vía nodo propio')

    // STUN: una Binding Request devuelve la dirección de quien pregunta (XOR-MAPPED-ADDRESS).
    const client = dgram.createSocket('udp4')
    await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve))
    const req = Buffer.alloc(20)
    req.writeUInt16BE(0x0001, 0); req.writeUInt32BE(0x2112a442, 4); crypto.randomBytes(12).copy(req, 8)
    const reply = await new Promise((resolve, reject) => {
      client.once('message', resolve)
      setTimeout(() => reject(new Error('STUN sin respuesta')), 3000)
      client.send(req, own.stun.address().port, '127.0.0.1')
    })
    assert.equal(reply.readUInt16BE(0), 0x0101)
    assert.ok(reply.subarray(8, 20).equals(req.subarray(8, 20)), 'mismo transaction id')
    const port = reply.readUInt16BE(26) ^ 0x2112
    const ip = [0, 1, 2, 3].map((i) => reply[28 + i] ^ [0x21, 0x12, 0xa4, 0x42][i]).join('.')
    assert.equal(ip, '127.0.0.1')
    assert.equal(port, client.address().port)
    client.close()
  } finally { await own.close() }
})

test('network.json sustituye los servicios por defecto y se ignora si es inválido', () => {
  const d = tmp()
  assert.equal(loadNetwork({ userDataDir: d }).bootstrap, undefined)
  fs.writeFileSync(path.join(d, 'network.json'), JSON.stringify({ bootstrap: ['203.0.113.7:49737', 'basura'], stun: ['203.0.113.7:3478'] }))
  const n = loadNetwork({ userDataDir: d })
  assert.deepEqual(n.bootstrap, ['203.0.113.7:49737'])
  assert.deepEqual(n.iceServers, [{ urls: ['stun:203.0.113.7:3478'] }])
  fs.writeFileSync(path.join(d, 'network.json'), '{ no es json')
  assert.equal(loadNetwork({ userDataDir: d }).bootstrap, undefined)
})

test('código de sala: formato legible, parseo tolerante y huella estable', () => {
  const key = generateKey()
  assert.match(key, /^[0-9a-f]{64}$/)
  const code = formatCode(key)
  assert.equal(code.split('-').length, 8)
  assert.equal(parseCode(code), key)
  assert.equal(parseCode('  ' + code.toUpperCase().replace(/-/g, ' ') + '\n'), key, 'mayúsculas, espacios y saltos de línea')
  assert.equal(parseCode(code.slice(0, -2)), null, 'incompleto')
  assert.equal(parseCode('esto no es un código'), null)
  assert.equal(fingerprint(key), fingerprint(key))
  assert.notEqual(fingerprint(key), fingerprint(generateKey()))
  assert.match(fingerprint(key), /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/)
})

test('comprobación de NAT: cono, simétrico y UDP bloqueado', async () => {
  const { checkNat } = require('../src/core/natcheck')
  const { startStun } = require('../scripts/own-node')
  const rnd = () => 44000 + Math.floor(Math.random() * 4000)
  // dos STUN reales en local: ven el mismo puerto => "cono"
  const [p1, p2] = [rnd(), rnd() + 4001]
  const s1 = startStun({ port: p1, host: '127.0.0.1' })
  const s2 = startStun({ port: p2, host: '127.0.0.1' })
  await Promise.all([s1, s2].map((s) => new Promise((r) => s.once('listening', r))))
  const eps = [{ host: '127.0.0.1', port: p1 }, { host: '127.0.0.1', port: p2 }]
  assert.equal((await checkNat({ endpoints: eps, timeout: 1500 })).type, 'cone')
  s1.close(); s2.close()

  // servidores "tramposos" que dicen un puerto distinto cada uno => "simétrico"
  const fake = (offset) => {
    const sock = dgram.createSocket('udp4')
    sock.on('message', (msg, rinfo) => {
      const attr = Buffer.alloc(12)
      attr.writeUInt16BE(0x0020, 0); attr.writeUInt16BE(8, 2); attr[5] = 1
      attr.writeUInt16BE((rinfo.port + offset) ^ 0x2112, 6)
      '127.0.0.1'.split('.').forEach((o, i) => { attr[8 + i] = Number(o) ^ [0x21, 0x12, 0xa4, 0x42][i] })
      const head = Buffer.alloc(20); head.writeUInt16BE(0x0101, 0); head.writeUInt16BE(12, 2); head.writeUInt32BE(0x2112a442, 4); msg.copy(head, 8, 8, 20)
      sock.send(Buffer.concat([head, attr]), rinfo.port, rinfo.address)
    })
    return new Promise((r) => sock.bind(0, '127.0.0.1', () => r(sock)))
  }
  const [f1, f2] = [await fake(1), await fake(2)]
  const fe = [f1, f2].map((f) => ({ host: '127.0.0.1', port: f.address().port }))
  assert.equal((await checkNat({ endpoints: fe, timeout: 1500 })).type, 'symmetric')
  f1.close(); f2.close()

  // nadie responde => bloqueado
  assert.equal((await checkNat({ endpoints: [{ host: '127.0.0.1', port: 9 }], timeout: 600 })).type, 'blocked')
})

test('network.json admite servidores TURN y descarta los inválidos', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'network.json'), JSON.stringify({ turn: [
    { urls: 'turn:203.0.113.7:3478', username: 'u', credential: 'c' },
    { urls: 'http://malo', username: 'u', credential: 'c' },
    { urls: 'turn:x:3478' }
  ] }))
  const n = loadNetwork({ userDataDir: d })
  const turn = n.iceServers.filter((s) => s.username)
  assert.deepEqual(turn, [{ urls: 'turn:203.0.113.7:3478', username: 'u', credential: 'c' }])
  assert.ok(n.iceServers.some((s) => !s.username), 'los STUN por defecto se mantienen')
})

test('códec de vídeo: H.264 solo si hay codificador por hardware', async () => {
  const { codecOrder } = await import('../src/renderer/codecs.js')
  assert.deepEqual(codecOrder(['video/VP9', 'video/VP8'], false), ['video/VP9', 'video/VP8'])
  assert.deepEqual(codecOrder(['video/VP9', 'video/VP8'], true), ['video/H264', 'video/VP9', 'video/VP8'])
  assert.deepEqual(codecOrder(['video/VP8'], true), ['video/H264', 'video/VP8'])
})
