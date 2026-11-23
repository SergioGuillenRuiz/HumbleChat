'use strict'
// Canales dinámicos, fijados, mensajes directos cifrados, avatares, archivos, vistas previas y búsqueda.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const createTestnet = require('hyperdht/testnet')
const DHT = require('hyperdht')
const { ChatNode } = require('../src/core/node')
const { Store, cleanEvent } = require('../src/core/store')
const { sign } = require('../src/core/sign')
const { LIMITS } = require('../src/core/constants')
const dmcrypto = require('../src/core/dmcrypto')
const { fetchPreview, parseMeta, extractUrl, isPrivateAddress } = require('../src/core/linkpreview')

const newKey = () => crypto.randomBytes(32).toString('hex')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hc-content-'))

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
  await n.start()
  nodes.push(n)
  return n
}
async function pair() {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  await waitFor(() => a.peers.has(b.id) && b.peers.has(a.id), 15000, 'conectados')
  return [a, b, K]
}
const idOf = (ev) => `${ev.a}:${ev.n}`

test.before(async () => { testnet = await createTestnet(3) })
test.after(async () => {
  for (const n of nodes) await n.stop().catch(() => {})
  await testnet.destroy()
})

test('canales: crear, renombrar y borrar se replica; el tipo no cambia; siempre queda uno de texto', async () => {
  const [a, b] = await pair()
  assert.deepEqual(a.store.channels().map((c) => c.id), ['general', 'fotos', 'voz-general', 'voz-juegos'])
  const id = a.createChannel('text', '  Memes Y Risas ')
  await waitFor(() => b.store.channel(id), 5000, 'B ve el canal nuevo')
  assert.equal(b.store.channel(id).name, 'memes-y-risas')
  assert.equal(b.store.channel(id).type, 'text')
  const vid = b.createChannel('voice', 'Sala  de   estudio')
  await waitFor(() => a.store.channel(vid), 5000, 'A ve el canal de voz')
  assert.equal(a.store.channel(vid).name, 'Sala de estudio')
  // se puede escribir en el canal nuevo y el historial lo recoge
  a.send(id, 'primero en el canal nuevo')
  await waitFor(() => b.history(id).length === 1, 5000, 'B recibe el mensaje')
  // renombrar (cualquiera) y un evento que intente cambiar el tipo se ignora
  b.renameChannel(id, 'Humor')
  await waitFor(() => a.store.channel(id).name === 'humor', 5000, 'A ve el renombrado')
  const forged = { a: a.id, n: a.store.nextN(a.id), ts: Date.now() + 5, t: 'chan', ch: id, k: 'voice', name: 'x', del: false }
  forged.sig = sign(a.identity.keyPair.secretKey, cleanEvent({ ...forged, sig: '0'.repeat(128) }))
  assert.equal(a.store.add(forged), 'new')
  assert.equal(a.store.channel(id).type, 'text', 'el tipo de un canal no cambia nunca')
  assert.equal(a.store.channel(id).name, 'humor')
  // borrar
  a.deleteChannel(id)
  await waitFor(() => !b.store.channel(id), 5000, 'B ve el borrado')
  assert.ok(!b.store.channels().some((c) => c.id === id))
  // predefinidos: se pueden borrar salvo el último de texto
  a.deleteChannel('fotos')
  assert.throws(() => a.deleteChannel('general'), /al menos un canal de texto/)
  assert.throws(() => a.createChannel('text', '!!!'), /no es válido/)
  // un nodo nuevo reconstruye la lista desde el historial
  const c = await spawn(a.groupKey)
  await waitFor(() => c.store.channel(vid) && !c.store.channel('fotos'), 15000, 'C sincroniza los canales')
  assert.deepEqual(c.store.channels().map((x) => x.id), a.store.channels().map((x) => x.id))
})

test('fijados: se replican, se pueden quitar y no salen si el mensaje se borra', async () => {
  const [a, b] = await pair()
  const m1 = a.send('general', 'uno')
  const m2 = a.send('general', 'dos')
  await waitFor(() => b.history('general').length === 2, 5000, 'B recibe')
  assert.ok(b.pin(idOf(m1), true))
  assert.ok(b.pin(idOf(m2), true))
  await waitFor(() => a.store.pinned('general').length === 2, 5000, 'A ve los fijados')
  assert.deepEqual(a.store.pinned('general').map((m) => m.text), ['dos', 'uno'], 'el último fijado, primero')
  assert.equal(a.history('general').find((m) => m.text === 'uno').pinned, true)
  a.pin(idOf(m1), false)
  await waitFor(() => b.store.pinned('general').length === 1, 5000, 'B ve el desfijado')
  a.remove(idOf(m2))
  await waitFor(() => b.store.pinned('general').length === 0, 5000, 'borrar quita el fijado')
  assert.equal(a.pin('0'.repeat(64) + ':1', true), null)
})

test('mensajes directos: cifrados de extremo a extremo; el tercero los replica pero no los lee; solo borra el autor', async () => {
  const K = newKey()
  const a = await spawn(K)
  const b = await spawn(K)
  const c = await spawn(K)
  await waitFor(() => [a, b, c].every((n) => n.peers.size === 2), 20000, 'malla de 3')
  const secret = 'contraseña del wifi: ' + crypto.randomBytes(4).toString('hex')
  const ev = a.dm(b.id, secret)
  await waitFor(() => b.dmHistory(a.id).length === 1, 5000, 'B recibe el directo')
  assert.equal(b.dmHistory(a.id)[0].text, secret)
  assert.equal(b.dmHistory(a.id)[0].ch, 'dm:' + a.id)
  assert.equal(a.dmHistory(b.id)[0].text, secret, 'el emisor también lo lee')
  await waitFor(() => c.store.events.has(idOf(ev)), 5000, 'C lo replica')
  assert.equal(c.openDm(c.store.events.get(idOf(ev))), null, 'C no puede abrirlo')
  assert.deepEqual(c.dmHistory(a.id), [])
  assert.ok(!JSON.stringify(c.store.events.get(idOf(ev))).includes(secret), 'en claro no viaja ni se guarda')
  assert.equal(dmcrypto.open(c.identity.keyPair.secretKey, a.id, ev.box), null)
  // conversación en ambos sentidos y orden
  b.dm(a.id, 'respuesta')
  await waitFor(() => a.dmHistory(b.id).length === 2, 5000, 'A recibe la respuesta')
  assert.deepEqual(a.dmHistory(b.id).map((m) => m.text), [secret, 'respuesta'])
  assert.deepEqual([...a.store.dmPeers(a.id).keys()], [b.id])
  assert.deepEqual([...c.store.dmPeers(c.id).keys()], [], 'C no tiene conversaciones')
  // el destinatario no puede borrar lo del emisor; el emisor sí
  assert.equal(b.remove(idOf(ev)), null)
  a.remove(idOf(ev))
  await waitFor(() => b.dmHistory(a.id).length === 1, 5000, 'B ve el borrado')
  assert.deepEqual(b.dmHistory(a.id).map((m) => m.text), ['respuesta'])
  // un mensaje manipulado o dirigido a uno mismo se rechaza
  assert.throws(() => a.dm(a.id, 'a mí mismo'))
  const tampered = { ...b.store.events.get(idOf(b.store.dmThread(a.id, b.id)[0])), box: Buffer.alloc(60, 1).toString('base64') }
  const st = new Store(tmp()); st.open()
  assert.equal(st.add(tampered), 'bad', 'la firma no cuadra si se toca el contenido')
})

test('avatares: se replican como adjunto, el nombre los conserva y se pueden quitar', async () => {
  const [a, b] = await pair()
  const img = crypto.randomBytes(20 * 1024)
  const h = a.setAvatar(img)
  await waitFor(() => b.blobs.has(h), 10000, 'B descarga el avatar')
  await waitFor(() => b.members().find((m) => m.id === a.id)?.av === h, 5000, 'B ve el avatar en la lista')
  a.setName('Ana Nueva')
  await waitFor(() => b.members().find((m) => m.id === a.id)?.name === 'Ana Nueva', 5000, 'nombre')
  assert.equal(b.members().find((m) => m.id === a.id).av, h, 'cambiar el nombre no quita el avatar')
  assert.throws(() => a.setAvatar(Buffer.alloc(LIMITS.avatar + 1)), /pesa demasiado/)
  a.setAvatar(null)
  await waitFor(() => !b.members().find((m) => m.id === a.id).av, 5000, 'avatar quitado')
  // un nodo tardío también lo recibe si sigue puesto
  const h2 = b.setAvatar(crypto.randomBytes(5000))
  const c = await spawn(a.groupKey)
  await waitFor(() => c.blobs.has(h2), 15000, 'C descarga el avatar de B')
})

test('archivos: cualquier tipo, las imágenes pequeñas se bajan solas y el resto cuando se piden', async () => {
  const [a, b] = await pair()
  const file = crypto.randomBytes(3 * 1024 * 1024)
  const att = a.addBlob(file, { name: 'informe\u0007.pdf', mime: 'application/pdf' })
  assert.equal(att.name, 'informe.pdf', 'sin caracteres de control')
  const img = a.addBlob(crypto.randomBytes(100 * 1024), { name: 'f.png', mime: 'image/png', w: 5, ht: 5 })
  a.send('general', 'adjuntos', [att, img])
  await waitFor(() => b.blobs.has(img.h), 10000, 'la imagen llega sola')
  await new Promise((r) => setTimeout(r, 1500))
  assert.ok(!b.blobs.has(att.h), 'el PDF no se descarga hasta que alguien lo pide')
  assert.equal(b.blobProgress(att.h).done, false)
  const p = await b.whenBlob(att.h, 20000)
  assert.ok(fs.readFileSync(p).equals(file))
  assert.equal(b.blobProgress(att.h).done, true)
  // un tercero que llega tarde no baja el archivo, pero sí la imagen
  const c = await spawn(a.groupKey)
  await waitFor(() => c.blobs.has(img.h), 15000, 'C baja la imagen')
  assert.ok(!c.blobs.has(att.h))
  // límites de validación
  const base = { a: 'a'.repeat(64), n: 1, ts: 1, t: 'msg', ch: 'general', text: 'x', sig: 'b'.repeat(128) }
  const ok = { h: 'c'.repeat(64), name: 'x.zip', mime: 'application/zip', size: LIMITS.blob }
  assert.ok(cleanEvent({ ...base, att: [ok] }))
  assert.equal(cleanEvent({ ...base, att: [{ ...ok, size: LIMITS.blob + 1 }] }), null)
  assert.equal(cleanEvent({ ...base, att: [{ ...ok, mime: 'esto no es un mime' }] }), null)
})

test('vistas previas: solo las añade el autor del mensaje, y solo con http(s)', async () => {
  const [a, b] = await pair()
  const m = a.send('general', 'mira https://ejemplo.com/x')
  await waitFor(() => b.history('general').length === 1, 5000, 'B recibe')
  assert.equal(b.embed(idOf(m), { url: 'https://ejemplo.com/x', title: 't' }), null, 'B no puede añadir a un mensaje de A')
  a.embed(idOf(m), { url: 'https://ejemplo.com/x', title: 'Ejemplo', desc: 'Una página', site: 'ejemplo.com' })
  await waitFor(() => b.history('general')[0].emb, 5000, 'B ve la vista previa')
  assert.deepEqual(b.history('general')[0].emb, { url: 'https://ejemplo.com/x', title: 'Ejemplo', desc: 'Una página', site: 'ejemplo.com' })
  assert.throws(() => a.embed(idOf(m), { url: 'javascript:alert(1)', title: 'x' }), /inválido/i)
  // si el mensaje se edita y ya no contiene el enlace, la vista previa deja de mostrarse
  a.edit(idOf(m), 'ya no hay enlace')
  await waitFor(() => b.history('general')[0].edited, 5000, 'B ve la edición')
  assert.equal(b.history('general')[0].emb, undefined)
  a.edit(idOf(m), 'otra vez https://ejemplo.com/x')
  await waitFor(() => b.history('general')[0].emb, 5000, 'vuelve la vista previa')
  // un evento ajeno firmado por otro autor sobre mi mensaje se descarta al insertarlo
  const kp = DHT.keyPair()
  const evil = { a: kp.publicKey.toString('hex'), n: 1, ts: Date.now(), t: 'emb', x: idOf(m), url: 'https://malo.example/', title: 'phishing', desc: '', site: '' }
  evil.sig = sign(kp.secretKey, cleanEvent({ ...evil, sig: '0'.repeat(128) }))
  b.store.add(evil)
  assert.equal(b.history('general')[0].emb.title, 'Ejemplo')
})

test('búsqueda: sin mayúsculas ni acentos, usa el texto editado, ignora borrados y canales eliminados', async () => {
  const [a, b] = await pair()
  const m1 = a.send('general', 'Reunión mañana a las 10')
  a.send('general', 'compra pan')
  b.send('fotos', 'foto de la reunion del viernes')
  const m4 = a.send('general', 'texto original')
  await waitFor(() => b.history('general').length === 3, 5000, 'sincronizado')
  a.edit(idOf(m4), 'ahora dice PIÑATA')
  await waitFor(() => b.search('pinata').length === 1, 5000, 'edición buscable')
  assert.deepEqual(b.search('REUNION').map((m) => m.text), ['foto de la reunion del viernes', 'Reunión mañana a las 10'], 'lo más reciente primero')
  assert.deepEqual(b.search('reunion mañana').map((m) => m.text), ['Reunión mañana a las 10'], 'todas las palabras')
  assert.deepEqual(b.search('reunion', { ch: 'fotos' }).length, 1)
  assert.deepEqual(b.search('original'), [], 'el texto antiguo ya no existe')
  assert.deepEqual(b.search('   '), [])
  a.remove(idOf(m1))
  await waitFor(() => b.search('reunion').length === 1, 5000, 'borrado no sale')
  const c = a.createChannel('text', 'tmp')
  a.send(c, 'secreto del canal temporal')
  assert.equal(a.search('secreto').length, 1)
  a.deleteChannel(c)
  assert.equal(a.search('secreto').length, 0)
  // saltar a un mensaje: ventana alrededor
  for (let i = 0; i < 80; i++) a.send('general', 'relleno ' + i)
  await waitFor(() => b.history('general', { limit: 500 }).length >= 82, 10000, 'relleno sincronizado')
  const target = b.history('general', { limit: 500 }).find((m) => m.text === 'relleno 10')
  const w = b.store.around('general', idOf(target), { before: 5, after: 20 })
  assert.equal(w.msgs.length, 26)
  assert.equal(w.msgs[5].text, 'relleno 10')
  assert.equal(w.tail, false)
  assert.equal(b.store.around('general', idOf(b.history('general').pop()), { before: 2, after: 20 }).tail, true)
  assert.equal(b.store.around('general', '0'.repeat(64) + ':9'), null)
})

test('vistas previas de enlaces: lee Open Graph, bloquea direcciones privadas y respeta redirecciones y límites', async () => {
  assert.ok(isPrivateAddress('127.0.0.1') && isPrivateAddress('10.0.0.5') && isPrivateAddress('169.254.169.254') && isPrivateAddress('::1') && isPrivateAddress('::ffff:192.168.1.1'))
  assert.ok(!isPrivateAddress('8.8.8.8') && !isPrivateAddress('2606:4700::1111'))
  assert.equal(extractUrl('hola https://a.com/x?y=1, adiós'), 'https://a.com/x?y=1')
  assert.equal(extractUrl('nada'), null)
  assert.equal(extractUrl('ftp://a.com'), null)
  const page = parseMeta('<title>Mi &amp; página</title><meta property="og:description" content="Hola &quot;mundo&quot;"><meta property="og:site_name" content="Sitio">', 'https://www.x.com/p')
  assert.deepEqual(page, { url: 'https://www.x.com/p', title: 'Mi & página', desc: 'Hola "mundo"', site: 'Sitio' })
  assert.equal(parseMeta('<p>sin metadatos</p>', 'https://x.com'), null)

  const hits = []
  const srv = http.createServer((req, res) => {
    hits.push(req.url)
    if (req.url === '/og') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end('<head><title>Hola</title><meta property="og:description" content="Prueba"></head><body>' + 'x'.repeat(5e5)) }
    if (req.url === '/redir') { res.writeHead(302, { location: '/og' }); return res.end() }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end() }
    if (req.url === '/png') { res.setHeader('content-type', 'image/png'); return res.end('x') }
    res.statusCode = 404; res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    // por defecto el servidor local está prohibido: ni siquiera se conecta
    await assert.rejects(fetchPreview(base + '/og'), /no permitida/)
    assert.equal(hits.length, 0)
    await assert.rejects(fetchPreview('http://localhost:1/x', { lookup: (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) }), /no permitida/)
    // con permiso (solo pruebas) funciona, sigue redirecciones y limita el tamaño
    const r = await fetchPreview(base + '/redir', { allowPrivate: true })
    assert.equal(r.title, 'Hola')
    assert.equal(r.desc, 'Prueba')
    assert.equal(await fetchPreview(base + '/png', { allowPrivate: true }), null, 'no HTML')
    assert.equal(await fetchPreview(base + '/nada', { allowPrivate: true }), null, '404')
    assert.equal(await fetchPreview(base + '/loop', { allowPrivate: true }), null, 'bucle de redirecciones')
    // una redirección hacia una IP privada se bloquea aunque el primer salto estuviera permitido
    const meta = http.createServer((req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end() })
    await new Promise((r2) => meta.listen(0, '127.0.0.1', r2))
    await assert.rejects(fetchPreview(`http://127.0.0.1:${meta.address().port}/`, { allowPrivate: (ip) => ip === '127.0.0.1' }), /no permitida/)
    meta.close()
  } finally { srv.close() }
})
