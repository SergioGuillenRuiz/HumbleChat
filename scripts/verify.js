#!/usr/bin/env node
// Verificación única del proyecto (la usan el CI, los hooks de Claude y las personas).
//   npm run verify          todo (Linux: núcleo, humo, e2e, e2e2 · Windows: núcleo, humo, contenido)
//   npm run verify:quick    núcleo + prueba de humo (~15 s)
// Sin pantalla en Linux se relanza cada paso con xvfb-run. Sale con código distinto de 0 si algo falla.
'use strict'
const path = require('path')

const quick = process.argv.includes('--quick')
const win = process.platform === 'win32'
const linux = process.platform === 'linux'
const needXvfb = linux && !process.env.DISPLAY
const root = path.join(__dirname, '..')

const steps = [
  { name: 'Lint', cmd: ['npm', 'run', 'lint'], gui: false },
  { name: 'Núcleo P2P', cmd: ['npm', 'test'], gui: false },
  { name: 'Prueba de humo', cmd: ['npm', 'run', 'test:smoke'], gui: true },
  { name: 'Bloqueo por versión obsoleta', cmd: ['npm', 'run', 'test:gate'], gui: true },
]
if (!quick) {
  if (linux) {
    steps.push({ name: 'Interfaz completa, 3 instancias', cmd: ['npm', 'run', 'test:e2e'], gui: true })
    steps.push({ name: 'Contenido, audio y voz con relé y túnel', cmd: ['npm', 'run', 'test:e2e2'], gui: true })
  } else {
    steps.push({ name: 'Contenido de la interfaz', cmd: ['node', 'test/e2e2.js', 'contenido'], gui: true })
    steps.push({ name: 'Voz y cámara por el túnel P2P', cmd: ['node', 'test/e2e2.js', 'tunel'], gui: true })
    steps.push({ name: 'Varias salas', cmd: ['node', 'test/e2e2.js', 'salas'], gui: true })
  }
}

// Cada paso se emite en directo y se guarda en test-results/ (el CI lo sube como artefacto si algo falla).
const fs = require('fs')
const { spawn } = require('child_process')
const outDir = path.join(root, 'test-results')
fs.mkdirSync(outDir, { recursive: true })

// Un paso colgado no debe dejar el CI esperando horas: pasado el límite se mata (con todo lo que haya lanzado) y cuenta como fallo.
const STEP_MS = Number(process.env.VERIFY_STEP_MS) || 12 * 60 * 1000

function killTree(child) {
  try {
    if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {}
}

function run(cmd, args, file) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(file)
    const child = spawn(cmd, args, { cwd: root, shell: win, stdio: ['ignore', 'pipe', 'pipe'], detached: !win })
    const tee = (chunk, out) => { out.write(chunk); log.write(chunk) }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      tee(`\n[verify] el paso lleva más de ${Math.round(STEP_MS / 60000)} min sin terminar: se interrumpe (parece un cuelgue)\n`, process.stderr)
      killTree(child)
    }, STEP_MS)
    child.stdout.on('data', (c) => tee(c, process.stdout))
    child.stderr.on('data', (c) => tee(c, process.stderr))
    child.on('error', (e) => { clearTimeout(timer); tee(`No se pudo ejecutar ${cmd}: ${e.message}\n`, process.stderr); log.end(); resolve(1) })
    child.on('close', (code) => { clearTimeout(timer); log.end(() => resolve(timedOut ? 124 : code)) })
  })
}

;(async () => {
  const results = []
  for (const [i, s] of steps.entries()) {
    let [cmd, ...args] = s.cmd
    if (s.gui && needXvfb) { args = ['-a', '-s', '-screen 0 1920x1080x24', cmd, ...args]; cmd = 'xvfb-run' }
    const t = Date.now()
    console.log(`\n=== ${s.name} ===`)
    const code = await run(cmd, args, path.join(outDir, `${i + 1}-${s.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_')}.log`))
    results.push({ name: s.name, ok: code === 0, secs: Math.round((Date.now() - t) / 1000) })
    if (code !== 0) break // el primer fallo basta: el resto depende de lo anterior
  }

  console.log('\n--- Resumen ---')
  for (const r of results) console.log(`${r.ok ? 'OK   ' : 'FALLO'} ${r.name} (${r.secs}s)`)
  const failed = results.some((r) => !r.ok)
  console.log(failed ? 'VERIFY FALLO' : 'VERIFY OK')
  process.exit(failed ? 1 : 0)
})()
