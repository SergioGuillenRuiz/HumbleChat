'use strict'
// Varias salas: registro (rooms.js), gestor de salas a la vez (roomhub.js) y aislamiento real del historial entre salas.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('node:events')
const createTestnet = require('hyperdht/testnet')
const { RoomStore } = require('../src/main/rooms')
const { RoomHub } = require('../src/main/roomhub')
const { ChatNode } = require('../src/core/node')
const { fingerprint } = require('../src/core/groupkey')

const key = () => crypto.randomBytes(32).toString('hex')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-rooms-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15000, what = 'condición') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(40) }
  throw new Error('timeout esperando: ' + what)
}

// ───────────── RoomStore ─────────────
test('la primera sala nueva usa su carpeta propia; las demás, otra; nombres y persistencia', () => {
  const d = tmp()
  const s = new RoomStore(d)
  assert.equal(s.active, null)
  const k1 = key(); const k2 = key()
  const a = s.add(k1)
  const b = s.add(k2, { name: '  Los   del   fútbol  ' })
  assert.equal(a.name, 'HumbleChat')
  assert.equal(b.name, 'Los del fútbol', 'espacios normalizados')
  assert.notEqual(s.dirOf(a), s.dirOf(b))
  assert.equal(s.dirOf(a), path.join(d, 'rooms', fingerprint(k1)))
  assert.equal(s.active.id, a.id, 'la primera queda activa')
  assert.equal(s.add(k1).id, a.id, 'la misma llave no se duplica')
  assert.equal(s.list().length, 2)
  s.setActive(b.id)
  const again = new RoomStore(d) // lo guardado sobrevive
  assert.deepEqual(again.list().map((r) => [r.id, r.name, r.dir]), s.list().map((r) => [r.id, r.name, r.dir]))
  assert.equal(again.active.id, b.id)
  // Permisos POSIX (0600): Windows no los tiene; allí el archivo queda protegido por la carpeta de perfil del usuario
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(d, 'rooms.json')).mode & 0o777) & 0o077, 0, 'rooms.json (lleva las llaves) solo para el usuario')
})

test('la sala de antes de las salas múltiples conserva su historial donde estaba, sin moverlo', () => {
  const d = tmp()
  fs.mkdirSync(path.join(d, 'data', 'log'), { recursive: true })
  fs.writeFileSync(path.join(d, 'data', 'log', 'events.jsonl'), '{"x":1}\n')
  fs.writeFileSync(path.join(d, 'data', 'identity.json'), '{}')
  const s = new RoomStore(d)
  const legacy = s.add(key(), { adoptLegacy: true })
  assert.equal(legacy.dir, 'data')
  assert.equal(s.dirOf(legacy), path.join(d, 'data'))
  assert.equal(fs.readFileSync(path.join(d, 'data', 'log', 'events.jsonl'), 'utf8'), '{"x":1}\n', 'intacto')
  const other = s.add(key())
  assert.notEqual(other.dir, 'data', 'una sala nueva no hereda el historial de la anterior')
  assert.equal(s.identityDir, path.join(d, 'data'))
  // solo la primera adopta lo antiguo
  const s2 = new RoomStore(tmp())
  s2.add(key())
  assert.notEqual(s2.add(key(), { adoptLegacy: true }).dir, 'data')
})

test('salir de una sala: con o sin borrar su historial, y nunca la identidad', () => {
  const d = tmp()
  fs.mkdirSync(path.join(d, 'data', 'log'), { recursive: true })
  fs.mkdirSync(path.join(d, 'data', 'blobs'), { recursive: true })
  fs.writeFileSync(path.join(d, 'data', 'identity.json'), '{"seed":"x"}')
  const s = new RoomStore(d)
  const legacy = s.add(key(), { adoptLegacy: true })
  const nueva = s.add(key())
  fs.mkdirSync(s.dirOf(nueva), { recursive: true })
  fs.writeFileSync(path.join(s.dirOf(nueva), 'mensaje'), 'hola')
  s.remove(nueva.id) // sin borrar datos: la carpeta se queda
  assert.ok(fs.existsSync(path.join(s.dirOf(nueva), 'mensaje')))
  s.remove(legacy.id, { deleteData: true })
  assert.ok(!fs.existsSync(path.join(d, 'data', 'log')) && !fs.existsSync(path.join(d, 'data', 'blobs')), 'se borra lo de la sala')
  assert.ok(fs.existsSync(path.join(d, 'data', 'identity.json')), 'la identidad se conserva')
  assert.equal(s.list().length, 0)
  assert.equal(s.active, null)
})

test('renombrar valida; un rooms.json estropeado no se pisa y no tumba el arranque', () => {
  const d = tmp()
  const s = new RoomStore(d)
  const r = s.add(key())
  assert.throws(() => s.rename(r.id, '   '), /vacío/)
  assert.throws(() => s.setActive('nada'), /no existe/)
  assert.equal(s.rename(r.id, 'x'.repeat(100)).length, 32)
  fs.writeFileSync(path.join(d, 'rooms.json'), '{esto no es json')
  const broken = new RoomStore(d)
  assert.equal(broken.list().length, 0)
  assert.ok(fs.existsSync(path.join(d, 'rooms.json.corrupto')), 'copia para recuperar las llaves a mano')
})

test('con la sala fijada por el entorno hay una sola, sin tocar el disco ni dejar cambiarla', () => {
  const d = tmp()
  const k = key()
  const s = new RoomStore(d, { fixedKey: k })
  assert.equal(s.locked, true)
  assert.equal(s.list().length, 1)
  assert.equal(s.active.key, k)
  assert.equal(s.active.dir, 'data')
  assert.throws(() => s.add(key()), /fijada/)
  assert.throws(() => s.remove(s.active.id), /fijada/)
  assert.ok(!fs.existsSync(path.join(d, 'rooms.json')))
})

// ───────────── RoomHub (con nodos simulados) ─────────────
function fakeNode(room) {
  const n = new EventEmitter()
  Object.assign(n, { id: 'yo-' + room.id, started: false, stopped: false, voice: undefined, peers: new Map() })
  n.start = async () => { n.started = true }
  n.stop = async () => { n.stopped = true }
  n.setVoice = (v) => { n.voice = v }
  n.openDm = (ev) => (ev.to === n.id ? ev : null)
  return n
}
function hubOf(store, over = {}) {
  const log = { changes: 0, activations: [] }
  const nodes = new Map()
  const hub = new RoomHub({
    store,
    createNode: (room) => { const n = fakeNode(room); nodes.set(room.id, n); return n },
    onChange: () => { log.changes++ },
    onActivate: (e) => { log.activations.push(e?.room.id ?? null) },
    ...over
  })
  return { hub, log, nodes }
}

test('arranca todas las salas a la vez y deja activa la que estaba', async () => {
  const s = new RoomStore(tmp())
  const a = s.add(key()); const b = s.add(key()); s.setActive(b.id)
  const { hub, nodes, log } = hubOf(s)
  await hub.startAll()
  assert.ok([...nodes.values()].every((n) => n.started), 'las dos conectadas')
  assert.equal(hub.room.id, b.id)
  assert.equal(hub.node, nodes.get(b.id))
  assert.deepEqual(log.activations, [b.id])
  assert.deepEqual(hub.list().map((r) => [r.id, r.active]), [[a.id, false], [b.id, true]])
})

test('en una sala de segundo plano solo se cuentan mensajes y menciones, y al entrar se limpian', async () => {
  const s = new RoomStore(tmp())
  const a = s.add(key()); const b = s.add(key())
  const { hub, nodes, log } = hubOf(s)
  await hub.startAll() // activa: a
  const nb = nodes.get(b.id)
  nb.emit('event', { t: 'msg', a: 'otro', text: 'hola' })
  nb.emit('event', { t: 'msg', a: 'otro', text: `ey <@${nb.id}>` })
  nb.emit('event', { t: 'msg', a: nb.id, text: 'mío' }) // lo propio no cuenta
  nb.emit('event', { t: 'dm', a: 'otro', to: 'alguien-mas' }) // un directo ajeno replicado no cuenta
  nb.emit('event', { t: 'dm', a: 'otro', to: nb.id }) // uno para ti, sí (y avisa)
  nb.emit('event', { t: 'react', a: 'otro' }) // lo que no es mensaje no cuenta
  assert.deepEqual(hub.list().find((r) => r.id === b.id), { id: b.id, name: b.name, fingerprint: fingerprint(b.key), active: false, unread: 3, mentions: 2, peers: 0 })
  nodes.get(a.id).emit('event', { t: 'msg', a: 'otro', text: 'en la activa' })
  assert.equal(hub.list().find((r) => r.id === a.id).unread, 0, 'la activa no cuenta: ya la ves')
  const before = log.changes
  hub.switchTo(b.id)
  assert.equal(hub.list().find((r) => r.id === b.id).unread, 0)
  assert.ok(log.changes > before)
  assert.equal(s.active.id, b.id, 'la sala activa se recuerda')
})

test('al cambiar de sala la llamada se cuelga en la anterior', async () => {
  const s = new RoomStore(tmp())
  const a = s.add(key()); const b = s.add(key())
  const { hub, nodes } = hubOf(s)
  await hub.startAll()
  nodes.get(a.id).setVoice({ ch: 'voz-general' })
  hub.switchTo(b.id)
  assert.equal(nodes.get(a.id).voice, null)
  assert.throws(() => hub.switchTo('no-existe'), /no existe/)
})

test('añadir una sala la arranca y la activa; repetir la llave solo te lleva a ella; si no arranca no se queda', async () => {
  const s = new RoomStore(tmp())
  const a = s.add(key())
  const { hub, nodes } = hubOf(s)
  await hub.startAll()
  const k = key()
  const e = await hub.add(k, { name: 'Amigos' })
  assert.equal(hub.room.name, 'Amigos')
  assert.ok(nodes.get(e.room.id).started)
  hub.switchTo(a.id)
  await hub.add(k)
  assert.equal(hub.room.id, e.room.id, 'ya la tenías: solo cambia')
  assert.equal(hub.list().length, 2)
  const bad = hubOf(new RoomStore(tmp()), { createNode: () => Object.assign(new EventEmitter(), { id: 'x', start: async () => { throw new Error('no arranca') }, stop: async () => {} }) })
  await assert.rejects(bad.hub.add(key()), /no arranca/)
  assert.equal(bad.hub.store.list().length, 0)
})

test('salir de la sala activa pasa a otra; salir de la última deja la aplicación sin salas', async () => {
  const s = new RoomStore(tmp())
  const a = s.add(key()); const b = s.add(key())
  const { hub, nodes, log } = hubOf(s)
  await hub.startAll()
  assert.equal(await hub.leave(a.id), b.id)
  assert.ok(nodes.get(a.id).stopped, 'su red se para')
  assert.equal(hub.room.id, b.id)
  assert.equal(s.list().length, 1)
  assert.equal(await hub.leave(b.id), null)
  assert.equal(hub.node, null)
  assert.equal(log.activations.at(-1), null)
})

// ───────────── Aislamiento real entre salas ─────────────
test('lo escrito en una sala no existe en otra ni se sincroniza con ella, aunque seas la misma persona', async () => {
  const testnet = await createTestnet(3)
  const nodes = []
  try {
    const home = tmp()
    const identityDir = path.join(home, 'data')
    const kA = key(); const kB = key()
    const mk = async (dir, groupKey, idDir) => {
      const n = new ChatNode({ dir, groupKey, dht: testnet.createNode(), identityDir: idDir })
      await n.start(); nodes.push(n); return n
    }
    // la misma persona (misma identidad) en dos salas, cada una con su carpeta
    const yoA = await mk(path.join(home, 'rooms', 'A'), kA, identityDir)
    const yoB = await mk(path.join(home, 'rooms', 'B'), kB, identityDir)
    assert.equal(yoA.id, yoB.id, 'mismo ID en todas las salas')
    // amigos: uno en cada sala
    const amigoA = await mk(tmp(), kA, null)
    const amigoB = await mk(tmp(), kB, null)
    await until(() => yoA.peers.has(amigoA.id) && yoB.peers.has(amigoB.id), 20000, 'cada uno ve a su amigo')
    assert.ok(!yoA.peers.has(amigoB.id) && !yoB.peers.has(amigoA.id), 'las salas no se cruzan')

    yoA.send('general', 'secreto de la sala A')
    amigoB.send('general', 'cosas de la sala B')
    await until(() => amigoA.history('general').some((m) => m.text === 'secreto de la sala A'), 15000, 'llega a su sala')
    await until(() => yoB.history('general').some((m) => m.text === 'cosas de la sala B'), 15000, 'llega a la otra')
    await sleep(800)
    const textos = (n) => n.history('general').map((m) => m.text)
    assert.ok(!textos(yoB).includes('secreto de la sala A'), 'lo de A no aparece en B')
    assert.ok(!textos(amigoB).includes('secreto de la sala A'), 'ni llega a los amigos de B')
    assert.ok(!textos(yoA).includes('cosas de la sala B'), 'lo de B no aparece en A')
    // y en disco: cada sala en su carpeta
    const logOf = (dir) => fs.readFileSync(path.join(dir, 'log', 'events.jsonl'), 'utf8')
    assert.ok(logOf(path.join(home, 'rooms', 'A')).includes('secreto de la sala A'))
    assert.ok(!logOf(path.join(home, 'rooms', 'B')).includes('secreto de la sala A'))
  } finally {
    for (const n of nodes) await n.stop().catch(() => {})
    await testnet.destroy()
  }
})

test('tu nombre y tu avatar te siguen a una sala nueva (y al actualizar desde antes de las salas múltiples)', async () => {
  const testnet = await createTestnet(3)
  const nodes = []
  try {
    const home = tmp()
    const identityDir = path.join(home, 'data')
    const mk = async (dir) => { const n = new ChatNode({ dir, groupKey: key(), dht: testnet.createNode(), identityDir }); await n.start(); nodes.push(n); return n }
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(300)])
    const a = await mk(path.join(home, 'rooms', 'A'))
    a.setName('Marta')
    const hash = a.setAvatar(png)
    assert.equal(a.store.names.get(a.id).av, hash)
    // una sala nueva con la misma identidad: nace con el nombre y el avatar ya puestos
    const b = await mk(path.join(home, 'rooms', 'B'))
    const mine = b.store.names.get(b.id)
    assert.equal(mine.name, 'Marta')
    assert.equal(mine.av, hash)
    assert.ok(fs.readFileSync(b.blobs.path(hash)).equals(png), 'el adjunto del avatar está también en la sala nueva')
    // quitar el avatar lo quita en las salas nuevas
    a.setAvatar(null)
    const c = await mk(path.join(home, 'rooms', 'C'))
    assert.ok(!c.store.names.get(c.id).av, 'sin avatar en las salas nuevas')

    // instalación de antes: el avatar solo estaba como adjunto de la sala (sin avatar.bin)
    const old = tmp()
    const oldId = path.join(old, 'data')
    const first = new ChatNode({ dir: oldId, groupKey: key(), dht: testnet.createNode() })
    await first.start(); nodes.push(first)
    const h2 = first.setAvatar(png)
    fs.rmSync(path.join(oldId, 'avatar.bin')) // como si nunca se hubiera guardado
    await first.stop()
    const again = new ChatNode({ dir: oldId, groupKey: key(), dht: testnet.createNode() })
    await again.start(); nodes.push(again)
    assert.ok(fs.existsSync(path.join(oldId, 'avatar.bin')), 'se recupera del adjunto de la sala')
    const other = new ChatNode({ dir: path.join(old, 'rooms', 'X'), identityDir: oldId, groupKey: key(), dht: testnet.createNode() })
    await other.start(); nodes.push(other)
    assert.equal(other.store.names.get(other.id).av, h2, 'y llega a las salas nuevas')
  } finally {
    for (const n of nodes) await n.stop().catch(() => {})
    await testnet.destroy()
  }
})
