'use strict'
// Sonda con YouTube de VERDAD. No forma parte de `verify` (necesita Internet y YouTube cambia sin avisar): la lanzan el flujo
// «YouTube real» del CI y, a mano, quien quiera comprobar su equipo. Usa el reproductor de producción (musicplayer.js + player/*)
// tal cual, en su ventana oculta y MUDO, y cuenta qué pasa con vídeos reales: arranque, posición, pausa, búsqueda, cambio de
// vídeo, fin de pista, errores y anuncios. No toca nada del usuario y no enseña ninguna ventana.
//
// Motor: el de producción («watch», la página de vídeo sin anuncios); con YT_ENGINE=embed, el reproductor incrustado.
//   npx electron test/youtube.js                       (con pantalla)
//   xvfb-run -a npx electron --no-sandbox test/youtube.js   (Linux sin pantalla)
const { app } = require('electron')
const { createMusicPlayer } = require('../src/main/musicplayer')

if (process.env.HUMBLECHAT_NO_SANDBOX || process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const VIDEOS = {
  zoo: 'jNQXAC9IVRw', // «Me at the zoo»: 19 s, el primer vídeo de YouTube
  rick: 'dQw4w9WgXcQ', // 3:33; el dueño NO permite incrustarlo y lleva anuncios: el caso difícil
  gangnam: '9bZkp7q19f0', // 4:12, con anuncios
  nope: 'AAAAAAAAAAA' // no existe
}

const t0 = Date.now()
const ms = () => Date.now() - t0
const log = []
const consola = []
const checks = []
const say = (...a) => console.log(String(ms()).padStart(6), ...a)
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); say(ok ? '  ✔' : '  ✘', name, detail) }

app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (e, level, message, line, source) => {
    const m = e?.message ?? message // Electron nuevo entrega un evento con los datos; el antiguo, argumentos sueltos
    consola.push(String(m).slice(0, 300))
    if (/Content Security Policy|Refused|violat|Failed to load|ERR_|Uncaught/i.test(String(m))) say('  [consola del reproductor]', String(m).slice(0, 300))
  })
  wc.on('did-fail-load', (_e, code, desc, url) => say('  [fallo de carga]', code, desc, String(url).slice(0, 120)))
})

const player = createMusicPlayer({
  engine: process.env.YT_ENGINE || undefined,
  onEvent: (e) => {
    log.push({ t: ms(), ...e })
    if (e.e !== 'tick') say('  ·', e.e, e.st, 'n=' + e.n, 'pos=' + e.pos.toFixed(1), 'dur=' + e.dur, 'vid=' + e.vid, e.ad ? 'ANUNCIO' : '', e.code !== undefined ? 'code=' + e.code : '')
  }
})

const sleep = (x) => new Promise((r) => setTimeout(r, x))
const from = () => log.length
/** Espera a un evento del reproductor (desde `since`) que cumpla `pred`; devuelve el evento o null. */
async function waitFor(pred, timeout, since = 0) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const e = log.slice(since).find(pred)
    if (e) return e
    await sleep(100)
  }
  return null
}
const load = (v, n, pos = 0, play = true) => player.command({ op: 'load', v, n, pos, play })
const lastOf = (n) => [...log].reverse().find((e) => e.n === n && e.st !== 'loading' && e.vid)

async function escenarioZoo() {
  say('— Escenario 1: «Me at the zoo» (19 s) de principio a fin')
  const since = from()
  const t = Date.now()
  await load(VIDEOS.zoo, 'zoo00001', 0, true)
  const play = await waitFor((e) => e.n === 'zoo00001' && e.st === 'playing', 30000, since)
  check('empieza a sonar', play, play ? `en ${Date.now() - t} ms` : '(no llegó a «playing»)')
  if (!play) return
  check('YouTube cuenta la duración', play.dur > 15 && play.dur < 25, 'dur=' + play.dur)
  check('el vídeo que suena es el pedido (no un anuncio)', play.vid === VIDEOS.zoo, 'vid=' + play.vid)
  const p0 = play.pos
  const tp = Date.now()
  await sleep(5000)
  const e5 = lastOf('zoo00001')
  const real = (Date.now() - tp) / 1000
  check('la posición avanza al ritmo real', e5 && Math.abs(e5.pos - p0 - real) < 2, `avanzó ${e5 ? (e5.pos - p0).toFixed(1) : '?'} s en ${real.toFixed(1)} s`)
  const end = await waitFor((e) => e.n === 'zoo00001' && e.st === 'ended', 30000, since)
  check('llega al final y lo avisa («ended»)', end, end ? `en ${((end.t - play.t) / 1000).toFixed(1)} s desde que empezó` : '')
}

async function escenarioControles() {
  say('— Escenario 2: pausa, búsqueda, cambio de vídeo y «cargar sin reproducir» con un vídeo largo')
  let since = from()
  await load(VIDEOS.rick, 'rick0001', 30, true)
  const play = await waitFor((e) => e.n === 'rick0001' && e.st === 'playing', 30000, since)
  check('el vídeo que no se deja incrustar suena igualmente', play, play ? `tardó ${play.t - (since && log[since] ? log[since].t : play.t)} ms` : '(no sonó)')
  check('arranca en la posición pedida (30 s)', play && play.pos >= 29 && play.pos < 40, play ? 'pos=' + play.pos.toFixed(1) : '(no sonó)')
  check('sin anuncios', !log.slice(since).some((e) => e.ad), '')
  if (!play) return
  check('duración de 3:33', play.dur > 205 && play.dur < 220, 'dur=' + play.dur)

  since = from()
  await player.command({ op: 'pause' })
  const pa = await waitFor((e) => e.n === 'rick0001' && e.st === 'paused', 8000, since)
  check('pausa', pa)
  const pos1 = (lastOf('rick0001') || {}).pos
  await sleep(3000)
  const pos2 = (lastOf('rick0001') || {}).pos
  check('en pausa la posición no avanza', pos1 !== undefined && Math.abs(pos2 - pos1) < 0.6, `${pos1?.toFixed(1)} → ${pos2?.toFixed(1)}`)

  since = from()
  await player.command({ op: 'play' })
  check('reanuda', await waitFor((e) => e.n === 'rick0001' && e.st === 'playing', 8000, since))

  since = from()
  const ts = Date.now()
  await player.command({ op: 'seek', pos: 100 })
  const sk = await waitFor((e) => e.n === 'rick0001' && e.st === 'playing' && e.pos >= 99.5 && e.pos < 110, 10000, since)
  check('buscar a los 100 s', sk, sk ? `listo en ${Date.now() - ts} ms (pos=${sk.pos.toFixed(1)})` : '(no llegó)')

  since = from()
  await load(VIDEOS.zoo, 'zoo00002', 0, true)
  check('cambiar a otro vídeo sonando', await waitFor((e) => e.n === 'zoo00002' && e.st === 'playing', 30000, since))

  since = from()
  await load(VIDEOS.rick, 'rick0002', 60, false)
  const cued = await waitFor((e) => e.n === 'rick0002' && e.st === 'paused' && e.pos >= 59 && e.pos < 62, 20000, since)
  check('«cargar sin reproducir» deja el vídeo en pausa en su posición (60 s)', cued, cued ? 'pos=' + cued.pos.toFixed(1) : '')
  const noPlay = log.slice(since).some((e) => e.n === 'rick0002' && e.st === 'playing')
  check('y no llega a sonar', !noPlay)
  since = from()
  await player.command({ op: 'play' })
  check('luego se reproduce con «play»', await waitFor((e) => e.n === 'rick0002' && e.st === 'playing', 10000, since))

  await player.command({ op: 'volume', vol: 40, mute: true })
  await sleep(500)
  await player.command({ op: 'stop' })
  check('parar', await waitFor((e) => e.n === null && e.st === 'none', 5000, since))
}

async function escenarioErrores() {
  say('— Escenario 3: vídeos que no se pueden reproducir')
  const since = from()
  await load(VIDEOS.nope, 'nope0001', 0, true)
  const err = await waitFor((e) => e.n === 'nope0001' && e.e === 'error', 20000, since)
  check('un vídeo que no existe da error', err && [2, 100, 101, 150].includes(err.code), err ? 'code=' + err.code : '(sin error)')
  // Los que no se dejan incrustar los da el propio YouTube: se prueban los que digan «noembed» al consultar su título
  for (const [name, v] of Object.entries({ gangnam: VIDEOS.gangnam })) {
    const meta = await player.meta(v)
    say('  meta', name, JSON.stringify(meta))
    check(`oEmbed de «${name}»`, meta.ok === true || meta.reason === 'noembed' || meta.reason === 'notfound', JSON.stringify(meta))
  }
}

async function escenarioMeta() {
  say('— Escenario 0: título, canal y miniatura (oEmbed)')
  const m = await player.meta(VIDEOS.zoo)
  say('  ', JSON.stringify(m))
  check('oEmbed da el título y el canal', m.ok && m.title && !m.unknown, JSON.stringify(m))
  const nf = await player.meta(VIDEOS.nope)
  check('oEmbed de un vídeo que no existe lo dice', nf.ok === false && nf.reason === 'notfound', JSON.stringify(nf))
  const th = await player.thumb(VIDEOS.zoo)
  check('miniatura', typeof th === 'string' && th.startsWith('data:image/jpeg;base64,'), th ? th.length + ' caracteres' : '(null)')
}

async function escenarioBusqueda() {
  say('— Escenario 4: búsqueda por nombre y listas de reproducción')
  const r = await player.search('me at the zoo')
  say('  ', r.ok ? r.items.length + ' resultados; el primero: ' + JSON.stringify(r.items[0]) : r.error)
  check('la búsqueda devuelve resultados con título y duración', r.ok && r.items.length >= 3 && r.items.every((x) => /^[\w-]{11}$/.test(x.v) && x.t), r.ok ? r.items.length + ' resultados' : r.error)
  check('«me at the zoo» está entre los primeros', r.ok && r.items.some((x) => x.v === VIDEOS.zoo))
  const l = await player.playlist('PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI') // lista pública de YouTube
  say('  ', l.ok ? l.items.length + ' vídeos en la lista' : l.error)
  check('una lista pública devuelve vídeos', l.ok && l.items.length >= 5 && l.items.every((x) => /^[\w-]{11}$/.test(x.v)), l.ok ? l.items.length + ' vídeos' : l.error)
  const bad = await player.search('   ')
  check('una búsqueda vacía da un error claro', bad.ok === false && /Escribe/.test(bad.error), JSON.stringify(bad))
}

/** Anuncios y reproducción automática: con un vídeo con publicidad y al acabar uno corto, no debe colarse nada ajeno. */
async function escenarioSinAnuncios() {
  say('— Escenario 5: sin anuncios en un vídeo de una discográfica y sin saltar solo a otro al acabar')
  let since = from()
  const t = Date.now()
  await load(VIDEOS.gangnam, 'gang0001', 0, true)
  const play = await waitFor((e) => e.n === 'gang0001' && e.st === 'playing' && !e.ad, 40000, since)
  check('empieza a sonar el vídeo con publicidad', play, play ? `en ${Date.now() - t} ms` : '')
  await sleep(25000) // el anuncio, si lo hubiera, aparece en los primeros segundos
  check('ni un solo anuncio en 25 s', !log.slice(since).some((e) => e.ad), '')
  const pos = (lastOf('gang0001') || {}).pos
  check('la posición avanza sin saltos', pos > 15 && pos < 40, 'pos=' + (pos || 0).toFixed(1))
  since = from()
  await load(VIDEOS.zoo, 'zoo00009', 15, true) // empieza a 4 s del final
  const end = await waitFor((e) => e.n === 'zoo00009' && e.st === 'ended', 30000, since)
  check('el vídeo corto acaba y lo avisa', end)
  since = from()
  await sleep(12000)
  const other = log.slice(since).find((e) => e.vid && e.vid !== VIDEOS.zoo && e.st === 'playing')
  check('al acabar no salta solo a otro vídeo', !other, other ? 'vid=' + other.vid : '')
  await player.command({ op: 'stop' })
}

async function main() {
  say('Electron', process.versions.electron, 'Chromium', process.versions.chrome, process.platform)
  await player.command({ op: 'volume', vol: 0, mute: true }) // la sonda nunca suena
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)
  const run = (n, f) => (!only || only.split(',').includes(n) ? f() : null)
  await run('meta', escenarioMeta)
  await run('zoo', escenarioZoo)
  await run('controles', escenarioControles)
  await run('errores', escenarioErrores)
  await run('busqueda', escenarioBusqueda)
  await run('anuncios', escenarioSinAnuncios)
  const bad = checks.filter((c) => !c.ok)
  say(`\nRESULTADO: ${checks.length - bad.length}/${checks.length} comprobaciones bien`)
  for (const c of bad) say('  FALLA:', c.name, c.detail)
  if (process.env.YT_PROBE_DUMP) require('fs').writeFileSync(process.env.YT_PROBE_DUMP, JSON.stringify({ checks, log, consola }, null, 1))
  player.dispose()
  app.exit(bad.length ? 1 : 0)
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2) })
setTimeout(() => { console.error('SONDA: tiempo agotado'); app.exit(3) }, 8 * 60 * 1000).unref()
