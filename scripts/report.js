#!/usr/bin/env node
// Informe de diagnóstico de un clic para pegar en el chat:   npm run report
'use strict'
const os = require('os')
const { execSync } = require('child_process')
const { checkNat, EXPLAIN } = require('../src/core/natcheck')

const sh = (c) => { try { return execSync(c, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '(no disponible)' } }
;(async () => {
  const pkg = require('../package.json')
  const nat = await checkNat().catch((e) => ({ type: 'error: ' + e.message }))
  const out = {
    app: pkg.version, node: process.version, so: `${os.type()} ${os.release()} ${os.arch()}`,
    sesion: process.env.XDG_SESSION_TYPE || process.platform,
    nat: nat.type, nat_explicacion: EXPLAIN[nat.type] || '',
    audio: process.platform === 'linux' ? sh('pactl info | grep -E "Default (Sink|Source)"') : '(solo Linux)',
    camaras: process.platform === 'linux' ? sh('ls /dev/video* 2>/dev/null') : '(solo Linux)',
  }
  console.log(JSON.stringify(out, null, 2))
})()
