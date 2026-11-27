'use strict'
// Túnel UDP por la conexión P2P. WebRTC no siempre logra conectar directamente (NAT simétrico, CGNAT de datos móviles),
// pero la conexión de la DHT (que ya usa el chat) sí. Para cada amigo se abren aquí sockets UDP locales que hacen de "el
// otro extremo": se le dan a WebRTC como candidatos más, todo lo que WebRTC les manda se reenvía por la conexión cifrada
// del chat, y lo que llega del amigo se entrega a WebRTC desde ese mismo puerto.
// El cifrado de extremo a extremo (DTLS-SRTP) sigue siendo el de WebRTC: aquí solo pasan bytes opacos.
//
// Los sockets escuchan en las direcciones de red de la propia máquina (la IP de la LAN), no solo en 127.0.0.1: probado en
// Windows, WebRTC no empareja ningún candidato local con uno de bucle local (0 pares, 0 paquetes), pero sí con la IP propia.
// El bucle local se deja solo como último recurso (máquina sin red).
const dgram = require('dgram')
const os = require('os')

const MAX_QUEUE = 64 // datagramas que esperan a saber a qué puerto local de WebRTC entregar (ráfaga inicial de ICE)
const MAX_ADDRESSES = 3

/** IPv4 de las interfaces de red de esta máquina (sin bucle local ni link-local), y el bucle local al final. */
function localAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue
      if (!out.includes(i.address)) out.push(i.address)
    }
  }
  return [...out.slice(0, MAX_ADDRESSES), '127.0.0.1']
}

const isStun = (msg) => msg.length > 0 && msg[0] <= 3 // STUN/ICE empieza por 0 o 1; DTLS (20-63) y RTP (128-191) no

class UdpTunnels {
  /** @param {{ sendDatagram(id: string, data: Buffer): boolean, on(ev: string, fn: Function): any }} node */
  constructor(node, { addresses = localAddresses } = {}) {
    this.node = node
    this.addresses = addresses
    this.tunnels = new Map() // id de amigo -> { socks: [{ sock, address, port, local }], active, queue, tx, rx, drops }
    node.on('datagram', (id, data) => this._fromPeer(id, data))
  }

  /** Abre (o reutiliza) el túnel con un amigo y devuelve las direcciones que se dan a WebRTC como candidatos. */
  async open(id) {
    const cur = this.tunnels.get(id)
    if (cur) return cur.socks.map((s) => ({ address: s.address, port: s.port }))
    const t = { socks: [], active: null, queue: [], tx: 0, rx: 0, drops: 0 }
    this.tunnels.set(id, t)
    for (const address of this.addresses()) {
      const s = { sock: dgram.createSocket('udp4'), address, port: 0, local: null }
      s.sock.on('error', () => {})
      s.sock.on('message', (msg, rinfo) => this._fromLocal(id, t, s, msg, rinfo))
      try {
        await new Promise((resolve, reject) => { s.sock.once('error', reject); s.sock.bind(0, address, resolve) })
      } catch { try { s.sock.close() } catch {} ; continue } // una dirección que ya no existe no impide usar las demás
      s.port = s.sock.address().port
      t.socks.push(s)
    }
    if (this.tunnels.get(id) !== t) { for (const s of t.socks) try { s.sock.close() } catch {} ; return [] } // se cerró mientras se abría
    return t.socks.map((s) => ({ address: s.address, port: s.port }))
  }

  close(id) {
    const t = this.tunnels.get(id)
    if (!t) return
    this.tunnels.delete(id)
    for (const s of t.socks) try { s.sock.close() } catch {}
  }

  closeAll() { for (const id of [...this.tunnels.keys()]) this.close(id) }

  /** Contadores para el diagnóstico. */
  stats(id) {
    const t = this.tunnels.get(id)
    return t ? { tx: t.tx, rx: t.rx, drops: t.drops, addresses: t.socks.length } : null
  }

  /** WebRTC nos habla: queda anotado desde qué puerto suyo (destino de vuelta) y se reenvía al amigo. */
  _fromLocal(id, t, s, msg, rinfo) {
    // WebRTC habla desde su propio puerto: ese es el destino de vuelta. Una vez fijado, solo lo cambia el tráfico que no
    // es STUN (DTLS/RTP), que viene del par ICE elegido; las comprobaciones STUN de otros pares no deben desviarlo.
    if (!s.local || !isStun(msg)) s.local = { address: rinfo.address, port: rinfo.port }
    if (!isStun(msg)) t.active = s
    if (t.queue.length) { for (const q of t.queue.splice(0)) this._toLocal(t, q) }
    if (this.node.sendDatagram(id, msg)) t.tx++
    else t.drops++
  }

  _fromPeer(id, data) {
    const t = this.tunnels.get(id)
    if (!t) return
    t.rx++
    if (t.socks.some((s) => s.local)) this._toLocal(t, data)
    else if (t.queue.length < MAX_QUEUE) t.queue.push(data)
  }

  /**
   * Entrega a WebRTC. Los datos (DTLS/RTP) van por el socket del par ICE elegido; mientras no se sabe cuál es, y para las
   * comprobaciones STUN, por todos los que ya tienen destino (cada uno es un "otro extremo" distinto y WebRTC se queda
   * con el que corresponde a la dirección que sondeó).
   */
  _toLocal(t, data) {
    const only = !isStun(data) && t.active?.local ? [t.active] : t.socks.filter((s) => s.local)
    for (const s of only) { try { s.sock.send(data, s.local.port, s.local.address) } catch {} }
  }
}

module.exports = { UdpTunnels, localAddresses }
