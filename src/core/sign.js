'use strict'
// Firma de eventos (Ed25519). Cada evento lleva la firma de su autor, así que nadie, ni siquiera
// quien tenga la llave del grupo o retransmita mensajes, puede suplantar a otro ni alterar lo que dijo.
const sodium = require('sodium-native')

const DOMAIN = 'humblechat/event/v4'
const HEX128 = /^[0-9a-f]{128}$/

/** Serialización canónica: un array con orden fijo (no depende del orden de las claves del objeto). */
function canon(ev) {
  const base = [DOMAIN, ev.a, ev.n, ev.ts, ev.t]
  if (ev.t === 'msg') {
    base.push(ev.ch, ev.text, (ev.att || []).map((a) => [a.h, a.name, a.mime, a.size, a.w ?? 0, a.ht ?? 0]), ev.re ?? null)
  } else if (ev.t === 'del') base.push(ev.x)
  else if (ev.t === 'edit') base.push(ev.x, ev.text)
  else if (ev.t === 'react') base.push(ev.x, ev.e, ev.on ? 1 : 0)
  else if (ev.t === 'prof') base.push(ev.name, ev.av ?? null, ev.avs ?? 0)
  else if (ev.t === 'chan') base.push(ev.ch, ev.k, ev.name, ev.del ? 1 : 0)
  else if (ev.t === 'pin') base.push(ev.x, ev.on ? 1 : 0)
  else if (ev.t === 'emb') base.push(ev.x, ev.url, ev.title, ev.desc, ev.site)
  else if (ev.t === 'dm') base.push(ev.to, ev.box)
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

/** Firma de mensajes sueltos (presencia y señales retransmitidas). `domain` separa usos: una firma de un tipo no vale para otro. */
function signParts(secretKey, domain, parts) {
  const sig = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, Buffer.from(JSON.stringify([domain, ...parts])), secretKey)
  return sig.toString('hex')
}

/** `author` es la clave pública (hex de 64) de quien firmó. Nunca lanza. */
function verifyParts(author, domain, parts, sigHex) {
  if (typeof sigHex !== 'string' || !HEX128.test(sigHex) || typeof author !== 'string' || !/^[0-9a-f]{64}$/.test(author)) return false
  try {
    return sodium.crypto_sign_verify_detached(Buffer.from(sigHex, 'hex'), Buffer.from(JSON.stringify([domain, ...parts])), Buffer.from(author, 'hex'))
  } catch { return false }
}

module.exports = { sign, verify, canon, signParts, verifyParts, HEX128 }
