#!/usr/bin/env node
// Mide la estabilidad de una prueba: la repite N veces y cuenta los fallos.
//   node scripts/flaky.js <nombre> <repeticiones> -- <comando> [args…]
//   node scripts/flaky.js humo 20 -- node test/smoke.js
// Escribe una tabla en $GITHUB_STEP_SUMMARY (si existe) y guarda en test-results/flaky/ el registro de cada
// ejecución fallida. Sale con código 1 si falló alguna repetición.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const sep = process.argv.indexOf('--')
const [name, reps] = process.argv.slice(2, sep)
const cmd = process.argv.slice(sep + 1)
const n = Number(reps)
if (sep < 0 || !name || !Number.isInteger(n) || n < 1 || !cmd.length) {
  console.error('Uso: node scripts/flaky.js <nombre> <repeticiones> -- <comando> [args…]')
  process.exit(2)
}

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'test-results', 'flaky')
fs.mkdirSync(outDir, { recursive: true })
const needXvfb = process.platform === 'linux' && !process.env.DISPLAY
const win = process.platform === 'win32'

function once(i) {
  return new Promise((resolve) => {
    const [c, ...a] = needXvfb ? ['xvfb-run', '-a', '-s', '-screen 0 1920x1080x24', ...cmd] : cmd
    const t0 = Date.now()
    const chunks = []
    const child = spawn(c, a, { cwd: root, shell: win })
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => chunks.push(d))
    child.on('error', (e) => { chunks.push(Buffer.from(String(e))); resolve({ ok: false, ms: Date.now() - t0, chunks }) })
    child.on('close', (code) => resolve({ ok: code === 0, ms: Date.now() - t0, chunks }))
  })
}

;(async () => {
  const rows = []
  for (let i = 1; i <= n; i++) {
    const r = await once(i)
    rows.push({ i, ok: r.ok, secs: Math.round(r.ms / 1000) })
    console.log(`${name} #${i}/${n}: ${r.ok ? 'OK' : 'FALLO'} (${Math.round(r.ms / 1000)} s)`)
    if (!r.ok) fs.writeFileSync(path.join(outDir, `${name}-${i}.log`), Buffer.concat(r.chunks))
  }
  const fails = rows.filter((r) => !r.ok)
  const secs = rows.map((r) => r.secs).sort((a, b) => a - b)
  const line = `**${name}** (${process.platform}): ${n - fails.length}/${n} correctas (${((100 * fails.length) / n).toFixed(1)} % de fallos) · duración mediana ${secs[Math.floor(secs.length / 2)]} s, máxima ${secs[secs.length - 1]} s` +
    (fails.length ? ` · fallaron las repeticiones ${fails.map((f) => f.i).join(', ')}` : '')
  console.log('\n' + line)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n\n')
  process.exit(fails.length ? 1 : 0)
})()
