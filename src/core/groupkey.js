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

module.exports = { findGroupKey, topicOf, proofOf }
