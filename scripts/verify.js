#!/usr/bin/env node
// Verificación única del proyecto (la usan el CI, los hooks de Claude y las personas).
//   npm run verify          todo (Linux: núcleo, humo, e2e, e2e2 · Windows: núcleo, humo, contenido)
//   npm run verify:quick    núcleo + prueba de humo (~15 s)
// Sin pantalla en Linux se relanza cada paso con xvfb-run. Sale con código distinto de 0 si algo falla.
'use strict'
const { spawnSync } = require('child_process')
const path = require('path')

const quick = process.argv.includes('--quick')
const win = process.platform === 'win32'
const linux = process.platform === 'linux'
const needXvfb = linux && !process.env.DISPLAY
const root = path.join(__dirname, '..')

const steps = [
  { name: 'Núcleo P2P', cmd: ['npm', 'test'], gui: false },
  { name: 'Prueba de humo', cmd: ['npm', 'run', 'test:smoke'], gui: true },
]
if (!quick) {
  if (linux) {
    steps.push({ name: 'Interfaz completa, 3 instancias', cmd: ['npm', 'run', 'test:e2e'], gui: true })
    steps.push({ name: 'Contenido, audio y voz con relé', cmd: ['npm', 'run', 'test:e2e2'], gui: true })
  } else {
    steps.push({ name: 'Contenido de la interfaz', cmd: ['node', 'test/e2e2.js', 'contenido'], gui: true })
  }
}

const results = []
for (const s of steps) {
  let [cmd, ...args] = s.cmd
  if (s.gui && needXvfb) { args = ['-a', '-s', '-screen 0 1920x1080x24', cmd, ...args]; cmd = 'xvfb-run' }
  const t = Date.now()
  console.log(`\n=== ${s.name} ===`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: win })
  const ok = r.status === 0
  results.push({ name: s.name, ok, secs: Math.round((Date.now() - t) / 1000) })
  if (!ok) break // el primer fallo basta: el resto depende de lo anterior
}

console.log('\n--- Resumen ---')
for (const r of results) console.log(`${r.ok ? 'OK   ' : 'FALLO'} ${r.name} (${r.secs}s)`)
const failed = results.some((r) => !r.ok)
console.log(failed ? 'VERIFY FALLO' : 'VERIFY OK')
process.exit(failed ? 1 : 0)
