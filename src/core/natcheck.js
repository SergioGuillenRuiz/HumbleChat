'use strict'
// Comprobación de la red para la voz: ¿hay UDP?, ¿qué tipo de NAT tiene el router?
// Se pregunta a varios servidores STUN desde el MISMO socket: si todos ven el mismo puerto público, el NAT es de
// tipo "cono" (la conexión directa entre amigos funciona casi siempre); si cada uno ve uno distinto es "simétrico"
// (la conexión directa suele fallar y la voz tiene que ir retransmitida por otro amigo o por un TURN).
const dgram = require('dgram')
const crypto = require('crypto')
const { ICE_SERVERS } = require('./constants')

const MAGIC = 0x2112a442
const COOKIE = [0x21, 0x12, 0xa4, 0x42]

function bindingRequest() {
  const txid = crypto.randomBytes(12)
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0)
  buf.writeUInt32BE(MAGIC, 4)
  txid.copy(buf, 8)
  return { buf, txid }
}

/** Lee la dirección pública (XOR-MAPPED-ADDRESS o MAPPED-ADDRESS) de una respuesta STUN. */
function parseBindingResponse(msg, txid) {
  if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || !msg.subarray(8, 20).equals(txid)) return null
  let o = 20
  while (o + 4 <= msg.length) {
    const type = msg.readUInt16BE(o)
    const len = msg.readUInt16BE(o + 2)
    const v = msg.subarray(o + 4, o + 4 + len)
    if ((type === 0x0020 || type === 0x0001) && v.length >= 8 && v[1] === 0x01) {
      const xor = type === 0x0020
      return {
        port: v.readUInt16BE(2) ^ (xor ? MAGIC >>> 16 : 0),
        address: [0, 1, 2, 3].map((i) => v[4 + i] ^ (xor ? COOKIE[i] : 0)).join('.')
      }
    }
    o += 4 + len + ((4 - (len % 4)) % 4)
  }
  return null
}

function defaultEndpoints(iceServers = ICE_SERVERS) {
  const out = []
  for (const s of iceServers) {
    for (const url of [].concat(s.urls)) {
      const m = /^stun:([\w.-]+)(?::(\d+))?$/.exec(url)
      if (m) out.push({ host: m[1], port: Number(m[2]) || 3478 })
    }
  }
  return out
}

/** @returns {Promise<{type:'cone'|'symmetric'|'unknown'|'blocked', answers:number, publicIp?:string}>} */
async function checkNat({ endpoints = defaultEndpoints(), timeout = 2500 } = {}) {
  const sock = dgram.createSocket('udp4')
  sock.on('error', () => {})
  await new Promise((resolve) => sock.bind(0, resolve))
  const pending = new Map() // txid(hex) -> resolve
  sock.on('message', (msg) => {
    const done = pending.get(msg.subarray(8, 20).toString('hex'))
    if (done) done(msg)
  })
  const ask = ({ host, port }) => new Promise((resolve) => {
    const { buf, txid } = bindingRequest()
    const key = txid.toString('hex')
    const t = setTimeout(() => { pending.delete(key); resolve(null) }, timeout)
    pending.set(key, (msg) => { clearTimeout(t); pending.delete(key); resolve(parseBindingResponse(msg, txid)) })
    sock.send(buf, port, host, (err) => { if (err) { clearTimeout(t); pending.delete(key); resolve(null) } })
  })
  const answers = (await Promise.all(endpoints.map(ask))).filter(Boolean)
  sock.close()
  if (!answers.length) return { type: 'blocked', answers: 0 }
  const ports = new Set(answers.map((a) => a.port))
  const type = answers.length < 2 ? 'unknown' : ports.size === 1 ? 'cone' : 'symmetric'
  return { type, answers: answers.length, publicIp: answers[0].address }
}

const EXPLAIN = {
  cone: 'Tu router es de tipo "cono": la conexión directa con tus amigos debería funcionar.',
  symmetric: 'Tu router es de tipo "simétrico": la conexión directa de voz puede fallar; se usará un amigo como relé (o un TURN, si lo configuras).',
  unknown: 'Solo respondió un servidor STUN: no se puede saber el tipo de NAT.',
  blocked: 'No hay respuesta de ningún servidor STUN: el UDP parece bloqueado (cortafuegos, VPN o red de empresa). La voz no podrá conectar.'
}

module.exports = { checkNat, parseBindingResponse, bindingRequest, defaultEndpoints, EXPLAIN }
