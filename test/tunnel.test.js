'use strict'
// Túnel UDP por la conexión P2P: tramas de datagrama y proxy local (sin Electron).
const test = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')
const { encodeDatagram, encodeJSON, Decoder } = require('../src/core/frames')
const { UdpTunnels } = require('../src/main/udptunnel')

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

test('lo que WebRTC manda al túnel sale hacia el amigo, y lo que llega del amigo vuelve a WebRTC desde ese mismo puerto', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node)
  const port = await t.open('amigo')
  assert.equal(await t.open('amigo'), port, 'abrir otra vez reutiliza el socket')
  const rtc = dgram.createSocket('udp4') // hace de WebRTC
  await bind(rtc)
  const inbox = []
  rtc.on('message', (m, r) => inbox.push([m, r.port]))
  rtc.send(Buffer.from('hola'), port, '127.0.0.1')
  await until(() => node.sent.length === 1)
  assert.deepEqual(node.sent[0], ['amigo', Buffer.from('hola')])
  node.emit('datagram', 'amigo', Buffer.from('respuesta'))
  await until(() => inbox.length === 1)
  assert.equal(inbox[0][0].toString(), 'respuesta')
  assert.equal(inbox[0][1], port, 'WebRTC lo ve llegar del puerto que le dimos como candidato')
  assert.deepEqual(t.stats('amigo'), { tx: 1, rx: 1, drops: 0 })
  rtc.close(); t.closeAll()
})

test('lo que llega antes de saber a qué puerto entregar espera y se entrega después', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node)
  const port = await t.open('a')
  node.emit('datagram', 'a', Buffer.from('1'))
  node.emit('datagram', 'a', Buffer.from('2'))
  const rtc = dgram.createSocket('udp4'); await bind(rtc)
  const inbox = []
  rtc.on('message', (m) => inbox.push(m.toString()))
  rtc.send(Buffer.from('x'), port, '127.0.0.1')
  await until(() => inbox.length === 2)
  assert.deepEqual(inbox, ['1', '2'])
  rtc.close(); t.closeAll()
})

test('las comprobaciones STUN de otros puertos no desvían la entrega; el tráfico de datos sí la fija', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node)
  const port = await t.open('a')
  const [x, y] = [dgram.createSocket('udp4'), dgram.createSocket('udp4')]
  await bind(x); await bind(y)
  const inX = []; const inY = []
  x.on('message', (m) => inX.push(m.toString())); y.on('message', (m) => inY.push(m.toString()))
  x.send(Buffer.from([0, 1, 0, 0]), port, '127.0.0.1') // STUN desde x: fija x
  await until(() => node.sent.length === 1)
  y.send(Buffer.from([0, 1, 0, 1]), port, '127.0.0.1') // STUN desde y: no cambia
  await until(() => node.sent.length === 2)
  node.emit('datagram', 'a', Buffer.from('p1'))
  await until(() => inX.length === 1)
  y.send(Buffer.from([0x80, 1]), port, '127.0.0.1') // datos (RTP) desde y: ahora es y
  await until(() => node.sent.length === 3)
  node.emit('datagram', 'a', Buffer.from('p2'))
  await until(() => inY.length === 1)
  assert.deepEqual([inX, inY], [['p1'], ['p2']])
  x.close(); y.close(); t.closeAll()
})

test('si el enlace va saturado se descartan datagramas y se cuentan; cerrar libera el puerto y deja de entregar', async () => {
  const node = fakeNode()
  const t = new UdpTunnels(node)
  const port = await t.open('a')
  const rtc = dgram.createSocket('udp4'); await bind(rtc)
  const inbox = []
  rtc.on('message', (m) => inbox.push(m.toString()))
  node.accept = false
  rtc.send(Buffer.from('perdido'), port, '127.0.0.1')
  await until(() => t.stats('a').drops === 1)
  t.close('a')
  assert.equal(t.stats('a'), null)
  node.emit('datagram', 'a', Buffer.from('tarde'))
  await sleep(50)
  assert.deepEqual(inbox, [])
  node.emit('datagram', 'desconocido', Buffer.from('x')) // sin túnel: se ignora
  rtc.close(); t.closeAll()
})
