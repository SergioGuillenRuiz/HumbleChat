'use strict'
// Identidad local: una clave ed25519 persistente (su parte pública es tu "id") y
// tu nombre. Se crea sola la primera vez; el nombre por defecto es el del usuario del SO.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const DHT = require('hyperdht')
const { LIMITS } = require('./constants')

function defaultName() {
  let n = 'Amigo'
  try { n = os.userInfo().username || n } catch {}
  n = n.replace(/[._-]+/g, ' ').trim() || 'Amigo'
  return n.charAt(0).toUpperCase() + n.slice(1, LIMITS.name)
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name)
}

function loadIdentity(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'identity.json')
  let data = null
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  if (!data || !/^[0-9a-f]{64}$/.test(data.seed || '')) {
    data = { seed: crypto.randomBytes(32).toString('hex'), name: defaultName() }
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
  }
  const keyPair = DHT.keyPair(Buffer.from(data.seed, 'hex'))
  const id = keyPair.publicKey.toString('hex')
  return {
    id,
    keyPair,
    get name() { return cleanName(data.name) || defaultName() },
    setName(n) {
      data.name = cleanName(n) || defaultName()
      fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
      return data.name
    }
  }
}

module.exports = { loadIdentity, cleanName }
