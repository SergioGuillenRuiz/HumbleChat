'use strict'
// Sonda con YouTube de VERDAD. No forma parte de `verify` (necesita Internet y YouTube cambia sin avisar): la lanzan el flujo
// «YouTube real» del CI y, a mano, quien quiera comprobar su equipo. Usa el reproductor de producción (musicplayer.js + player/*)
// tal cual, en su ventana oculta y MUDO, y cuenta qué pasa con vídeos reales: arranque, posición, pausa, búsqueda, cambio de
// vídeo, fin de pista, errores y anuncios. No toca nada del usuario y no enseña ninguna ventana.
//
//   npx electron test/youtube.js                       (con pantalla)
//   xvfb-run -a npx electron --no-sandbox test/youtube.js   (Linux sin pantalla)
const { app } = require('electron')
const { createMusicPlayer } = require('../src/main/musicplayer')
const { searchVideos, playlistVideos } = require('../src/main/ytsearch')

if (process.env.HUMBLECHAT_NO_SANDBOX || process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const VIDEOS = {
  zoo: 'jNQXAC9IVRw', // «Me at the zoo»: 19 s, el primer vídeo de YouTube
  rick: 'dQw4w9WgXcQ', // 3:33
  gangnam: '9bZkp7q19f0',
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
  onEvent: (e) => {
    log.push({ t: ms(), ...e })
    if (e.e !== 'tick') say('  ·', e.e, e.st, 'n=' + e.n, 'pos=' + e.pos.toFixed(1), 'dur=' + e.dur, 'vid=' + e.vid, e.code !== undefined ? 'code=' + e.code : '')
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
  check('arranca en la posición pedida (30 s)', play && play.pos >= 29 && play.pos < 40, play ? 'pos=' + play.pos.toFixed(1) : '(no sonó)')
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
  check('un vídeo que no existe da error 100 (o 2)', err && (err.code === 100 || err.code === 2), err ? 'code=' + err.code : '(sin error)')
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
  const net = (await import('electron')).net
  const f = (u, o) => net.fetch(u, o)
  try {
    const r = await searchVideos('me at the zoo', f)
    say('  ', r.length, 'resultados; el primero:', JSON.stringify(r[0]))
    check('la búsqueda devuelve resultados con título y duración', r.length >= 3 && r.every((x) => /^[\w-]{11}$/.test(x.v) && x.t), r.length + ' resultados')
    check('«me at the zoo» está entre los primeros', r.some((x) => x.v === VIDEOS.zoo))
  } catch (e) { check('búsqueda', false, String(e.message || e)) }
  try {
    const r = await playlistVideos('PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', f) // lista pública de YouTube
    say('  ', r.length, 'vídeos en la lista')
    check('una lista pública devuelve vídeos', r.length >= 5 && r.every((x) => /^[\w-]{11}$/.test(x.v)), r.length + ' vídeos')
  } catch (e) { check('lista de reproducción', false, String(e.message || e)) }
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
  const bad = checks.filter((c) => !c.ok)
  say(`\nRESULTADO: ${checks.length - bad.length}/${checks.length} comprobaciones bien`)
  for (const c of bad) say('  FALLA:', c.name, c.detail)
  if (process.env.YT_PROBE_DUMP) require('fs').writeFileSync(process.env.YT_PROBE_DUMP, JSON.stringify({ checks, log, consola }, null, 1))
  player.dispose()
  app.exit(bad.length ? 1 : 0)
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2) })
setTimeout(() => { console.error('SONDA: tiempo agotado'); app.exit(3) }, 8 * 60 * 1000).unref()
