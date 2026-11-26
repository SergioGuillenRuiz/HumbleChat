'use strict'
// Túnel UDP por la conexión P2P. WebRTC no siempre logra conectar directamente (NAT simétrico, CGNAT de datos móviles),
// pero la conexión de la DHT (que ya usa el chat) sí. Para cada amigo se abre aquí un socket UDP en 127.0.0.1 que hace
// de "el otro extremo": se le da a WebRTC como un candidato más (127.0.0.1:puerto), todo lo que WebRTC le manda se
// reenvía por la conexión cifrada del chat, y lo que llega del amigo se entrega a WebRTC desde ese mismo puerto.
// El cifrado de extremo a extremo (DTLS-SRTP) sigue siendo el de WebRTC: aquí solo pasan bytes opacos.
const dgram = require('dgram')

const MAX_QUEUE = 64 // datagramas que esperan a saber a qué puerto local de WebRTC entregar (ráfaga inicial de ICE)

class UdpTunnels {
  /** @param {{ sendDatagram(id: string, data: Buffer): boolean, on(ev: string, fn: Function): any }} node */
  constructor(node) {
    this.node = node
    this.tunnels = new Map() // id de amigo -> { sock, port, local: {address, port}|null, queue: Buffer[], tx, rx, drops }
    node.on('datagram', (id, data) => this._fromPeer(id, data))
  }

  /** Abre (o reutiliza) el túnel con un amigo y devuelve el puerto local que se da a WebRTC como candidato. */
  async open(id) {
    const cur = this.tunnels.get(id)
    if (cur) return cur.port
    const sock = dgram.createSocket('udp4')
    const t = { sock, port: 0, local: null, queue: [], tx: 0, rx: 0, drops: 0 }
    this.tunnels.set(id, t)
    sock.on('error', () => {})
    sock.on('message', (msg, rinfo) => {
      // WebRTC habla desde su propio puerto: ese es el destino de vuelta. Una vez fijado, solo lo cambia el tráfico que no
      // es STUN (DTLS/RTP), que viene del par ICE elegido; las comprobaciones STUN de otros pares no deben desviarlo.
      if (!t.local || msg[0] > 3) t.local = { address: rinfo.address, port: rinfo.port }
      if (t.queue.length) { for (const q of t.queue.splice(0)) this._toLocal(t, q) }
      if (this.node.sendDatagram(id, msg)) t.tx++
      else t.drops++
    })
    await new Promise((resolve, reject) => { sock.once('error', reject); sock.bind(0, '127.0.0.1', resolve) })
    t.port = sock.address().port
    return t.port
  }

  close(id) {
    const t = this.tunnels.get(id)
    if (!t) return
    this.tunnels.delete(id)
    try { t.sock.close() } catch {}
  }

  closeAll() { for (const id of [...this.tunnels.keys()]) this.close(id) }

  /** Contadores para el diagnóstico. */
  stats(id) {
    const t = this.tunnels.get(id)
    return t ? { tx: t.tx, rx: t.rx, drops: t.drops } : null
  }

  _fromPeer(id, data) {
    const t = this.tunnels.get(id)
    if (!t) return
    t.rx++
    if (t.local) this._toLocal(t, data)
    else if (t.queue.length < MAX_QUEUE) t.queue.push(data)
  }

  _toLocal(t, data) {
    try { t.sock.send(data, t.local.port, t.local.address) } catch {}
  }
}

module.exports = { UdpTunnels }
