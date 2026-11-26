'use strict'
// Topología de red simulada con espacios de red de Linux (hace falta root).
//
//   raíz ("Internet") ── puente hcbr0 11.99.0.1/24: DHT de pruebas y coturn (STUN/TURN)
//        │
//        ├─ router hcrN (WAN 11.99.0.1N) ── NAT del hogar ── LAN 192.168.N.0/24 ── cliente hcnN
//        └─ con CGNAT: router hcrN cuelga de un NAT de operador hccN (100.64.N.0/24)
//
// Tipos de NAT (nftables, sobre conntrack de Linux):
//   cone       masquerade normal: la misma IP:puerto externos para todos los destinos (cono con filtrado por destino)
//   symmetric  masquerade random: puerto externo distinto por destino (NAT simétrico, el problemático)
//   cgnat      hogar en cono detrás de un NAT de operador simétrico (doble NAT)
//   public     IP pública sin NAT (servidor, VPS o NAT abierto)
// La red de cada cliente puede degradarse con latencia, jitter y pérdida (tc netem; sin ese módulo, solo pérdida con nftables).
const { execFileSync } = require('child_process')

const BRIDGE = 'hcbr0'
const HOST_IP = '11.99.0.1'

function sh(cmd, args, { ignore = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    if (ignore) return ''
    throw new Error(`${cmd} ${args.join(' ')}\n${e.stderr || e.message}`)
  }
}
const ip = (...a) => sh('ip', a)
const inNs = (ns, ...cmd) => sh('ip', ['netns', 'exec', ns, ...cmd])

const names = (i) => ({ router: `hcr${i}`, client: `hcn${i}`, carrier: `hcc${i}` })

function nat(ns, wanIf, symmetric) {
  inNs(ns, 'sysctl', '-q', '-w', 'net.ipv4.ip_forward=1')
  inNs(ns, 'nft', 'add', 'table', 'ip', 'nat')
  inNs(ns, 'nft', 'add', 'chain', 'ip', 'nat', 'post', '{ type nat hook postrouting priority 100 ; }')
  inNs(ns, 'nft', 'add', 'rule', 'ip', 'nat', 'post', 'oifname', wanIf, 'masquerade', ...(symmetric ? ['random'] : []))
  // Como cualquier router real, no atiende nada desde fuera. Sin esto, el primer paquete sin solicitar llega a la
  // pila local, crea una entrada de conntrack y rompe el mapeo del cliente (y con ello, el agujero en el NAT).
  inNs(ns, 'nft', 'add', 'table', 'ip', 'fw')
  inNs(ns, 'nft', 'add', 'chain', 'ip', 'fw', 'entrada', '{ type filter hook input priority 0 ; policy accept ; }')
  inNs(ns, 'nft', 'add', 'rule', 'ip', 'fw', 'entrada', 'iifname', wanIf, 'ct', 'state', 'new', 'drop')
}

/** Degrada el enlace. Con `tc netem` (latencia, jitter y pérdida); si el núcleo no lo trae, solo pérdida con nftables. */
function netem(edge, wanIf, peer, { delay = 0, jitter = 0, loss = 0 } = {}) {
  if (!delay && !loss) return 'ninguna'
  const args = ['qdisc', 'add', 'dev', wanIf, 'root', 'netem']
  if (delay) args.push('delay', `${delay}ms`, ...(jitter ? [`${jitter}ms`] : []))
  if (loss) args.push('loss', `${loss}%`)
  try {
    inNs(edge, 'tc', ...args)
    sh('tc', ['qdisc', 'add', 'dev', peer, 'root', 'netem', ...args.slice(5)])
    return 'netem'
  } catch {
    if (!loss) return 'ninguna'
    inNs(edge, 'nft', 'add', 'table', 'ip', 'imp')
    inNs(edge, 'nft', 'add', 'chain', 'ip', 'imp', 'perdida', '{ type filter hook forward priority 0 ; }')
    inNs(edge, 'nft', 'add', 'rule', 'ip', 'imp', 'perdida', 'numgen', 'random', 'mod', '100', '<', String(loss), 'drop')
    return 'solo-perdida'
  }
}

function teardown(count = 6) {
  for (let i = 1; i <= count; i++) for (const ns of Object.values(names(i))) sh('ip', ['netns', 'del', ns], { ignore: true })
  sh('ip', ['link', 'del', BRIDGE], { ignore: true })
  for (let i = 1; i <= count; i++) sh('ip', ['link', 'del', `hcw${i}a`], { ignore: true })
}

/**
 * clients: [{ nat: 'cone'|'symmetric'|'cgnat', netem?: { delay, jitter, loss } }]
 * Devuelve [{ ns, wan }] con el espacio de red de cada cliente y su IP pública.
 */
function setup(clients) {
  teardown()
  ip('link', 'add', BRIDGE, 'type', 'bridge')
  ip('addr', 'add', `${HOST_IP}/24`, 'dev', BRIDGE)
  ip('link', 'set', BRIDGE, 'up')
  sh('sysctl', ['-q', '-w', 'net.bridge.bridge-nf-call-iptables=0'], { ignore: true }) // que Docker no filtre el puente

  return clients.map((c, idx) => {
    const i = idx + 1
    const n = names(i)
    if (c.nat === 'public') { // IP pública sin NAT ni cortafuegos (servidor, VPS o NAT abierto): alcanzable desde fuera
      const wanIp = `11.99.0.${10 + i}`
      ip('netns', 'add', n.client)
      inNs(n.client, 'ip', 'link', 'set', 'lo', 'up')
      ip('link', 'add', `hcw${i}a`, 'type', 'veth', 'peer', 'name', `hcw${i}b`, 'netns', n.client)
      ip('link', 'set', `hcw${i}a`, 'master', BRIDGE)
      ip('link', 'set', `hcw${i}a`, 'up')
      inNs(n.client, 'ip', 'addr', 'add', `${wanIp}/24`, 'dev', `hcw${i}b`)
      inNs(n.client, 'ip', 'link', 'set', `hcw${i}b`, 'up')
      inNs(n.client, 'ip', 'route', 'add', 'default', 'via', HOST_IP)
      return { ns: n.client, wan: wanIp, nat: 'public', degradacion: c.netem ? netem(n.client, `hcw${i}b`, `hcw${i}a`, c.netem) : 'ninguna' }
    }
    const cg = c.nat === 'cgnat'
    for (const ns of [n.router, n.client, ...(cg ? [n.carrier] : [])]) { ip('netns', 'add', ns); inNs(ns, 'ip', 'link', 'set', 'lo', 'up') }

    // Salida a "Internet": el router del hogar, o el NAT del operador si hay CGNAT.
    const edge = cg ? n.carrier : n.router
    const wanIp = `11.99.0.${(cg ? 30 : 10) + i}`
    const peer = `hcw${i}a`
    const wanIf = `hcw${i}b`
    ip('link', 'add', peer, 'type', 'veth', 'peer', 'name', wanIf, 'netns', edge)
    ip('link', 'set', peer, 'master', BRIDGE)
    ip('link', 'set', peer, 'up')
    inNs(edge, 'ip', 'addr', 'add', `${wanIp}/24`, 'dev', wanIf)
    inNs(edge, 'ip', 'link', 'set', wanIf, 'up')
    inNs(edge, 'ip', 'route', 'add', 'default', 'via', HOST_IP)

    if (cg) { // operador -> hogar
      const cgLan = `hcg${i}a`
      const hmWan = `hcg${i}b`
      ip('link', 'add', cgLan, 'type', 'veth', 'peer', 'name', hmWan)
      ip('link', 'set', cgLan, 'netns', n.carrier)
      ip('link', 'set', hmWan, 'netns', n.router)
      inNs(n.carrier, 'ip', 'addr', 'add', `100.64.${i}.1/24`, 'dev', cgLan)
      inNs(n.carrier, 'ip', 'link', 'set', cgLan, 'up')
      inNs(n.router, 'ip', 'addr', 'add', `100.64.${i}.2/24`, 'dev', hmWan)
      inNs(n.router, 'ip', 'link', 'set', hmWan, 'up')
      inNs(n.router, 'ip', 'route', 'add', 'default', 'via', `100.64.${i}.1`)
      nat(n.carrier, wanIf, true)
    }

    // hogar -> cliente
    const lanR = `hcl${i}a`
    const lanC = `hcl${i}b`
    ip('link', 'add', lanR, 'type', 'veth', 'peer', 'name', lanC)
    ip('link', 'set', lanR, 'netns', n.router)
    ip('link', 'set', lanC, 'netns', n.client)
    inNs(n.router, 'ip', 'addr', 'add', `192.168.${i}.1/24`, 'dev', lanR)
    inNs(n.router, 'ip', 'link', 'set', lanR, 'up')
    inNs(n.client, 'ip', 'addr', 'add', `192.168.${i}.2/24`, 'dev', lanC)
    inNs(n.client, 'ip', 'link', 'set', lanC, 'up')
    inNs(n.client, 'ip', 'route', 'add', 'default', 'via', `192.168.${i}.1`)
    if (!cg) { nat(n.router, wanIf, c.nat === 'symmetric') } else nat(n.router, `hcg${i}b`, false)

    // Degradación de la red del cliente: en los dos sentidos del enlace al "Internet".
    const degradacion = c.netem ? netem(edge, wanIf, peer, c.netem) : 'ninguna'
    return { ns: n.client, wan: wanIp, nat: c.nat, degradacion }
  })
}

module.exports = { setup, teardown, HOST_IP, BRIDGE }
