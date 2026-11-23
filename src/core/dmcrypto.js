'use strict'
// Cifrado de mensajes directos: caja X25519 derivada de las claves Ed25519 de ambos (la misma que ya firma los eventos).
// Solo el emisor y el destinatario pueden leerlo; el resto del grupo replica el mensaje pero ve únicamente datos opacos.
const sodium = require('sodium-native')

const NONCE = sodium.crypto_box_NONCEBYTES
const MAC = sodium.crypto_box_MACBYTES

function curvePair(secretKey, publicKey) {
  const sk = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES)
  const pk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_sk_to_curve25519(sk, secretKey)
  sodium.crypto_sign_ed25519_pk_to_curve25519(pk, publicKey)
  return { sk, pk }
}

/** @returns {string} base64( nonce | cifrado ) */
function seal(mySecretKey, theirPublicKeyHex, text) {
  const { sk, pk } = curvePair(mySecretKey, Buffer.from(theirPublicKeyHex, 'hex'))
  const msg = Buffer.from(JSON.stringify({ t: String(text) }))
  const nonce = Buffer.alloc(NONCE)
  sodium.randombytes_buf(nonce)
  const out = Buffer.alloc(msg.length + MAC)
  sodium.crypto_box_easy(out, msg, nonce, pk, sk)
  return Buffer.concat([nonce, out]).toString('base64')
}

/** Descifra con la clave del otro extremo (vale para leer lo que enviaste y lo que te enviaron). null si no es para ti. */
function open(mySecretKey, otherPublicKeyHex, box) {
  try {
    const raw = Buffer.from(box, 'base64')
    if (raw.length < NONCE + MAC + 1) return null
    const { sk, pk } = curvePair(mySecretKey, Buffer.from(otherPublicKeyHex, 'hex'))
    const msg = Buffer.alloc(raw.length - NONCE - MAC)
    if (!sodium.crypto_box_open_easy(msg, raw.subarray(NONCE), raw.subarray(0, NONCE), pk, sk)) return null
    const t = JSON.parse(msg.toString()).t
    return typeof t === 'string' ? t : null
  } catch { return null }
}

module.exports = { seal, open }
