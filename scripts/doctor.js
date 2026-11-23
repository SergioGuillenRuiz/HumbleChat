#!/usr/bin/env node
// Comprueba si tu red permite la voz directa con tus amigos:   node scripts/doctor.js
'use strict'
const { checkNat, EXPLAIN } = require('../src/core/natcheck')

checkNat().then((r) => {
  console.log('Tipo de red (NAT):', { cone: 'cono (bueno)', symmetric: 'simétrico (problemático)', unknown: 'desconocido', blocked: 'UDP bloqueado' }[r.type])
  console.log(EXPLAIN[r.type])
  process.exit(r.type === 'blocked' ? 1 : 0)
})
