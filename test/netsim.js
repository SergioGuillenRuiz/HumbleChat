'use strict'
// Pruebas de red realistas: instancias reales de Electron, cada una en su propio espacio de red de Linux,
// detrás de NAT (cono, simétrico, CGNAT) y con latencia y pérdida, con una DHT y un coturn propios.
//   npm run test:netsim            todos los escenarios
//   npm run test:netsim -- cono    solo los que contienen "cono" en su nombre
// Hace falta Linux con root (en CI: sudo), `ip`, `nft`, `tc`, `xvfb-run` y `turnserver` (paquete coturn).
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

if (process.platform !== 'linux') { console.log('netsim: solo en Linux, se omite'); process.exit(0) }
if (process.getuid() !== 0) { // se vuelve a lanzar con privilegios conservando el entorno
  const r = spawnSync('sudo', ['-E', 'env', `PATH=${process.env.PATH}`, process.execPath, __filename, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

// Electron se descarga la primera vez que se usa: se hace aquí, una sola vez, para que los clientes (que arrancan a la
// vez) no compitan por la descarga y se pisen.
try { require('electron') } catch (e) { console.error('Electron no está disponible:', e.message); process.exit(1) }

const createTestnet = require('hyperdht/testnet')
const { setup, teardown, HOST_IP } = require('./netsim/topology')

const LAN = { delay: 40, jitter: 10, loss: 1 } // una red doméstica mediocre
const TURN = { urls: `turn:${HOST_IP}:3478?transport=udp`, username: 'hc', credential: 'hc' }

const DIRECT = 'directa (atravesando NAT)'
const isDirect = (p) => p === DIRECT || p === 'red local'
const isTurn = (p) => p === 'por relé TURN'
const isTunnel = (p) => p === 'por túnel de la red P2P'
const isFriendRelay = (p) => /^retransmitido por /.test(p)

/** Escenarios: clientes (en orden Ana, Beto, Carla…) y qué camino debe tomar el audio entre cada par. */
const SCENARIOS = [
  {
    name: 'cono-cono',
    clients: [{ nat: 'cone', netem: LAN }, { nat: 'cone', netem: LAN }],
    paths: [isDirect], desc: 'dos hogares con NAT de cono: conexión directa'
  },
  {
    // Antes era una limitación conocida: WebRTC no atraviesa un NAT simétrico frente a un cono estricto sin TURN. Ahora,
    // si la conexión directa no se logra, el audio pasa por el túnel que va dentro de la conexión P2P del chat
    // (src/main/udptunnel.js), que la DHT sí consigue perforar.
    name: 'simetrico-cono',
    clients: [{ nat: 'symmetric', netem: LAN }, { nat: 'cone', netem: LAN }],
    paths: [isDirect, isTunnel], desc: 'un lado simétrico y el otro cono, sin TURN: la voz va directa o por el túnel de la red P2P'
  },
  {
    name: 'simetrico-cono-turn',
    clients: [{ nat: 'symmetric', netem: LAN }, { nat: 'cone', netem: LAN }],
    turn: TURN, paths: [(p) => isDirect(p) || isTurn(p)], pairPath: { 'Ana-Beto': isTurn },
    desc: 'un lado simétrico y el otro cono, con TURN: la voz pasa por el relé TURN'
  },
  {
    // Antes era una limitación conocida: la presencia de voz y la señalización solo viajaban por conexiones directas,
    // así que dos NAT simétricos ni se veían en la llamada. Ahora van por el amigo que los une (src/core/relay.js) y el
    // audio se retransmite por él, que tiene IP pública y enlace directo con ambos.
    name: 'simetrico-simetrico-rele-de-amigo',
    clients: [{ nat: 'symmetric', netem: LAN }, { nat: 'symmetric', netem: LAN }, { nat: 'public', netem: LAN }],
    paths: [(p) => isDirect(p) || isFriendRelay(p)], pairPath: { 'Ana-Beto': isFriendRelay },
    desc: 'dos NAT simétricos y un amigo con IP pública, sin TURN: el audio entre ellos se retransmite por el amigo'
  },
  {
    name: 'simetrico-simetrico-turn',
    clients: [{ nat: 'symmetric', netem: LAN }, { nat: 'symmetric', netem: LAN }, { nat: 'public', netem: LAN }],
    turn: TURN, paths: [(p) => isDirect(p) || isTurn(p)], pairPath: { 'Ana-Beto': isTurn },
    desc: 'dos NAT simétricos con un servidor TURN configurado: el audio entre ellos pasa por el TURN'
  },
  {
    // Es el caso de un portátil con datos móviles frente a una casa con fibra: antes sin voz, ahora por el túnel.
    name: 'cgnat-cono',
    clients: [{ nat: 'cgnat', netem: LAN }, { nat: 'cone', netem: LAN }],
    paths: [isDirect, isTunnel], desc: 'doble NAT (CGNAT, como datos móviles) frente a un cono: la voz va directa o por el túnel'
  }
]

const NAMES = ['Ana', 'Beto', 'Carla', 'Diego']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startCoturn() {
  const p = spawn('turnserver', ['-n', '--no-cli', '--no-tls', '--no-dtls', `--listening-ip=${HOST_IP}`, `--relay-ip=${HOST_IP}`, '--listening-port=3478', '--realm=hc', '--lt-cred-mech', '--user=hc:hc', '--min-port=49160', '--max-port=49400', '--fingerprint', '--log-file=/dev/null', '--no-software-attribute'], { stdio: 'ignore' })
  p.on('error', () => {})
  return p
}

async function runScenario(sc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-netsim-'))
  const key = crypto.randomBytes(32).toString('hex')
  const nets = setup(sc.clients)
  const modos = [...new Set(nets.map((n) => n.degradacion))].join(', ')
  const testnet = await createTestnet(8, { host: HOST_IP })
  const b = testnet.bootstrap[0]
  const bootstrap = `${b.host}:${b.port}`
  const names = sc.clients.map((_c, i) => NAMES[i])
  const procs = nets.map((n, i) => {
    const name = names[i]
    const log = fs.openSync(path.join(dir, `log-${name}.txt`), 'w')
    const env = { ...process.env, HC_NAME: name, HC_KEY: key, HC_BOOT: bootstrap, HC_DIR: dir, HC_PEERS: names.filter((x) => x !== name).join(','), ...(sc.turn ? { HC_TURN: JSON.stringify(sc.turn) } : {}), ...(sc.minVisible ? { HC_MIN_VISIBLE: String(sc.minVisible) } : {}) }
    return spawn('ip', ['netns', 'exec', n.ns, 'xvfb-run', '-a', '-s', '-screen 0 1280x800x24', process.execPath, path.join(__dirname, 'netsim', 'client.js')], { env, stdio: ['ignore', log, log] })
  })
  const exited = Promise.all(procs.map((p) => new Promise((r) => p.on('exit', r))))
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 8 * 60 * 1000))
  const how = await Promise.race([exited, timeout])
  if (how === 'timeout') procs.forEach((p) => p.kill('SIGKILL'))
  await testnet.destroy().catch(() => {})
  teardown()

  const results = names.map((n) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, `resultado-${n}.json`), 'utf8')) } catch { return { name: n, errors: ['no hubo resultado (el cliente no terminó)'] } }
  })
  const problems = []
  const notas = []
  for (const [i, r] of results.entries()) {
    const publico = sc.clients[i].nat === 'public'
    const hayVoz = !!r.paths?.length && !r.errors.some((e) => e.startsWith('voz'))
    if (sc.voiceLimit && !publico) notas.push(hayVoz ? `${r.name}: la voz FUNCIONA (${r.paths.join(' | ')}): mejora sobre la limitación conocida` : `${r.name}: sin voz, como indica la limitación conocida`)
    for (const e of r.errors) if (!(sc.voiceLimit && e.startsWith('voz'))) problems.push(`${r.name}: ${e}`)
    if (sc.voiceLimit) continue
    if (!r.paths?.length && !r.errors.length) problems.push(`${r.name}: sin datos de voz`)
    for (const p of r.paths || []) if (!sc.paths.some((f) => f(p))) problems.push(`${r.name}: camino de audio inesperado «${p}»`)
  }
  for (const [pair, f] of Object.entries(sc.pairPath || {})) {
    const [a] = pair.split('-')
    const r = results.find((x) => x.name === a)
    if (r && !(r.paths || []).some(f)) problems.push(`${pair}: ningún camino de audio cumple lo esperado (${(r.paths || []).join(' | ') || 'sin datos'})`)
  }
  return { sc, results, problems, notas, dir, modos }
}

;(async () => {
  const filter = process.argv[2]
  const list = SCENARIOS.filter((s) => !filter || s.name.includes(filter))
  const turn = startCoturn()
  await sleep(800)
  let failed = 0
  try {
    for (const sc of list) {
      console.log(`\n▶ ${sc.name} — ${sc.desc}`)
      const t0 = Date.now()
      const { results, problems, notas, dir, modos } = await runScenario(sc)
      console.log(`   degradación de red: ${modos}`)
      for (const r of results) console.log(`   ${r.name.padEnd(6)} conexión ${r.connectMs ?? '—'} ms · chat ${r.chatMs ?? '—'} ms · voz ${r.voiceMs ?? '—'} ms · ${(r.paths || []).join(' | ') || 'sin camino'}`)
      for (const t of notas) console.log('   ℹ ' + t)
      if (problems.length) {
        failed++
        console.log(`   ✘ ${problems.length} problema(s) (${Math.round((Date.now() - t0) / 1000)} s):`)
        for (const p of problems) console.log('     - ' + p)
        for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('log-'))) console.log(`   --- ${f} (final) ---\n` + fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(-15).join('\n'))
        // Siempre se guardan (sudo no pasa bien las variables de entorno): el CI sube test-results/ al fallar
        const keep = process.env.NETSIM_ARTIFACTS || path.join(__dirname, '..', 'test-results', 'netsim')
        fs.mkdirSync(keep, { recursive: true })
        for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(keep, `${sc.name}-${f}`))
      } else console.log(`   ✔ correcto (${Math.round((Date.now() - t0) / 1000)} s)`)
    }
  } finally {
    teardown()
    turn.kill()
  }
  console.log(failed ? `\nNETSIM FALLO: ${failed} de ${list.length} escenarios` : `\nNETSIM OK: ${list.length} escenarios`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('NETSIM error:', e); teardown(); process.exit(1) })
