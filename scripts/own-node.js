#!/usr/bin/env node
// Plan B: tu propio punto de encuentro (nodo de arranque de la DHT + servidor STUN) para no depender
// de los públicos. Se ejecuta en cualquier equipo con IP pública (un VPS barato, una Raspberry con los
// puertos UDP abiertos en el router…). No guarda nada de tus conversaciones: solo presenta a las apps.
//
//   node scripts/own-node.js --host 203.0.113.7 [--dht-port 49737] [--stun-port 3478]
//
// Después, en la raíz del repo (y antes de compilar) crea network.json con lo que imprime este script.
'use strict'
const dgram = require('dgram')
const DHT = require('hyperdht')

const MAGIC = 0x2112a442

/** Servidor STUN mínimo (RFC 5389): responde a "Binding Request" con la dirección pública de quien pregunta. */
function startStun({ port = 3478, host = '0.0.0.0' } = {}) {
  const sock = dgram.createSocket({ type: 'udp4' })
  sock.on('error', () => {})
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== MAGIC) return
    if (20 + msg.readUInt16BE(2) !== msg.length) return
    const attr = Buffer.alloc(12)
    attr.writeUInt16BE(0x0020, 0) // XOR-MAPPED-ADDRESS
    attr.writeUInt16BE(8, 2)
    attr[5] = 0x01 // IPv4
    attr.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 6)
    const cookie = [0x21, 0x12, 0xa4, 0x42]
    rinfo.address.split('.').forEach((o, i) => { attr[8 + i] = Number(o) ^ cookie[i] })
    const head = Buffer.alloc(20)
    head.writeUInt16BE(0x0101, 0) // Binding Success Response
    head.writeUInt16BE(attr.length, 2)
    head.writeUInt32BE(MAGIC, 4)
    msg.copy(head, 8, 8, 20) // transaction id
    sock.send(Buffer.concat([head, attr]), rinfo.port, rinfo.address)
  })
  sock.bind(port, host)
  return sock
}

async function startOwnNode({ host, dhtPort = 49737, stunPort = 3478, bind = '0.0.0.0' }) {
  const dht = DHT.bootstrapper(dhtPort, host)
  await dht.ready()
  const stun = startStun({ port: stunPort, host: bind })
  await new Promise((resolve) => stun.once('listening', resolve))
  return {
    dht,
    stun,
    async close() { stun.close(); await dht.destroy() }
  }
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > 0 ? process.argv[i + 1] : def
}

if (require.main === module) {
  const host = arg('host')
  if (!host) {
    console.error('Uso: node scripts/own-node.js --host <tu IPv4 pública> [--dht-port 49737] [--stun-port 3478]')
    process.exit(1)
  }
  const dhtPort = Number(arg('dht-port', 49737))
  const stunPort = Number(arg('stun-port', 3478))
  startOwnNode({ host, dhtPort, stunPort }).then(() => {
    console.log(`Nodo propio en marcha (UDP ${dhtPort} DHT, UDP ${stunPort} STUN). Abre esos puertos UDP en el router/cortafuegos.`)
    console.log('\nCrea network.json en la raíz del repo con:\n')
    console.log(JSON.stringify({ bootstrap: [`${host}:${dhtPort}`], stun: [`${host}:${stunPort}`] }, null, 2))
    console.log('\nY recompila (npm run dist:win / dist:linux). Para pasar de nuevo a los públicos, borra network.json.')
  }, (e) => { console.error(e.message); process.exit(1) })
}

module.exports = { startStun, startOwnNode }
