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
const { CHANNELS, LIMITS, PROTOCOL } = require('./constants')
const { encodeJSON, encodeBlob, Decoder } = require('./frames')
const { loadIdentity } = require('./identity')
const { Store, cleanEvent } = require('./store')
const { Blobs } = require('./blobs')
const { topicOf, proofOf } = require('./groupkey')
const { sign } = require('./sign')

const HEX64 = /^[0-9a-f]{64}$/
const VOICE_IDS = new Set(CHANNELS.filter((c) => c.type === 'voice').map((c) => c.id))

function cleanVoice(v) {
  if (!v || typeof v !== 'object' || !VOICE_IDS.has(v.ch)) return null
  return { ch: v.ch, mute: !!v.mute, deaf: !!v.deaf, share: !!v.share, cam: !!v.cam }
}

function cleanVector(v) {
  if (!v || typeof v !== 'object') return {}
  const out = {}
  for (const [a, n] of Object.entries(v)) if (HEX64.test(a) && Number.isInteger(n) && n > 0) out[a] = n
  return out
}

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
   */
  constructor({ dir, groupKey, bootstrap = undefined, dht = undefined, dhtOpts = {} }) {
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
  }

  get id() { return this.identity.id }
  get name() { return this.store.names.get(this.id)?.name || this.identity.name }

  async start() {
    this.identity = loadIdentity(this.dir)
    this.store = new Store(path.join(this.dir, 'log'))
    this.store.open()
    this.blobs = new Blobs(path.join(this.dir, 'blobs'))
    this.lastTs = 0

    if (this.store.names.get(this.id)?.name !== this.identity.name) this._author({ t: 'prof', name: this.identity.name })

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
    ids.add(this.id)
    const out = []
    for (const id of ids) {
      const peer = this.peers.get(id)
      const me = id === this.id
      out.push({
        id,
        name: (me ? this.name : this.store.names.get(id)?.name || peer?.name) || 'Amigo ' + id.slice(0, 4),
        online: me || !!peer,
        voice: me ? this.voice : peer ? peer.voice : null
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
    const last = {}
    for (const c of CHANNELS) if (c.type === 'text') {
      const ev = this.store.last(c.id)
      last[c.id] = ev ? { ts: ev.ts, a: ev.a } : null
    }
    return { me: { id: this.id, name: this.name }, members: this._members(), status: this.status(), last }
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
    if (CHANNELS.some((c) => c.id === ch && c.type === 'text')) this._broadcast({ t: 'typ', ch })
  }

  remove(id) {
    if (typeof id !== 'string' || !id.startsWith(this.id + ':')) return null
    return this._author({ t: 'del', x: id })
  }

  setName(name) {
    const n = this.identity.setName(name)
    this._author({ t: 'prof', name: n })
    return n
  }

  setVoice(v) {
    this.voice = cleanVoice(v)
    this._broadcast({ t: 'pres', voice: this.voice })
    this._emitMembers()
  }

  signal(to, data) {
    const p = this.peers.get(to)
    if (p) p.send({ t: 'sig', data })
    return !!p
  }

  addBlob(buf, meta) {
    const { h, size } = this.blobs.put(buf)
    return { h, size, name: String(meta.name || 'imagen').slice(0, 120), mime: meta.mime, w: meta.w, ht: meta.ht }
  }

  /** Ruta local de un adjunto; si falta lo pide a los demás y espera. */
  whenBlob(h, timeout = 20000) {
    if (this.blobs.has(h)) return Promise.resolve(this.blobs.path(h))
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off('blob', onBlob); reject(new Error('timeout')) }, timeout)
      const onBlob = (got) => { if (got === h) { clearTimeout(t); this.off('blob', onBlob); resolve(this.blobs.path(h)) } }
      this.on('blob', onBlob)
      this._pumpBlobs(h)
    })
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
        if (CHANNELS.some((c) => c.id === m.ch && c.type === 'text')) this.emit('typing', peer.id, m.ch)
        return
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
    for (const ev of fresh) if (ev.att) for (const a of ev.att) this._wantBlob(a, peer)
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
      if (only && att.h !== only) continue
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
