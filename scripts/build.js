#!/usr/bin/env node
// Compila la aplicación.   node scripts/build.js <win|linux|all> [--public]
//   win     instalador NSIS (solo en Windows), .exe portable y .zip
//   linux   AppImage y paquete .pacman
//   all     Linux + portable y zip de Windows (para compilar todo desde Linux)
//   --public  sin la llave de sala dentro (la app la pide al abrirse): es la versión que se publica en GitHub.
'use strict'
const { spawnSync } = require('child_process')
const path = require('path')

const [target = 'all', ...flags] = process.argv.slice(2)
const env = { ...process.env, ...(flags.includes('--public') ? { HUMBLECHAT_PUBLIC: '1' } : {}) }
const root = path.join(__dirname, '..')

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status || 1)
}

run(process.execPath, [path.join(__dirname, 'ensure-key.js')])
const builder = ['electron-builder', '--config', 'electron-builder.config.js']
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
if (target === 'win') run(npx, [...builder, '--win'])
else if (target === 'linux') run(npx, [...builder, '--linux'])
else run(npx, [...builder, '--linux', 'AppImage', 'pacman', '--win', 'portable', 'zip'])
