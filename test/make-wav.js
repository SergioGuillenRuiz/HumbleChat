'use strict'
// Genera test/voice-like.wav: señal "tipo voz" (portadora con vibrato + armónicos + ruido) de 40 s a 48 kHz.
// Obliga a Opus a usar su bitrate objetivo, y así se puede medir (el pitido por defecto de Chromium es casi silencio).
const fs = require('fs')
const path = require('path')

function makeWav(file) {
  const sr = 48000
  const n = sr * 40
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  let seed = 1
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1 }
  let lp = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const f0 = 140 + 25 * Math.sin(2 * Math.PI * 5 * t) + 30 * Math.sin(2 * Math.PI * 0.7 * t)
    const env = 0.5 * (1 + Math.sin(2 * Math.PI * 3.3 * t))
    const ph = 2 * Math.PI * f0 * t
    let sum = 0
    for (let k = 1; k < 16; k++) sum += Math.sin(k * ph + 0.3 * k) / k
    lp = 0.85 * lp + 0.15 * rnd()
    const x = env * sum * 0.35 * 0.6 + 0.25 * lp
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x * 0.8)) * 32767), 44 + i * 2)
  }
  fs.writeFileSync(file, buf)
}

const file = path.join(__dirname, 'voice-like.wav')
if (!fs.existsSync(file)) makeWav(file)
module.exports = { file }
if (require.main === module) console.log(file)
