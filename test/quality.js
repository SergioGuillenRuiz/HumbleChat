'use strict'
// Banco de medidas de calidad (no es una prueba pasa/no pasa): bitrate real de audio y rendimiento del
// vídeo de pantalla por códec, con captura REAL de pantalla y CPU de cada proceso.
//   xvfb-run -a -s "-screen 0 1920x1080x24" node test/quality.js audio|video
const fs = require('fs')
const path = require('path')
const { startNet, launch, sleep, waitFor } = require('./lib')

const mode = process.argv[2] || 'audio'
const WAV = process.env.WAV || path.join(__dirname, '..', 'test', 'voice-like.wav')

const procTicks = (rootPid) => {
  const rows = {}
  for (const d of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
      const rest = st.slice(st.lastIndexOf(')') + 2).split(' ')
      rows[d] = { ppid: rest[1], ticks: Number(rest[11]) + Number(rest[12]) }
    } catch {}
  }
  let total = 0
  const walk = (pid) => { if (rows[pid]) total += rows[pid].ticks; for (const [k, r] of Object.entries(rows)) if (r.ppid === String(pid)) walk(k) }
  walk(rootPid)
  return total
}

// Xvfb: la lista de pantallas a veces llega vacía; se reintenta todo el gesto.
async function startShare(p) {
  for (let i = 0; i < 4; i++) {
    await p.page.locator('.round[aria-label="Compartir pantalla"]').click()
    const card = p.page.locator('.src-card').first()
    if (await card.waitFor({ timeout: 15000 }).then(() => true, () => false)) {
      await card.click()
      if (await p.page.locator('.tile-live').first().waitFor({ timeout: 12000 }).then(() => true, () => false)) return
    }
    await p.page.keyboard.press('Escape')
    await sleep(1500)
  }
  throw new Error('no se pudo empezar a compartir')
}

const diag = (p) => p.page.evaluate(async () => (await import('/voice.js')).diagnostics())

async function audio() {
  const net = await startNet()
  const env = { HUMBLECHAT_FAKE_AUDIO_FILE: WAV }
  const a = await launch(net, 'A', { env })
  const b = await launch(net, 'B', { env })
  await waitFor(async () => (await b.page.locator('.member:not(.offline)').count()) === 2, 25000, 'se ven')
  for (const p of [a, b]) await p.page.locator('.vch .ch', { hasText: 'General' }).click()
  await waitFor(async () => (await a.page.locator('.vuser').count()) === 2, 10000, 'sala')
  for (const abr of [null, 32000, 64000, 96000]) {
    await a.page.evaluate((v) => { localStorage.setItem('hc.dbg', JSON.stringify(v ? { audioBitrate: v } : {})) }, abr)
    // recargar el estado de calidad: forzar un tune() rehaciendo la llamada
    await a.page.locator('.cp-top .icon-btn').click()
    await sleep(400)
    await a.page.locator('.vch .ch', { hasText: 'General' }).click()
    await waitFor(async () => (await a.page.locator('.vuser').count()) === 2, 10000, 'vuelve')
    await sleep(7000)
    await diag(a)
    await sleep(6000)
    const d = (await diag(a))[0]
    console.log(`audio ↑ con maxBitrate=${abr ?? 'por defecto de la app (64k)'}: ${d.audioOut.codec} ${d.audioOut.kbps} kbps · ping ${d.rtt} ms · ${d.path}`)
  }
  await a.app.close(); await b.app.close(); await net.testnet.destroy()
}

async function video() {
  const net = await startNet()
  const a = await launch(net, 'Sharer', { fakeMedia: false, size: [800, 600], env: { HUMBLECHAT_HIDDEN: '1' } })
  const b = await launch(net, 'Viewer', { fakeMedia: false, size: [1920, 1080] })
  await b.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ x: 0, y: 0, width: 1920, height: 1080 }) })
  // Contenido realista: fondo de editor estático + código que se desplaza (izquierda) + zona tipo "juego" (derecha).
  // Cambia ~40 % de los píxeles en cada fotograma, que ya es mucho para pantalla compartida.
  await b.page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080
    Object.assign(c.style, { position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'none' }); document.body.append(c)
    const g = c.getContext('2d'); let t = 0
    g.fillStyle = '#1e1f22'; g.fillRect(0, 0, 1920, 1080)
    g.fillStyle = '#2b2d31'; g.fillRect(0, 0, 1920, 90); g.fillRect(1000, 100, 860, 860)
    const lines = Array.from({ length: 200 }, (_, i) => `const resultado${i} = calcular(${i}, "texto ${i * 7}") // comentario ${i}`)
    const tick = () => {
      t += 1
      g.fillStyle = '#313338'; g.fillRect(40, 100, 800, 900)
      g.font = '16px monospace'; g.fillStyle = '#dbdee1'
      for (let i = 0; i < 50; i++) g.fillText(lines[(i + Math.floor(t / 2)) % 200], 50, 120 + i * 18 - (t % 2) * 9)
      const gr = g.createLinearGradient(1010, 110, 1010, 700); gr.addColorStop(0, `hsl(${(t * 2) % 360},50%,30%)`); gr.addColorStop(1, `hsl(${(t * 2 + 120) % 360},60%,20%)`)
      g.fillStyle = gr; g.fillRect(1010, 110, 840, 640)
      for (let i = 0; i < 14; i++) { g.fillStyle = `hsl(${i * 25 + t * 3},85%,60%)`; g.beginPath(); g.arc(1010 + ((t * (3 + i) + i * 90) % 800), 130 + ((t * (2 + i % 5) + i * 70) % 600), 28 + i, 0, 7); g.fill() }
      requestAnimationFrame(tick)
    }
    tick()
  })
  await waitFor(async () => (await b.page.locator('.member:not(.offline)').count()) === 2, 25000, 'se ven')
  for (const p of [a, b]) await p.page.locator('.vch .ch', { hasText: 'General' }).click()
  await waitFor(async () => (await a.page.locator('.vuser').count()) === 2, 10000, 'sala')
  const only = process.env.CODECS ? process.env.CODECS.split(',') : ['video/VP8', 'video/VP9', 'video/H264', 'video/AV1']
  const presets = process.env.PRESETS ? process.env.PRESETS.split(',') : ['fluid', 'sharp']
  for (const preset of presets) for (const codec of only) {
    await a.page.evaluate((cfg) => { localStorage.setItem('hc.dbg', JSON.stringify({ codec: cfg.codec, ...cfg.dbg })); localStorage.setItem('hc.preset', JSON.stringify(cfg.preset)) }, { codec, preset, dbg: JSON.parse(process.env.DBG || '{}') })
    await startShare(a)
    await waitFor(async () => (await b.page.locator('.tile-watch').count()) > 0, 20000, 'live')
    await b.page.locator('.tile-watch').click()
    await waitFor(() => b.page.evaluate(() => { const v = document.querySelector('.theater video'); return !!v && v.videoWidth > 0 }), 20000, 'vídeo')
    await sleep(8000) // dejar que el estimador de ancho de banda suba
    await diag(a); const c0 = [procTicks(a.app.process().pid), procTicks(b.app.process().pid)]
    await sleep(8000)
    const d = (await diag(a))[0]; const c1 = [procTicks(a.app.process().pid), procTicks(b.app.process().pid)]
    const v = d.videoOut
    const cpu = (i) => (((c1[i] - c0[i]) / 100 / 8) * 100).toFixed(0)
    console.log(`${preset.padEnd(5)} ${codec.padEnd(10)} → ${v?.codec} ${v?.w}x${v?.h} @${v?.fps}fps ${v?.kbps} kbps${v?.limit ? ' (limitado: ' + v.limit + ')' : ''} · CPU emisor ${cpu(0)}% receptor ${cpu(1)}% (100% = 1 núcleo)`)
    await a.page.locator('.round.on').click()
    await waitFor(async () => (await b.page.locator('.theater').count()) === 0, 10000, 'cortado')
    await sleep(1500)
  }
  await a.app.close(); await b.app.close(); await net.testnet.destroy()
}

;(mode === 'video' ? video() : audio()).then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
