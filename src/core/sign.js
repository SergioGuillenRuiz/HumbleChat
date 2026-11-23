'use strict'
// Firma de eventos (Ed25519). Cada evento lleva la firma de su autor, así que nadie, ni siquiera
// quien tenga la llave del grupo o retransmita mensajes, puede suplantar a otro ni alterar lo que dijo.
const sodium = require('sodium-native')

const DOMAIN = 'humblechat/event/v2'
const HEX128 = /^[0-9a-f]{128}$/

/** Serialización canónica: un array con orden fijo (no depende del orden de las claves del objeto). */
function canon(ev) {
  const base = [DOMAIN, ev.a, ev.n, ev.ts, ev.t]
  if (ev.t === 'msg') {
    base.push(ev.ch, ev.text, (ev.att || []).map((a) => [a.h, a.name, a.mime, a.size, a.w ?? 0, a.ht ?? 0]))
  } else if (ev.t === 'del') base.push(ev.x)
  else if (ev.t === 'prof') base.push(ev.name)
  return Buffer.from(JSON.stringify(base))
}

function sign(secretKey, ev) {
  const sig = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, canon(ev), secretKey)
  return sig.toString('hex')
}

function verify(ev) {
  if (typeof ev.sig !== 'string' || !HEX128.test(ev.sig)) return false
  try {
    return sodium.crypto_sign_verify_detached(Buffer.from(ev.sig, 'hex'), canon(ev), Buffer.from(ev.a, 'hex'))
  } catch { return false }
}

module.exports = { sign, verify, canon, HEX128 }
