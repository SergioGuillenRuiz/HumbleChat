'use strict'
// La "llave de la sala". Orden de búsqueda (la primera que exista gana):
//   1. HUMBLECHAT_KEY (variable de entorno)
//   2. group.key junto al ejecutable / datos de usuario (por si quieres sobrescribirla)
//   3. group.key empaquetada dentro de la app (resources/) o en la raíz del repo (desarrollo)
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function read(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim()
    return s.length >= 16 ? s : null
  } catch { return null }
}

function findGroupKey({ userDataDir, resourcesDir, repoRoot } = {}) {
  const candidates = []
  if (process.env.HUMBLECHAT_KEY) return { key: process.env.HUMBLECHAT_KEY.trim(), source: 'env' }
  if (userDataDir) candidates.push(path.join(userDataDir, 'group.key'))
  if (resourcesDir) candidates.push(path.join(resourcesDir, 'group.key'))
  if (repoRoot) candidates.push(path.join(repoRoot, 'group.key'))
  for (const f of candidates) {
    const key = read(f)
    if (key) return { key, source: f }
  }
  return null
}

// Derivados: el tema de la DHT y la prueba de pertenencia por conexión.
const topicOf = (key) => crypto.createHmac('sha256', key).update('humblechat/topic/v1').digest()
const proofOf = (key, handshakeHash) =>
  crypto.createHmac('sha256', key).update('humblechat/proof/v1').update(handshakeHash).digest('hex')

// ───────────── Código de sala: la llave en forma legible para compartirla ─────────────
/** Llave nueva y aleatoria (256 bits). */
const generateKey = () => crypto.randomBytes(32).toString('hex')

/** "abcd1234-…" (8 grupos de 8). Si la llave no es de 64 hex (p. ej. una definida a mano) se muestra tal cual. */
function formatCode(key) {
  return /^[0-9a-f]{64}$/.test(key) ? key.match(/.{8}/g).join('-') : key
}

/** Acepta el código con guiones, espacios o mayúsculas; devuelve la llave o null si no es un código válido. */
function parseCode(text) {
  const hex = String(text || '').replace(/[\s-]+/g, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

/** Huella corta de la sala: dos personas con la misma huella tienen la misma llave. */
function fingerprint(key) {
  const h = crypto.createHash('sha256').update('humblechat/fingerprint/v1').update(key).digest('hex')
  return h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12)
}

module.exports = { findGroupKey, topicOf, proofOf, generateKey, formatCode, parseCode, fingerprint }
