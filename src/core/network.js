'use strict'
// Servicios de red de los que depende la app, en UN solo sitio.
//
//   Por defecto: nodos de arranque públicos de la DHT de Hyperswarm + servidores STUN públicos.
//   Ninguno pide cuenta, clave ni pago, y ninguno ve mensajes, audio o vídeo (solo IPs).
//
//   Plan B si algún día desaparecen: levanta tu propio nodo (`node scripts/own-node.js`) en cualquier
//   equipo con IP pública y apunta a él con un `network.json` (se incluye en el instalador si lo
//   dejas en la raíz del repo, o puede ir en la carpeta de datos de cada usuario):
//
//     { "bootstrap": ["203.0.113.7:49737"], "stun": ["203.0.113.7:3478"] }
const fs = require('fs')
const path = require('path')
const { ICE_SERVERS } = require('./constants')

const HOST_PORT = /^[\w.\-:[\]]+:\d{1,5}$/

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

const list = (v, re) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && re.test(x)).slice(0, 8) : [])

function loadNetwork({ userDataDir, resourcesDir, repoRoot } = {}) {
  const files = [userDataDir, resourcesDir, repoRoot].filter(Boolean).map((d) => path.join(d, 'network.json'))
  for (const file of files) {
    const cfg = read(file)
    if (!cfg || typeof cfg !== 'object') continue
    const bootstrap = list(cfg.bootstrap, HOST_PORT)
    const stun = list(cfg.stun, /^[\w.\-]+(:\d{1,5})?$/)
    return {
      bootstrap: bootstrap.length ? bootstrap : undefined, // undefined = los públicos de Hyperswarm
      iceServers: stun.length ? [{ urls: stun.map((s) => 'stun:' + s) }] : ICE_SERVERS,
      source: file
    }
  }
  return { bootstrap: undefined, iceServers: ICE_SERVERS, source: 'por defecto' }
}

module.exports = { loadNetwork }
