#!/usr/bin/env node
// Crea `group.key` (la "llave de la sala") si no existe.
//
// Esa llave es lo único que identifica a tu grupo de amigos: de ella salen el
// tema de la DHT donde os encontráis y la prueba de pertenencia que se exige a
// cada conexión. Va dentro del instalador que construyas, así que los amigos no
// tocan nada. NO se sube al repo (está en .gitignore).
//
// Si compilas para Windows en una máquina y para Linux en otra, copia el mismo
// `group.key` a las dos, o no os veréis.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const file = path.join(__dirname, '..', 'group.key')
if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim().length >= 32) process.exit(0)

fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
console.log('\n[humblechat] Se ha generado una llave de grupo nueva: group.key')
console.log('[humblechat] Guárdala: quien tenga esta llave entra en vuestra sala; quien no, no.')
console.log('[humblechat] Para compilar en otro sistema operativo, copia este mismo archivo allí.\n')
