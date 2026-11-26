'use strict'
// Retransmisión por un tercero de la PRESENCIA DE VOZ y de la SEÑALIZACIÓN de las llamadas.
//
// Problema: dos amigos con NAT simétrico no pueden abrir conexión directa entre sí, así que no se veían ni podían
// negociar la llamada, aunque los dos estuvieran conectados a un tercero (y aunque hubiera TURN o un amigo que
// retransmita el audio). Aquí la presencia y las señales viajan por ese tercero.
//
//   rpr  presencia retransmitida: "yo (o) estoy en el canal de voz X". Se emite cada pocos segundos y cada nodo la
//        reenvía a sus otros vecinos. Quien la recibe marca a o como "alcanzable por <vecino>" (miembro indirecto).
//   rsg  señal retransmitida: SDP/ICE de f para `to`. Se reenvía por el vecino por el que se alcanza a `to`.
//
// Seguridad: ambos mensajes van FIRMADOS por su autor (Ed25519, como los eventos), con marca de tiempo y número de
// secuencia. El amigo que retransmite puede leerlos pero no alterarlos, suplantar a nadie ni repetirlos (el SDP lleva
// la huella DTLS: si se pudiera cambiar, podría escuchar la llamada). Nodos antiguos ignoran estos mensajes.
const crypto = require('crypto')
const { signParts, verifyParts } = require('./sign')
const { CHAN_ID } = require('./store')

const D_PRES = 'humblechat/rpres/v1'
const D_SIG = 'humblechat/rsig/v1'
const HEX64 = /^[0-9a-f]{64}$/
const MAX_SIGNAL = 64 * 1024

const voiceParts = (v) => (v ? [v.ch, v.mute ? 1 : 0, v.deaf ? 1 : 0, v.share ? 1 : 0, v.cam ? 1 : 0] : null)

class Relay {
  /**
   * node debe exponer: id, identity.keyPair.secretKey, peers (Map id -> Peer con send()), voice,
   * emit(), _emitMembers(). Tiempos en ms, ajustables para las pruebas.
   */
  constructor(node, { ttl = 3, beatMs = 8000, expireMs = 25000, skewMs = 60000 } = {}) {
    this.node = node
    this.ttl = ttl
    this.beatMs = beatMs
    this.expireMs = expireMs
    this.skewMs = skewMs
    this.indirect = new Map() // id -> { voice, via, seen, frame }
    this.lastQ = new Map() // origen -> última secuencia aceptada
    this.frames = new Map() // origen -> { frame, at }: la última presencia vista de cada amigo (para saludar a vecinos nuevos)
    this.seenSig = new Map() // id de señal -> instante (contra repeticiones)
    this.q = 0
    this.timer = null
  }

  start() {
    this.announce()
    this.timer = setInterval(() => this._tick(), Math.min(this.beatMs, 2000))
    this.timer.unref?.()
    this.nextBeat = Date.now() + this.beatMs
  }

  stop() {
    clearInterval(this.timer)
    this.indirect.clear()
  }

  // ───────────── presencia ─────────────

  _presenceFrame() {
    const { node } = this
    const voice = node.voice
    this.q = Math.max(this.q + 1, Date.now())
    const ts = Date.now()
    const sig = signParts(node.identity.keyPair.secretKey, D_PRES, [node.id, ts, this.q, voiceParts(voice)])
    return { t: 'rpr', o: node.id, ts, q: this.q, voice, sig, ttl: this.ttl }
  }

  /** Emite mi presencia a todos mis vecinos (al cambiar de estado y periódicamente). */
  announce() {
    const frame = this._presenceFrame()
    for (const p of this.node.peers.values()) p.send(frame)
    this.nextBeat = Date.now() + this.beatMs
  }

  /** Un vecino nuevo: se le dice dónde estoy y lo que sé de los demás, sin esperar al siguiente latido. */
  greet(peer) {
    peer.send(this._presenceFrame())
    const now = Date.now()
    for (const [o, e] of this.frames) if (o !== peer.id && now - e.at < this.expireMs) peer.send({ ...e.frame, ttl: Math.max(1, (Number(e.frame.ttl) || 1) - 1) })
  }

  /** Lo recibe un vecino directo (`peer`). */
  onPresence(peer, m) {
    const { node } = this
    if (!m || typeof m.o !== 'string' || !HEX64.test(m.o) || m.o === node.id) return
    if (!Number.isFinite(m.ts) || !Number.isFinite(m.q) || Math.abs(Date.now() - m.ts) > this.skewMs) return
    const voice = m.voice == null ? null : sanitizeVoice(m.voice)
    if (m.voice != null && !voice) return
    if (!verifyParts(m.o, D_PRES, [m.o, m.ts, m.q, voiceParts(voice)], m.sig)) return
    if ((this.lastQ.get(m.o) ?? 0) >= m.q) return // repetida o vieja
    this.lastQ.set(m.o, m.q)
    this.frames.set(m.o, { frame: { ...m, voice }, at: Date.now() })
    // Si a este amigo lo veo directamente, mando de primera mano lo suyo; igualmente se reenvía: otros vecinos míos
    // pueden no tener conexión con él (el caso de dos NAT simétricos con un amigo en medio).
    if (!node.peers.has(m.o)) {
      const had = this.indirect.get(m.o)
      this.indirect.set(m.o, { voice, via: peer.id, seen: Date.now() })
      if (!had || JSON.stringify(had.voice) !== JSON.stringify(voice) || had.via !== peer.id) node._emitMembers()
    }
    const ttl = Math.min(Number(m.ttl) || 1, this.ttl) - 1
    if (ttl > 0) for (const p of node.peers.values()) if (p !== peer && p.id !== m.o) p.send({ ...m, voice, ttl })
  }

  /** Un vecino directo se ha ido: lo que llegaba por él deja de ser alcanzable. */
  peerLeft(id) {
    let changed = false
    for (const [o, e] of this.indirect) if (e.via === id) { this.indirect.delete(o); changed = true }
    if (changed) this.node._emitMembers()
  }

  /** Pasa a ser vecino directo: lo indirecto sobra. */
  peerJoined(id) {
    if (this.indirect.delete(id)) this.node._emitMembers()
  }

  _tick() {
    const now = Date.now()
    let changed = false
    for (const [o, e] of this.indirect) if (now - e.seen > this.expireMs || !this.node.peers.has(e.via)) { this.indirect.delete(o); changed = true }
    for (const [id, at] of this.seenSig) if (now - at > this.skewMs * 2) this.seenSig.delete(id)
    for (const [o, e] of this.frames) if (now - e.at > this.expireMs) this.frames.delete(o)
    if (this.lastQ.size > 500) this.lastQ.clear()
    if (changed) this.node._emitMembers()
    if (now >= this.nextBeat) this.announce()
  }

  /** Amigos alcanzables solo a través de otro: id -> { voice, via }. */
  reachable() {
    return this.indirect
  }

  // ───────────── señales ─────────────

  /** Manda una señal a `to`, que no es vecino directo. Devuelve false si no se sabe cómo llegar a él. */
  sendSignal(to, data) {
    const { node } = this
    const e = this.indirect.get(to)
    if (!e || typeof to !== 'string' || !HEX64.test(to)) return false
    let d
    try { d = JSON.stringify(data ?? null) } catch { return false }
    if (d.length > MAX_SIGNAL) return false
    const id = crypto.randomBytes(8).toString('hex')
    const ts = Date.now()
    const sig = signParts(node.identity.keyPair.secretKey, D_SIG, [node.id, to, ts, id, d])
    const frame = { t: 'rsg', f: node.id, to, ts, id, d, sig, ttl: this.ttl }
    this.seenSig.set(id, ts)
    const via = node.peers.get(e.via)
    if (via) via.send(frame)
    else for (const p of node.peers.values()) p.send(frame)
    return true
  }

  onSignal(peer, m) {
    const { node } = this
    if (!m || typeof m.f !== 'string' || typeof m.to !== 'string' || !HEX64.test(m.f) || !HEX64.test(m.to) || m.f === node.id) return
    if (typeof m.id !== 'string' || !/^[0-9a-f]{16}$/.test(m.id) || typeof m.d !== 'string' || m.d.length > MAX_SIGNAL) return
    if (!Number.isFinite(m.ts) || Math.abs(Date.now() - m.ts) > this.skewMs) return
    if (this.seenSig.has(m.id)) return
    if (!verifyParts(m.f, D_SIG, [m.f, m.to, m.ts, m.id, m.d], m.sig)) return
    this.seenSig.set(m.id, Date.now())
    if (m.to === node.id) {
      let data
      try { data = JSON.parse(m.d) } catch { return }
      node.emit('signal', m.f, data)
      return
    }
    const ttl = Math.min(Number(m.ttl) || 1, this.ttl) - 1
    if (ttl < 1) return
    const frame = { ...m, ttl }
    const direct = node.peers.get(m.to)
    if (direct) return direct.send(frame)
    const via = node.peers.get(this.indirect.get(m.to)?.via)
    if (via && via !== peer) return via.send(frame)
    for (const p of node.peers.values()) if (p !== peer) p.send(frame) // no se sabe: se prueba por los demás
  }
}

function sanitizeVoice(v) {
  if (!v || typeof v !== 'object' || typeof v.ch !== 'string' || !CHAN_ID.test(v.ch)) return null
  return { ch: v.ch, mute: !!v.mute, deaf: !!v.deaf, share: !!v.share, cam: !!v.cam }
}

module.exports = { Relay }
