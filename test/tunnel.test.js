'use strict'
// Túnel UDP por la conexión P2P: tramas de datagrama y proxy local (sin Electron).
const test = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { encodeDatagram, encodeJSON, Decoder } = require('../src/core/frames')
const { UdpTunnels, localAddresses } = require('../src/main/udptunnel')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(5) } }

test('las tramas de datagrama se decodifican aunque lleguen troceadas y mezcladas con JSON', () => {
  const got = []
  const d = new Decoder((m) => got.push(['json', m]), () => got.push(['blob']), (e) => got.push(['err', e.message]), (b) => got.push(['udp', b.toString('hex')]))
  const bytes = Buffer.concat([encodeDatagram(Buffer.from('0102', 'hex')), encodeJSON({ a: 1 }), encodeDatagram(Buffer.alloc(1200, 7))])
  for (let i = 0; i < bytes.length; i += 7) d.push(bytes.subarray(i, i + 7))
  assert.deepEqual(got.map((g) => g[0]), ['udp', 'json', 'udp'])
  assert.equal(got[0][1], '0102')
  assert.equal(got[2][1].length, 2400)
})

test('sin receptor de datagramas, una trama de datagrama se ignora sin romper el resto', () => {
  const got = []
  const d = new Decoder((m) => got.push(m), () => {}, (e) => got.push(e))
  d.push(Buffer.concat([encodeDatagram(Buffer.from('aa', 'hex')), encodeJSON({ ok: true })]))
  assert.deepEqual(got, [{ ok: true }])
})

/** Un "nodo" simulado: guarda lo que se envía y permite inyectar lo que llega del amigo. */
function fakeNode() {
  const n = new EventEmitter()
  n.sent = []
  n.accept = true
  n.sendDatagram = (id, data) => { if (!n.accept) return false; n.sent.push([id, Buffer.from(data)]); return true }
  return n
}
const bind = (sock) => new Promise((r) => sock.bind(0, '127.0.0.1', r))
const LOOP = () => ['127.0.0.1']

test('localAddresses: IPs propias primero y el bucle local siempre al final', () => {
  const a = localAddresses()
  assert.equal(a.at(-1), '127.0.0.1')
  assert.ok(a.length <= 4)
  assert.ok(a.slice(0, -1).every((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x) && !x.startsWith('127.') && !x.startsWith('169.254.')))
})

test('lo que WebRTC manda al túnel sale hacia el amigo, y lo que llega del amigo vuelve a WebRTC desde ese mismo puerto', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node, { addresses: LOOP })
  const [cand] = await t.open('amigo')
  assert.equal(cand.address, '127.0.0.1')
  assert.deepEqual(await t.open('amigo'), [cand], 'abrir otra vez reutiliza los sockets')
  const rtc = dgram.createSocket('udp4') // hace de WebRTC
  await bind(rtc)
  const inbox = []
  rtc.on('message', (m, r) => inbox.push([m, r.port]))
  rtc.send(Buffer.from('hola'), cand.port, cand.address)
  await until(() => node.sent.length === 1)
  assert.deepEqual(node.sent[0], ['amigo', Buffer.from('hola')])
  node.emit('datagram', 'amigo', Buffer.from('respuesta'))
  await until(() => inbox.length === 1)
  assert.equal(inbox[0][0].toString(), 'respuesta')
  assert.equal(inbox[0][1], cand.port, 'WebRTC lo ve llegar del puerto que le dimos como candidato')
  assert.deepEqual(t.stats('amigo'), { tx: 1, rx: 1, drops: 0, addresses: 1 })
  rtc.close(); t.closeAll()
})

test('lo que llega antes de saber a qué puerto entregar espera y se entrega después', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node, { addresses: LOOP })
  const [cand] = await t.open('a')
  node.emit('datagram', 'a', Buffer.from('1'))
  node.emit('datagram', 'a', Buffer.from('2'))
  const rtc = dgram.createSocket('udp4'); await bind(rtc)
  const inbox = []
  rtc.on('message', (m) => inbox.push(m.toString()))
  rtc.send(Buffer.from('x'), cand.port, cand.address)
  await until(() => inbox.length === 2)
  assert.deepEqual(inbox, ['1', '2'])
  rtc.close(); t.closeAll()
})

test('varias direcciones: las comprobaciones STUN llegan por todas, y los datos solo por la del par elegido', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node, { addresses: () => ['127.0.0.1', '127.0.0.2'] })
  const cands = await t.open('a')
  assert.equal(cands.length, 2)
  assert.notEqual(cands[0].port, cands[1].port)
  const [x, y] = [dgram.createSocket('udp4'), dgram.createSocket('udp4')]
  await bind(x); await bind(y)
  const inX = []; const inY = []
  x.on('message', (m, r) => inX.push([m.toString('hex'), r.address]))
  y.on('message', (m, r) => inY.push([m.toString('hex'), r.address]))
  x.send(Buffer.from([0, 1, 0, 0]), cands[0].port, cands[0].address) // WebRTC sondea la primera dirección desde x
  y.send(Buffer.from([0, 1, 0, 1]), cands[1].port, cands[1].address) // y la segunda, desde otro de sus puertos
  await until(() => node.sent.length === 2)
  node.emit('datagram', 'a', Buffer.from([0, 1, 9, 9])) // STUN del amigo: se entrega por las dos direcciones
  await until(() => inX.length === 1 && inY.length === 1)
  assert.deepEqual([inX[0][1], inY[0][1]].sort(), ['127.0.0.1', '127.0.0.2'], 'cada uno lo ve llegar de la dirección que sondeó')
  x.send(Buffer.from([0x80, 1, 2]), cands[0].port, cands[0].address) // el par elegido es el de x (datos RTP)
  await until(() => node.sent.length === 3)
  node.emit('datagram', 'a', Buffer.from([0x80, 7]))
  await until(() => inX.length === 2)
  await sleep(60)
  assert.equal(inY.length, 1, 'los datos no se duplican por la otra dirección')
  x.close(); y.close(); t.closeAll()
})

test('las comprobaciones STUN de otros puertos no desvían la entrega; el tráfico de datos sí la fija', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node, { addresses: LOOP })
  const [cand] = await t.open('a')
  const [x, y] = [dgram.createSocket('udp4'), dgram.createSocket('udp4')]
  await bind(x); await bind(y)
  const inX = []; const inY = []
  x.on('message', (m) => inX.push(m.toString())); y.on('message', (m) => inY.push(m.toString()))
  x.send(Buffer.from([0, 1, 0, 0]), cand.port, cand.address) // STUN desde x: fija x
  await until(() => node.sent.length === 1)
  y.send(Buffer.from([0, 1, 0, 1]), cand.port, cand.address) // STUN desde y: no cambia
  await until(() => node.sent.length === 2)
  node.emit('datagram', 'a', Buffer.from('p1'))
  await until(() => inX.length === 1)
  y.send(Buffer.from([0x80, 1]), cand.port, cand.address) // datos (RTP) desde y: ahora es y
  await until(() => node.sent.length === 3)
  node.emit('datagram', 'a', Buffer.from('p2'))
  await until(() => inY.length === 1)
  assert.deepEqual([inX, inY], [['p1'], ['p2']])
  x.close(); y.close(); t.closeAll()
})

test('una dirección que no se puede usar no impide abrir las demás', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node, { addresses: () => ['203.0.113.77', '127.0.0.1'] }) // la primera no es de esta máquina
  const cands = await t.open('a')
  assert.deepEqual(cands.map((c) => c.address), ['127.0.0.1'])
  t.closeAll()
})

test('si el enlace va saturado se descartan datagramas y se cuentan; cerrar libera los puertos y deja de entregar', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node, { addresses: LOOP })
  const [cand] = await t.open('a')
  const rtc = dgram.createSocket('udp4'); await bind(rtc)
  const inbox = []
  rtc.on('message', (m) => inbox.push(m.toString()))
  node.accept = false
  rtc.send(Buffer.from('perdido'), cand.port, cand.address)
  await until(() => t.stats('a').drops === 1)
  t.close('a')
  assert.equal(t.stats('a'), null)
  node.emit('datagram', 'a', Buffer.from('tarde'))
  await sleep(50)
  assert.deepEqual(inbox, [])
  node.emit('datagram', 'desconocido', Buffer.from('x')) // sin túnel: se ignora
  rtc.close(); t.closeAll()
})
