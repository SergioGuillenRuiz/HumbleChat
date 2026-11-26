'use strict'
// Tramas sobre el stream cifrado de Hyperswarm:  [u32 len][u8 kind][payload]
//   kind 0 = JSON, kind 1 = trozo binario de un adjunto, kind 2 = datagrama UDP del túnel de voz/vídeo.
const { LIMITS } = require('./constants')

const KIND_JSON = 0
const KIND_BLOB = 1
const KIND_UDP = 2
const BLOB_HEADER = 64 + 4 + 4 // hash hex ascii + offset + total

function frame(kind, body) {
  const out = Buffer.allocUnsafe(5 + body.length)
  out.writeUInt32BE(body.length + 1, 0)
  out[4] = kind
  body.copy(out, 5)
  return out
}

function encodeJSON(obj) {
  return frame(KIND_JSON, Buffer.from(JSON.stringify(obj)))
}

function encodeBlob(hash, offset, total, data) {
  const head = Buffer.allocUnsafe(BLOB_HEADER)
  head.write(hash, 0, 64, 'ascii')
  head.writeUInt32BE(offset, 64)
  head.writeUInt32BE(total, 68)
  return frame(KIND_BLOB, Buffer.concat([head, data]))
}

function encodeDatagram(data) {
  return frame(KIND_UDP, data)
}

class Decoder {
  constructor(onJSON, onBlob, onError, onDatagram = null) {
    this.onDatagram = onDatagram
    this.buf = Buffer.alloc(0)
    this.onJSON = onJSON
    this.onBlob = onBlob
    this.onError = onError
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(0)
      if (len < 1 || len > LIMITS.frame) return this.onError(new Error('trama inválida'))
      if (this.buf.length < 4 + len) break
      const kind = this.buf[4]
      const body = this.buf.subarray(5, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      try {
        if (kind === KIND_JSON) this.onJSON(JSON.parse(body.toString('utf8')))
        else if (kind === KIND_UDP) this.onDatagram?.(Buffer.from(body))
        else if (kind === KIND_BLOB && body.length >= BLOB_HEADER) {
          this.onBlob(
            body.toString('ascii', 0, 64),
            body.readUInt32BE(64),
            body.readUInt32BE(68),
            body.subarray(BLOB_HEADER)
          )
        }
      } catch (err) {
        return this.onError(err)
      }
    }
  }
}

module.exports = { encodeJSON, encodeBlob, encodeDatagram, Decoder }
