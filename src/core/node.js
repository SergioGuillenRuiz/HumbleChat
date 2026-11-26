'use strict'
// ChatNode: toda la parte de red/estado, sin nada de Electron.
//
// Cómo se "hostea" sin configurar nada:
//   · Todas las instancias se anuncian y se buscan en la DHT pública de Hyperswarm bajo un tema
//     derivado de la llave del grupo. El primero que abre la app simplemente queda anunciado;
//     el siguiente lo encuentra, abre una conexión directa (con NAT hole-punching) y listo.
//   · Cada conexión se autentica con un HMAC de la llave de grupo sobre el hash del handshake
//     Noise: quien no tenga la llave no entra aunque encuentre el tema.
//   · El historial no vive en una máquina: cada nodo guarda el suyo y, al conectar, intercambian
//     lo que les falta. Si el primero se va, nadie lo nota; si vuelve, se pone al día.
const { EventEmitter } = require('events')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const { LIMITS, PROTOCOL } = require('./constants')
const { encodeJSON, encodeBlob, Decoder } = require('./frames')
const { loadIdentity } = require('./identity')
const { Store, cleanEvent, cleanChannelName, CHAN_ID } = require('./store')
const dmcrypto = require('./dmcrypto')
const { Blobs } = require('./blobs')
const { topicOf, proofOf } = require('./groupkey')
const { sign } = require('./sign')
const { Relay } = require('./relay')

const HEX64 = /^[0-9a-f]{64}$/

// Un canal de voz puede ser nuevo para nosotros (su evento aún no ha llegado): basta con que el id sea válido.
function cleanVoice(v) {
  if (!v || typeof v !== 'object' || typeof v.ch !== 'string' || !CHAN_ID.test(v.ch)) return null
  return { ch: v.ch, mute: !!v.mute, deaf: !!v.deaf, share: !!v.share, cam: !!v.cam }
}

function cleanVector(v) {
  if (!v || typeof v !== 'object') return {}
  const out = {}
  for (const [a, n] of Object.entries(v)) if (HEX64.test(a) && Number.isInteger(n) && n > 0) out[a] = n
  return out
}

/** Imágenes de tamaño razonable y avatares: se descargan solas. Lo demás, cuando alguien lo pide. */
const isAuto = (a) => /^image\//.test(a.mime || 'image/') && a.size <= LIMITS.autoBlob

class Peer {
  constructor(node, conn) {
    this.node = node
    this.conn = conn
    this.id = conn.remotePublicKey.toString('hex')
    this.ready = false
    this.closed = false
    this.name = null
    this.voice = null
    this.misses = new Map() // hash -> momento del último "no lo tengo"
    this.gapAsked = new Map() // autor -> n pedido
    this.decoder = new Decoder(
      (msg) => node._onMessage(this, msg),
      (h, off, total, data) => node._onBlobFrame(this, h, off, total, data),
      () => this.close()
    )
    conn.on('data', (d) => this.decoder.push(d))
    conn.on('error', () => {})
    conn.on('close', () => { this.closed = true; node._onPeerClose(this) })
    conn.setTimeout?.(12000) // keepalive cada 5 s: un proceso muerto se nota en ~12 s
  }

  send(obj) {
    if (this.closed || this.conn.destroyed) return
    this.conn.write(encodeJSON(obj))
  }

  write(buf) {
    if (this.closed || this.conn.destroyed) return Promise.resolve()
    if (this.conn.write(buf)) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => { this.conn.off('drain', done); this.conn.off('close', done); resolve() }
      this.conn.once('drain', done)
      this.conn.once('close', done)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.conn.destroy()
    this.node._onPeerClose(this)
  }
}

class ChatNode extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir        carpeta de datos (identidad, historial, adjuntos)
   * @param {string} o.groupKey   llave del grupo
   * @param {string[]} [o.bootstrap] nodos de arranque propios ("host:puerto"); por defecto los públicos
   * @param {object} [o.dht]      DHT ya creada (tests con red local)
   * @param {object} [o.dhtOpts]  opciones extra para la DHT (solo tests: host 127.0.0.1)
   * @param {object} [o.relay]    tiempos del relé de presencia y señales (solo tests)
   */
  constructor({ dir, groupKey, bootstrap = undefined, dht = undefined, dhtOpts = {}, relay = {} }) {
    super()
    this.dir = dir
    this.groupKey = groupKey
    this.bootstrap = bootstrap
    this.injectedDht = dht
    this.dhtOpts = dhtOpts
    this.peers = new Map() // id -> Peer (autenticados)
    this.all = new Set()
    this.voice = null
    this.wanted = new Map() // hash -> { size, peerId }
    this.waiters = new Map() // hash -> Set<Peer> esperando a que lo tengamos
    this.state = 'connecting'
    this.membersDirty = false
    this.stopped = false
    this.relay = new Relay(this, relay)
  }

  /** Estado interno de la red P2P, solo para diagnosticar fallos en pruebas (se expone con HUMBLECHAT_NET_DEBUG). */
  debugInfo() {
    const safe = (fn) => { try { return fn() } catch { return null } }
    const dht = this.swarm?.dht
    return {
      dht: dht ? { host: dht.host, port: dht.port, firewalled: dht.firewalled, randomized: dht.randomized, nodes: safe(() => dht.nodes.length), bootstrapped: dht.bootstrapped } : null,
      swarm: {
        connections: safe(() => this.swarm.connections.size),
        connecting: this.swarm?.connecting,
        peers: safe(() => [...this.swarm.peers.values()].map((p) => ({ k: p.publicKey.toString('hex').slice(0, 8), attempts: p.attempts, banned: p.banned, proven: p.proven, priority: p.priority, waiting: p.waiting, explicit: p.explicit })))
      },
      friends: [...this.peers.keys()].map((k) => k.slice(0, 8)),
      indirect: [...this.relay.reachable().keys()].map((k) => k.slice(0, 8))
    }
  }

  get id() { return this.identity.id }
  get name() { return this.store.names.get(this.id)?.name || this.identity.name }

  async start() {
    this.identity = loadIdentity(this.dir)
    this.store = new Store(path.join(this.dir, 'log'))
    this.store.open()
    this.blobs = new Blobs(path.join(this.dir, 'blobs'))
    this.lastTs = 0

    if (this.store.names.get(this.id)?.name !== this.identity.name) this._author({ t: 'prof', name: this.identity.name, ...this._avatarFields() })

    // Nodos de la DHT conocidos de la última vez: permiten arrancar aunque los nodos de arranque públicos no respondan.
    this.nodesFile = path.join(this.dir, 'dht-nodes.json')
    const dht = this.injectedDht || new DHT({
      ...(this.bootstrap ? { bootstrap: this.bootstrap } : {}),
      nodes: this._loadNodes(),
      ...this.dhtOpts
    })
    this.swarm = new Hyperswarm({ keyPair: this.identity.keyPair, dht })
    this.swarm.on('connection', (conn) => this._onConnection(conn))
    this.swarm.on('error', () => {})
    this.swarm.dht.on('network-update', () => this._refreshState())

    this.discovery = this.swarm.join(topicOf(this.groupKey), { server: true, client: true })
    this.relay.start()
    this.connectTimer = setTimeout(() => { if (!this.ready) this._setState('offline') }, 15000)
    this.pumpTimer = setInterval(() => this._pumpBlobs(), 20000)
    this.pumpTimer.unref?.()
    this.nodesTimer = setInterval(() => this._saveNodes(), 5 * 60 * 1000)
    this.nodesTimer.unref?.()
    this.swarm.flush().then(() => {
      this.ready = true
      this._refreshState()
      this._saveNodes()
    }, () => {})
    this._setState('connecting')
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.connectTimer)
    clearInterval(this.pumpTimer)
    clearInterval(this.nodesTimer)
    this.relay.stop()
    this._saveNodes()
    for (const p of [...this.all]) { p.send({ t: 'bye' }); }
    await new Promise((r) => setTimeout(r, 50))
    try { await this.swarm.destroy() } catch {}
    for (const h of [...this.blobs.receiving.keys()]) this.blobs.abort(h)
    await this.store.close()
  }

  _loadNodes() {
    try {
      const nodes = JSON.parse(fs.readFileSync(this.nodesFile, 'utf8'))
      return nodes.filter((n) => n && typeof n.host === 'string' && Number.isInteger(n.port)).slice(0, 100)
    } catch { return [] }
  }

  _saveNodes() {
    try {
      const nodes = this.swarm.dht.toArray({ limit: 64 })
      if (!nodes.length) return
      fs.writeFileSync(this.nodesFile + '.tmp', JSON.stringify(nodes))
      fs.renameSync(this.nodesFile + '.tmp', this.nodesFile)
    } catch {}
  }

  suspend() { try { this.swarm.suspend() } catch {} }
  resume() { try { this.swarm.resume() } catch {} }

  // ───────────────────────── estado hacia la UI ─────────────────────────

  _refreshState() {
    if (this.stopped) return
    if (!this.ready) return
    this._setState(this.swarm.dht.online === false ? 'offline' : 'online')
  }

  _setState(state) {
    this.state = state
    this.emit('status', this.status())
  }

  status() {
    const outdated = !!this.mismatch && Date.now() - this.mismatch.at < 60000
    return { state: this.state, peers: this.peers.size, ...(outdated ? { mismatch: true } : {}) }
  }

  _members() {
    const ids = new Set(this.store.members().keys())
    for (const id of this.peers.keys()) ids.add(id)
    for (const id of this.relay.reachable().keys()) ids.add(id)
    ids.add(this.id)
    const out = []
    for (const id of ids) {
      const peer = this.peers.get(id)
      const via = peer ? null : this.relay.reachable().get(id) // alcanzable solo a través de otro amigo (p. ej. dos NAT simétricos)
      const me = id === this.id
      out.push({
        id,
        name: (me ? this.name : this.store.names.get(id)?.name || peer?.name) || 'Amigo ' + id.slice(0, 4),
        av: this.store.names.get(id)?.av || null,
        online: me || !!peer || !!via,
        ...(via ? { indirect: true } : {}),
        voice: me ? this.voice : peer ? peer.voice : via ? via.voice : null
      })
    }
    return out
  }

  members() { return this._members() }

  _emitMembers() {
    if (this.membersDirty) return
    this.membersDirty = true
    queueMicrotask(() => {
      this.membersDirty = false
      if (!this.stopped) this.emit('members', this._members())
    })
  }

  snapshot() {
    const channels = this.store.channels()
    const last = {}
    for (const c of channels) if (c.type === 'text') {
      const ev = this.store.last(c.id)
      last[c.id] = ev ? { ts: ev.ts, a: ev.a } : null
    }
    for (const [peer, ev] of this.store.dmPeers(this.id)) last['dm:' + peer] = { ts: ev.ts, a: ev.a }
    return { me: { id: this.id, name: this.name }, members: this._members(), status: this.status(), channels, last, dms: [...this.store.dmPeers(this.id).keys()] }
  }

  history(ch, opts) { return this.store.history(ch, opts) }

  /** Estado de la red para la pestaña Diagnóstico (sin IPs). */
  diagnostics() {
    const link = (p) => {
      const addr = p.conn.rawStream?.remoteHost || ''
      return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|f[cd])/i.test(addr) ? 'red local' : 'directa'
    }
    return {
      status: this.status(),
      peers: [...this.peers.values()].map((p) => ({ name: this.store.names.get(p.id)?.name || p.name || p.id.slice(0, 6), link: link(p) }))
    }
  }

  // ───────────────────────── acciones locales ─────────────────────────

  _author(fields) {
    const ts = Math.max(Date.now(), this.lastTs + 1)
    this.lastTs = ts
    const ev = { a: this.id, n: this.store.nextN(this.id), ts, ...fields }
    ev.sig = sign(this.identity.keyPair.secretKey, this._canonical(ev))
    if (this.store.add(ev) !== 'new') throw new Error('Evento inválido')
    const stored = this.store.events.get(`${ev.a}:${ev.n}`)
    this.emit('event', stored)
    if (stored.t === 'prof') this._emitMembers()
    this._broadcast({ t: 'ev', e: stored })
    return stored
  }

  // La firma se calcula sobre la versión normalizada del evento (la misma que verificarán los demás).
  _canonical(ev) {
    const clean = cleanEvent({ ...ev, sig: '0'.repeat(128) })
    if (!clean) throw new Error('Evento inválido')
    return clean
  }

  send(ch, text, att, re) {
    return this._author({ t: 'msg', ch, text: String(text ?? ''), ...(att && att.length ? { att } : {}), ...(re ? { re } : {}) })
  }

  /** Editar un mensaje propio. */
  edit(id, text) {
    const target = this.store.events.get(id)
    if (!target || target.t !== 'msg' || target.a !== this.id || this.store.deleted.has(id)) return null
    return this._author({ t: 'edit', x: id, text: String(text ?? '') })
  }

  /** Poner o quitar una reacción en cualquier mensaje. */
  react(id, emoji, on) {
    if (!this.store.message(id)) return null
    return this._author({ t: 'react', x: id, e: String(emoji), on: !!on })
  }

  /** "Está escribiendo…": efímero, solo a los conectados directamente. */
  typing(ch) {
    if (typeof ch === 'string' && CHAN_ID.test(ch)) this._broadcast({ t: 'typ', ch })
  }

  // ── canales ──
  createChannel(kind, name) {
    const n = cleanChannelName(kind, name)
    if (!n) throw new Error('Ese nombre de canal no es válido.')
    if (this.store.channels().length >= LIMITS.channels) throw new Error('Ya hay demasiados canales.')
    const id = 'c' + crypto.randomBytes(5).toString('hex')
    this._author({ t: 'chan', ch: id, k: kind, name: n, del: false })
    return id
  }

  renameChannel(id, name) {
    const c = this.store.channel(id)
    const n = c && cleanChannelName(c.type, name)
    if (!c || !n) throw new Error('Ese nombre de canal no es válido.')
    if (n !== c.name) this._author({ t: 'chan', ch: id, k: c.type, name: n, del: false })
  }

  deleteChannel(id) {
    const c = this.store.channel(id)
    if (!c) return
    if (c.type === 'text' && this.store.channels().filter((x) => x.type === 'text').length < 2) throw new Error('Tiene que quedar al menos un canal de texto.')
    this._author({ t: 'chan', ch: id, k: c.type, name: c.name, del: true })
  }

  // ── fijados, avatar y vistas previas ──
  pin(id, on) {
    if (!this.store.message(id)) return null
    return this._author({ t: 'pin', x: id, on: !!on })
  }

  /** Vista previa de un enlace de un mensaje propio (la obtiene quien lo envía, nunca el que lo recibe). */
  embed(id, { url, title, desc, site }) {
    const t = this.store.events.get(id)
    if (!t || t.t !== 'msg' || t.a !== this.id || this.store.deleted.has(id)) return null
    return this._author({ t: 'emb', x: id, url, title: title || '', desc: desc || '', site: site || '' })
  }

  /** `bytes` ya viene reducido (cuadrado, WebP); null quita el avatar. */
  setAvatar(bytes) {
    if (!bytes) { this._author({ t: 'prof', name: this.name }); return null }
    if (bytes.length > LIMITS.avatar) throw new Error('El avatar pesa demasiado.')
    const { h, size } = this.blobs.put(Buffer.from(bytes))
    this._author({ t: 'prof', name: this.name, av: h, avs: size })
    return h
  }

  // ── mensajes directos ──
  dm(to, text) {
    text = String(text ?? '')
    if (!HEX64.test(to) || to === this.id) throw new Error('Destinatario no válido.')
    if (!text.trim() || text.length > LIMITS.text) throw new Error('Mensaje no válido.')
    return this._author({ t: 'dm', to, box: dmcrypto.seal(this.identity.keyPair.secretKey, to, text) })
  }

  /** Un mensaje directo descifrado con la forma de un mensaje de canal (ch = "dm:<otro>"), o null si no es para nosotros. */
  openDm(ev) {
    if (ev.t !== 'dm' || (ev.a !== this.id && ev.to !== this.id)) return null
    const peer = ev.a === this.id ? ev.to : ev.a
    const text = dmcrypto.open(this.identity.keyPair.secretKey, peer, ev.box)
    return text === null ? null : { t: 'msg', ch: 'dm:' + peer, a: ev.a, n: ev.n, ts: ev.ts, text, dm: true }
  }

  dmHistory(peer, { beforeTs = null, beforeId = null, limit = 60 } = {}) {
    if (!HEX64.test(peer)) return []
    let list = this.store.dmThread(this.id, peer)
    if (beforeTs !== null) list = list.filter((e) => e.ts < beforeTs || (e.ts === beforeTs && `${e.a}:${e.n}` < String(beforeId)))
    return list.slice(-limit).map((e) => this.openDm(e)).filter(Boolean)
  }

  search(query, opts) { return this.store.search(query, opts) }

  remove(id) {
    if (typeof id !== 'string' || !id.startsWith(this.id + ':')) return null
    return this._author({ t: 'del', x: id })
  }

  setName(name) {
    const n = this.identity.setName(name)
    this._author({ t: 'prof', name: n, ...this._avatarFields() })
    return n
  }

  // Nombre y avatar viajan en el mismo evento: cambiar uno conserva el otro.
  _avatarFields() {
    const cur = this.store.names.get(this.id)
    return cur?.av ? { av: cur.av, avs: cur.avs } : {}
  }

  setVoice(v) {
    this.voice = cleanVoice(v)
    this._broadcast({ t: 'pres', voice: this.voice })
    this.relay.announce()
    this._emitMembers()
  }

  signal(to, data) {
    const p = this.peers.get(to)
    if (p) p.send({ t: 'sig', data })
    return p ? true : this.relay.sendSignal(to, data) // sin conexión directa: por el amigo que nos une
  }

  addBlob(buf, meta) {
    const { h, size } = this.blobs.put(buf)
    const name = String(meta.name || 'archivo').replace(/\p{Cc}/gu, '').slice(0, 120) || 'archivo'
    return { h, size, name, mime: meta.mime, w: meta.w, ht: meta.ht }
  }

  /** Ruta local de un adjunto; si falta lo pide a los demás (reintentando) y espera. */
  whenBlob(h, timeout = 20000) {
    if (this.blobs.has(h)) return Promise.resolve(this.blobs.path(h))
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(t); clearInterval(retry); this.off('blob', onBlob); fn(v) }
      const t = setTimeout(() => done(reject, new Error('timeout')), timeout)
      const retry = setInterval(() => this._pumpBlobs(h), 3000)
      const onBlob = (got) => { if (got === h) done(resolve, this.blobs.path(h)) }
      this.on('blob', onBlob)
      this._pumpBlobs(h)
    })
  }

  /** Avance de la descarga de un adjunto (para la barra de progreso). */
  blobProgress(h) {
    if (this.blobs.has(h)) return { done: true }
    const r = this.blobs.receiving.get(h)
    return { done: false, got: r?.got || 0, total: r?.total || this.wanted.get(h)?.size || 0 }
  }

  _broadcast(msg, except = null) {
    const frame = encodeJSON(msg)
    for (const p of this.peers.values()) if (p !== except && !p.closed) p.conn.write(frame)
  }

  // ───────────────────────── conexiones ─────────────────────────

  _onConnection(conn) {
    if (this.stopped) return conn.destroy()
    const peer = new Peer(this, conn)
    this.all.add(peer)
    peer.send({
      t: 'hello',
      v: PROTOCOL,
      proof: proofOf(this.groupKey, conn.handshakeHash),
      name: this.name,
      voice: this.voice
    })
  }

  _onPeerClose(peer) {
    if (!this.all.delete(peer)) return
    this.blobs.abortFrom(peer.id)
    for (const [h, w] of [...this.wanted]) if (w.peerId === peer.id) this.wanted.delete(h)
    for (const set of this.waiters.values()) set.delete(peer)
    if (this.peers.get(peer.id) === peer) {
      this.peers.delete(peer.id)
      this.relay.peerLeft(peer.id)
      this._emitMembers()
      this.emit('status', this.status())
      this.emit('peer-left', peer.id)
    }
  }

  _onMessage(peer, m) {
    if (!m || typeof m !== 'object') return
    if (!peer.ready) {
      if (m.t !== 'hello' || typeof m.proof !== 'string') return peer.close()
      const want = Buffer.from(proofOf(this.groupKey, peer.conn.handshakeHash))
      const got = Buffer.from(m.proof)
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return peer.close() // llave distinta
      if (m.v !== PROTOCOL) { // es de los nuestros (conoce la llave) pero con otra versión de la app: avisar, no callar
        this.mismatch = { v: m.v, at: Date.now() }
        this.emit('status', this.status())
        return peer.close()
      }
      peer.ready = true
      peer.name = typeof m.name === 'string' ? m.name.slice(0, LIMITS.name) : null
      peer.voice = cleanVoice(m.voice)
      const old = this.peers.get(peer.id)
      this.peers.set(peer.id, peer)
      if (old && old !== peer) old.close()
      peer.send({ t: 'sync', vec: this.store.vector() })
      this.relay.peerJoined(peer.id)
      this.relay.greet(peer)
      this._emitMembers()
      this.emit('status', this.status())
      return
    }
    switch (m.t) {
      case 'sync': return this._onSync(peer, m)
      case 'ev': return this._ingest(peer, [m.e])
      case 'evs': return Array.isArray(m.list) && this._ingest(peer, m.list.slice(0, 500))
      case 'want': return this._onWant(peer, m)
      case 'pres':
        peer.voice = cleanVoice(m.voice)
        return this._emitMembers()
      case 'sig':
        if (JSON.stringify(m.data ?? null).length < 64 * 1024) this.emit('signal', peer.id, m.data)
        return
      case 'typ':
        if (typeof m.ch === 'string' && CHAN_ID.test(m.ch)) this.emit('typing', peer.id, m.ch)
        return
      case 'rpr': return this.relay.onPresence(peer, m)
      case 'rsg': return this.relay.onSignal(peer, m)
      case 'bw': return this._onBlobWant(peer, m.h)
      case 'bmiss':
        if (typeof m.h === 'string') { peer.misses.set(m.h, Date.now()); if (this.wanted.get(m.h)?.peerId === peer.id) this.wanted.delete(m.h) }
        return
      case 'bye': return peer.close()
    }
  }

  // ───────────────────────── replicación ─────────────────────────

  _onSync(peer, m) {
    for (const batch of this.store.missingFor(cleanVector(m.vec))) peer.send({ t: 'evs', list: batch })
    this._pumpBlobs()
  }

  _onWant(peer, m) {
    if (!HEX64.test(m.a) || !Number.isInteger(m.from) || m.from < 1) return
    const list = this.store.range(m.a, m.from, 200)
    if (list.length) peer.send({ t: 'evs', list })
  }

  _ingest(peer, list) {
    const fresh = []
    for (const raw of list) {
      if (this.store.add(raw) !== 'new') continue
      const ev = this.store.events.get(`${raw.a}:${raw.n}`)
      fresh.push(ev)
      this.emit('event', ev)
      if (ev.t === 'prof') this._emitMembers()
      // ¿hueco en la cadena de ese autor? pídelo a quien nos lo mandó.
      const have = this.store.contig.get(ev.a) || 0
      if (ev.n > have + 1 && peer.gapAsked.get(ev.a) !== have + 1) {
        peer.gapAsked.set(ev.a, have + 1)
        peer.send({ t: 'want', a: ev.a, from: have + 1 })
      }
    }
    if (!fresh.length) return
    // Reenvío en "flood": si algún vecino no nos conoce a todos, igualmente le llega.
    this._broadcast(fresh.length === 1 ? { t: 'ev', e: fresh[0] } : { t: 'evs', list: fresh }, peer)
    for (const ev of fresh) {
      if (ev.att) for (const a of ev.att) if (isAuto(a)) this._wantBlob(a, peer)
      if (ev.t === 'prof' && ev.av) this._wantBlob({ h: ev.av, size: ev.avs }, peer)
    }
  }

  // ───────────────────────── adjuntos ─────────────────────────

  _wantBlob(att, peer) {
    if (this.blobs.has(att.h) || this.wanted.has(att.h)) return
    const at = peer.misses.get(att.h)
    if (at && Date.now() - at < 60000) return
    this.wanted.set(att.h, { size: att.size, peerId: peer.id })
    peer.send({ t: 'bw', h: att.h })
  }

  _pumpBlobs(only = null) {
    const peers = [...this.peers.values()]
    if (!peers.length) return
    let i = 0
    for (const att of this.store.attachments()) {
      if (only ? att.h !== only : !isAuto(att)) continue // los archivos grandes o no imagen solo se bajan al pedirlos
      if (this.blobs.has(att.h) || this.wanted.has(att.h)) continue
      for (let k = 0; k < peers.length; k++) {
        const p = peers[(i + k) % peers.length]
        const at = p.misses.get(att.h)
        if (at && Date.now() - at < 60000) continue
        this._wantBlob(att, p)
        break
      }
      i++
    }
  }

  _onBlobWant(peer, h) {
    if (typeof h !== 'string' || !HEX64.test(h)) return
    if (this.blobs.has(h)) return void this._serveBlob(peer, h)
    if (this.wanted.has(h)) { // lo estamos bajando: se lo daremos en cuanto lo tengamos
      if (!this.waiters.has(h)) this.waiters.set(h, new Set())
      this.waiters.get(h).add(peer)
      return
    }
    peer.send({ t: 'bmiss', h })
  }

  async _serveBlob(peer, h) {
    try {
      const total = this.blobs.size(h)
      let offset = 0
      for await (const chunk of this.blobs.stream(h)) {
        if (peer.closed) return
        await peer.write(encodeBlob(h, offset, total, chunk))
        offset += chunk.length
      }
    } catch {}
  }

  _onBlobFrame(peer, h, offset, total, data) {
    const w = this.wanted.get(h)
    if (!w || w.peerId !== peer.id || total !== w.size) return
    if (offset === 0) this.blobs.begin(h, total, peer.id)
    const r = this.blobs.write(h, offset, data)
    if (r === 'done') {
      this.wanted.delete(h)
      this.emit('blob', h)
      for (const p of this.waiters.get(h) || []) this._serveBlob(p, h)
      this.waiters.delete(h)
    } else if (r === 'bad') {
      this.wanted.delete(h)
    }
  }
}

module.exports = { ChatNode }
