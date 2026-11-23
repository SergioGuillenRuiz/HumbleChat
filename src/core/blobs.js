'use strict'
// Almacén de adjuntos direccionado por contenido (sha256). Un archivo por adjunto.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { LIMITS } = require('./constants')

const HEX64 = /^[0-9a-f]{64}$/

class Blobs {
  constructor(dir) {
    this.dir = dir
    this.receiving = new Map() // hash -> { fd, hasher, got, total, tmp, peerId }
    fs.mkdirSync(dir, { recursive: true })
    // Restos de descargas interrumpidas.
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.part')) fs.rmSync(path.join(dir, f), { force: true })
  }

  path(h) { return path.join(this.dir, h) }

  has(h) { return HEX64.test(h) && fs.existsSync(this.path(h)) }

  size(h) { try { return fs.statSync(this.path(h)).size } catch { return 0 } }

  put(buf) {
    if (buf.length < 1 || buf.length > LIMITS.blob) throw new Error('Adjunto demasiado grande')
    const h = crypto.createHash('sha256').update(buf).digest('hex')
    if (!this.has(h)) {
      const tmp = this.path(h) + '.part'
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, this.path(h))
    }
    return { h, size: buf.length }
  }

  /** Empieza (o reanuda desde cero) la recepción de un adjunto pedido por nosotros. */
  begin(h, total, peerId) {
    if (this.has(h) || this.receiving.has(h)) return false
    if (!HEX64.test(h) || !Number.isInteger(total) || total < 1 || total > LIMITS.blob) return false
    const tmp = this.path(h) + '.part'
    this.receiving.set(h, { fd: fs.openSync(tmp, 'w'), hasher: crypto.createHash('sha256'), got: 0, total, tmp, peerId })
    return true
  }

  /** @returns {'more'|'done'|'bad'|'ignored'} */
  write(h, offset, data) {
    const r = this.receiving.get(h)
    if (!r) return 'ignored'
    if (offset !== r.got || r.got + data.length > r.total) { this.abort(h); return 'bad' }
    fs.writeSync(r.fd, data)
    r.hasher.update(data)
    r.got += data.length
    if (r.got < r.total) return 'more'
    fs.closeSync(r.fd)
    this.receiving.delete(h)
    if (r.hasher.digest('hex') !== h) { fs.rmSync(r.tmp, { force: true }); return 'bad' }
    fs.renameSync(r.tmp, this.path(h))
    return 'done'
  }

  abort(h) {
    const r = this.receiving.get(h)
    if (!r) return
    this.receiving.delete(h)
    try { fs.closeSync(r.fd) } catch {}
    fs.rmSync(r.tmp, { force: true })
  }

  abortFrom(peerId) {
    for (const [h, r] of [...this.receiving]) if (r.peerId === peerId) this.abort(h)
  }

  stream(h, start = 0) {
    return fs.createReadStream(this.path(h), { start, highWaterMark: LIMITS.blobChunk })
  }
}

module.exports = { Blobs }
