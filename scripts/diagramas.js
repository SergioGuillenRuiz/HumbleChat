'use strict'
// Genera los diagramas del README (docs/*.svg). Sin dependencias: `node scripts/diagramas.js`.
// Son tarjetas con fondo propio, para que se vean bien tanto en el tema claro como en el oscuro de GitHub.
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, '..', 'docs')
const C = { brand: '#5865f2', soft: '#9aa4ff', text: '#e8ebff', mute: '#b4baea', green: '#3ba55d', orange: '#faa61a', red: '#ed4245', teal: '#1abc9c', pink: '#eb459e', card: 'rgba(255,255,255,0.045)', edge: 'rgba(255,255,255,0.12)' }
const PEOPLE = [['Ana', '#5865f2'], ['Beto', '#3ba55d'], ['Carla', '#faa61a'], ['Dani', '#eb459e'], ['Eva', '#1abc9c']]
const pent = (cx, cy, r) => PEOPLE.map((_, i) => [cx + r * Math.cos((-90 + 72 * i) * Math.PI / 180), cy + r * Math.sin((-90 + 72 * i) * Math.PI / 180)])
const f = (n) => Math.round(n * 10) / 10

const head = (w, h, title, desc) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${title}</title><desc id="d">${desc}</desc>
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d1026"/><stop offset="1" stop-color="#1c2148"/></linearGradient>
  <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#5865f2" stop-opacity=".35"/><stop offset="1" stop-color="#5865f2" stop-opacity="0"/></radialGradient>
  <linearGradient id="cloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#454b94"/><stop offset="1" stop-color="#2b3070"/></linearGradient>
  <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity=".45"/></filter>
  <marker id="arrow" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="20" markerHeight="20" orient="auto"><path d="M0 0 10 5 0 10z" fill="${C.orange}"/></marker>
  <style>
    text{font-family:'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif}
    .title{font-size:30px;font-weight:700;fill:#fff}
    .h{font-size:27px;font-weight:700;fill:#fff}
    .cap{font-size:21px;fill:${C.mute}}
    .name{font-size:22px;font-weight:600;fill:${C.text};paint-order:stroke;stroke:#12163a;stroke-width:5px;stroke-linejoin:round}
    .ini{font-size:30px;font-weight:700;fill:#fff}
    .small{font-size:19px;fill:${C.text}}
    .leg{font-size:19px;fill:${C.mute}}
  </style>
</defs>
<rect width="${w}" height="${h}" rx="26" fill="url(#bg)"/>
<circle cx="${w * 0.5}" cy="${h * 0.45}" r="${h * 0.55}" fill="url(#glow)" opacity=".5"/>
`

const panel = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${C.card}" stroke="${C.edge}"/>`
const badge = (x, y, n, label) => `<circle cx="${x}" cy="${y}" r="20" fill="${C.brand}"/><text x="${x}" y="${y + 8}" text-anchor="middle" class="ini" style="font-size:22px">${n}</text><text x="${x + 34}" y="${y + 9}" class="h">${label}</text>`
const lines = (x, y, arr, cls = 'cap', dy = 29) => arr.map((t, i) => `<text x="${x}" y="${y + i * dy}" text-anchor="middle" class="${cls}">${t}</text>`).join('')

const avatar = (cx, cy, i, r = 34, disk = false, above = false) => {
  const [name, color] = PEOPLE[i]
  return `<g><circle cx="${cx}" cy="${cy}" r="${r + 10}" fill="${color}" opacity=".35" filter="url(#blur)"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="#fff" stroke-opacity=".85" stroke-width="3" filter="url(#shadow)"/>
<text x="${cx}" y="${cy + 10}" text-anchor="middle" class="ini" style="font-size:${r > 30 ? 30 : 24}px">${name[0]}</text>
<text x="${cx}" y="${above ? cy - r - 16 : cy + r + 28}" text-anchor="middle" class="name">${name}</text>${disk ? cylinder(cx + r * 0.78, cy + r * 0.78) : ''}</g>`
}

// Disco de historial: cada equipo guarda su copia
const cylinder = (x, y) => `<g transform="translate(${f(x)} ${f(y)})" filter="url(#shadow)"><rect x="-13" y="-11" width="26" height="24" rx="4" fill="#2b3070" stroke="${C.soft}" stroke-width="2"/><ellipse cx="0" cy="-11" rx="13" ry="5.5" fill="#454b94" stroke="${C.soft}" stroke-width="2"/><path d="M-13 0.5Q0 7 13 0.5" fill="none" stroke="${C.soft}" stroke-width="1.8"/></g>`

const lock = (x, y) => `<g transform="translate(${x} ${y})" filter="url(#shadow)"><circle r="31" fill="#14173a" stroke="${C.brand}" stroke-width="3"/><rect x="-12" y="-3" width="24" height="19" rx="4" fill="${C.soft}"/><path d="M-7 -3V-9a7 7 0 0 1 14 0V-3" fill="none" stroke="${C.soft}" stroke-width="4" stroke-linecap="round"/><circle cy="6" r="2.8" fill="#14173a"/></g>`

// ───────────── Diagrama 1: la sala ─────────────
function malla() {
  const W = 1200
  const H = 800
  let s = head(W, H, 'Cómo se conecta una sala de HumbleChat', 'Tres pasos: los equipos preguntan a un directorio público quién más está en la sala; después cada equipo se conecta directamente con todos los demás formando una malla cifrada; y cada mensaje se reenvía por la malla y cada equipo guarda su copia, de modo que llega aunque dos equipos no puedan conectar entre sí.')
  s += `<text x="${W / 2}" y="62" text-anchor="middle" class="title">Una sala: todos conectados con todos, sin servidor en medio</text>`
  const px = [24, 420, 816]
  px.forEach((x) => { s += panel(x, 100, 360, 600) })

  // 1 · Encontrarse
  s += badge(60, 146, 1, 'Encontrarse')
  s += `<g transform="translate(204 268)" filter="url(#shadow)"><circle cx="-38" cy="6" r="34" fill="url(#cloud)" stroke="${C.soft}" stroke-width="2.5"/><circle cx="6" cy="-14" r="46" fill="url(#cloud)" stroke="${C.soft}" stroke-width="2.5"/><circle cx="48" cy="8" r="32" fill="url(#cloud)" stroke="${C.soft}" stroke-width="2.5"/><rect x="-72" y="6" width="150" height="34" rx="17" fill="url(#cloud)"/><rect x="-66" y="-2" width="138" height="40" fill="url(#cloud)"/>
<text x="3" y="12" text-anchor="middle" class="h" style="font-size:24px">Directorio</text></g>`
  s += `<text x="204" y="338" text-anchor="middle" class="small" style="font-weight:600">público y abierto</text>`
  const ax = [72, 138, 204, 270, 336]
  ax.forEach((x, i) => { s += `<line x1="${x}" y1="470" x2="${204 + (x - 204) * 0.28}" y2="${356}" stroke="${C.soft}" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round" opacity=".85"/>` })
  s += `<g><rect x="62" y="396" width="284" height="40" rx="20" fill="#1c2150" stroke="${C.brand}" stroke-width="2"/><text x="204" y="423" text-anchor="middle" class="small">«¿quién más está en esta sala?»</text></g>`
  ax.forEach((x, i) => { s += avatar(x, 500, i, 25) })
  s += lines(204, 588, ['Solo sirve para encontrarse.', 'No ve mensajes, voz ni vídeo.'])

  // 2 · Malla completa
  s += badge(456, 146, 2, 'Malla completa')
  const m = pent(600, 372, 128)
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) s += `<line x1="${f(m[i][0])}" y1="${f(m[i][1])}" x2="${f(m[j][0])}" y2="${f(m[j][1])}" stroke="#7f8aff" stroke-width="4" stroke-linecap="round" opacity=".8"/>`
  s += lock(600, 384)
  m.forEach(([x, y], i) => { s += avatar(x, y, i, 34) })
  s += lines(600, 588, ['Cada equipo se conecta con todos', 'los demás: cifrado y sin nadie en medio.'])

  // 3 · Todos guardan copia
  s += badge(852, 146, 3, 'Todos guardan copia')
  const n = pent(996, 372, 128)
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
    if ((i === 0 && j === 2)) continue // Ana ✕ Carla: no pueden conectar
    s += `<line x1="${f(n[i][0])}" y1="${f(n[i][1])}" x2="${f(n[j][0])}" y2="${f(n[j][1])}" stroke="#7f8aff" stroke-width="4" stroke-linecap="round" opacity=".42"/>`
  }
  const mid = [(n[0][0] + n[2][0]) / 2, (n[0][1] + n[2][1]) / 2]
  s += `<line x1="${f(n[0][0])}" y1="${f(n[0][1])}" x2="${f(n[2][0])}" y2="${f(n[2][1])}" stroke="${C.red}" stroke-width="4" stroke-dasharray="9 9" stroke-linecap="round" opacity=".9"/>`
  s += `<g transform="translate(${f(mid[0])} ${f(mid[1])})"><circle r="17" fill="#2a1318" stroke="${C.red}" stroke-width="3"/><path d="M-6 -6 6 6M6 -6-6 6" stroke="${C.red}" stroke-width="3.5" stroke-linecap="round"/></g>`
  // camino alternativo Ana → Beto → Carla
  const trim = (a, b, k) => { const dx = b[0] - a[0]; const dy = b[1] - a[1]; const d = Math.hypot(dx, dy); return [[a[0] + dx * k / d, a[1] + dy * k / d], [b[0] - dx * k / d, b[1] - dy * k / d]] }
  for (const [a, b] of [[0, 1], [1, 2]]) {
    const [p, q] = trim(n[a], n[b], 52)
    s += `<line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(q[0])}" y2="${f(q[1])}" stroke="${C.orange}" stroke-width="6" stroke-linecap="round" marker-end="url(#arrow)"/>`
  }
  n.forEach(([x, y], i) => { s += avatar(x, y, i, 34, true) })
  s += `<g><rect x="${f(n[0][0] + 44)}" y="${f(n[0][1] - 58)}" width="92" height="40" rx="20" fill="${C.orange}"/><path d="M${f(n[0][0] + 44)} ${f(n[0][1] - 30)}l-6 9 14-3z" fill="${C.orange}"/><text x="${f(n[0][0] + 90)}" y="${f(n[0][1] - 31)}" text-anchor="middle" class="small" style="font-weight:700;fill:#2a1a00">«hola»</text></g>`
  s += lines(996, 588, ['Si dos equipos no pueden conectar,', 'un amigo reenvía el mensaje.', 'Cada uno guarda su copia.'])

  // leyenda
  const ly = 748
  const items = [
    [`<line x1="0" y1="0" x2="40" y2="0" stroke="#7f8aff" stroke-width="4" stroke-linecap="round"/>`, 'Conexión directa cifrada', 40],
    [`<line x1="0" y1="0" x2="40" y2="0" stroke="${C.soft}" stroke-width="3" stroke-dasharray="3 9" stroke-linecap="round"/>`, 'Solo para encontrarse', 350],
    [`<line x1="0" y1="0" x2="40" y2="0" stroke="${C.orange}" stroke-width="6" stroke-linecap="round"/>`, 'Reenvío por un amigo', 640],
    [`<line x1="0" y1="0" x2="40" y2="0" stroke="${C.red}" stroke-width="4" stroke-dasharray="9 9" stroke-linecap="round"/>`, 'Sin conexión posible', 920]
  ]
  s += items.map(([g, t, x]) => `<g transform="translate(${x} ${ly})">${g}<text x="52" y="7" class="leg">${t}</text></g>`).join('')
  return s + '</svg>\n'
}

// ───────────── Diagrama 2: los caminos de una llamada ─────────────
function llamadas() {
  const W = 1200
  const H = 600
  let s = head(W, H, 'Los caminos de una llamada en HumbleChat', 'La voz, la cámara y la pantalla buscan solas el mejor camino entre dos equipos: primero directo; si en 4 segundos no conecta, por la misma conexión que usa el chat; si tampoco, por un amigo que hace de puente; y por último por un servidor TURN, solo si está configurado.')
  s += `<text x="${W / 2}" y="62" text-anchor="middle" class="title">Una llamada busca sola el mejor camino</text>`
  const xs = [24, 321, 618, 915]
  const pw = 261
  const names = ['Directo', 'Por el chat', 'Por un amigo', 'Servidor TURN']
  xs.forEach((x, i) => { s += panel(x, 100, pw, 400); s += badge(x + 34, 146, i + 1, names[i]).replace('class="h"', 'class="h" style="font-size:24px"') })
  const small = (cx, cy, i, r = 28, above = false) => avatar(cx, cy, i, r, false, above)
  const ay = 292
  // 1 directo
  s += `<line x1="${xs[0] + 70}" y1="${ay}" x2="${xs[0] + pw - 70}" y2="${ay}" stroke="${C.green}" stroke-width="7" stroke-linecap="round"/>`
  s += small(xs[0] + 56, ay, 0) + small(xs[0] + pw - 56, ay, 1)
  s += lines(xs[0] + pw / 2, 392, ['Entre los dos equipos,', 'sin pasar por nadie.', 'Es lo normal.'], 'cap', 28)
  // 2 por el chat
  const c2 = xs[1]
  s += `<line x1="${c2 + 70}" y1="${ay}" x2="${c2 + pw - 70}" y2="${ay}" stroke="${C.teal}" stroke-width="7" stroke-linecap="round"/>`
  s += `<g filter="url(#shadow)"><rect x="${c2 + pw / 2 - 52}" y="${ay - 25}" width="104" height="50" rx="14" fill="#14173a" stroke="${C.teal}" stroke-width="3"/><text x="${c2 + pw / 2}" y="${ay - 3}" text-anchor="middle" class="small" style="font-size:16px;font-weight:700">conexión</text><text x="${c2 + pw / 2}" y="${ay + 16}" text-anchor="middle" class="small" style="font-size:16px;font-weight:700">del chat</text></g>`
  s += small(c2 + 56, ay, 0) + small(c2 + pw - 56, ay, 1)
  s += lines(c2 + pw / 2, 392, ['Va dentro de la conexión', 'que ya usa el chat.', 'Cruza redes estrictas.'], 'cap', 28)
  // 3 por un amigo
  const c3 = xs[2]
  const a = [c3 + 50, ay + 14]
  const b = [c3 + pw - 50, ay + 14]
  const t = [c3 + pw / 2, ay - 64]
  s += `<polyline points="${a[0] + 22},${a[1] - 22} ${t[0] - 22},${t[1] + 22}" stroke="${C.orange}" stroke-width="7" stroke-linecap="round" fill="none"/><polyline points="${t[0] + 22},${t[1] + 22} ${b[0] - 22},${b[1] - 22}" stroke="${C.orange}" stroke-width="7" stroke-linecap="round" fill="none"/>`
  s += small(a[0], a[1], 0) + small(b[0], b[1], 1) + small(t[0], t[1], 2, 28, true)
  s += lines(c3 + pw / 2, 392, ['Un amigo con mejor red', 'retransmite el audio.', 'Él sí lo oye.'], 'cap', 28)
  // 4 TURN
  const c4 = xs[3]
  s += `<line x1="${c4 + 70}" y1="${ay}" x2="${c4 + pw - 70}" y2="${ay}" stroke="${C.soft}" stroke-width="7" stroke-linecap="round" stroke-dasharray="3 12"/>`
  s += `<g filter="url(#shadow)" transform="translate(${c4 + pw / 2} ${ay})"><rect x="-26" y="-34" width="52" height="68" rx="9" fill="#14173a" stroke="${C.soft}" stroke-width="3"/><rect x="-17" y="-24" width="34" height="11" rx="3" fill="${C.brand}"/><rect x="-17" y="-8" width="34" height="11" rx="3" fill="${C.brand}"/><circle cx="-10" cy="21" r="3.2" fill="${C.green}"/><circle cx="0" cy="21" r="3.2" fill="${C.soft}"/></g>`
  s += small(c4 + 56, ay, 0) + small(c4 + pw - 56, ay, 1)
  s += lines(c4 + pw / 2, 392, ['Servidor intermedio,', 'solo si lo configuras.', 'Sin él, no se usa.'], 'cap', 28)
  // flechas entre pasos
  for (let i = 0; i < 3; i++) {
    const x = xs[i] + pw + 18
    s += `<path d="M${x - 8} 292 l12 0 m-5 -7 l7 7 -7 7" stroke="${C.brand}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  s += `<text x="${W / 2}" y="540" text-anchor="middle" class="small" style="font-size:21px">Si un camino no conecta en <tspan style="font-weight:700;fill:#fff">4 segundos</tspan>, se prueba el siguiente.</text>`
  s += `<text x="${W / 2}" y="572" text-anchor="middle" class="leg" style="font-size:19px">Todo va cifrado. Solo en el camino 3 el amigo que hace de puente oye lo que retransmite.</text>`
  return s + '</svg>\n'
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'malla.svg'), malla())
fs.writeFileSync(path.join(OUT, 'llamadas.svg'), llamadas())
console.log('docs/malla.svg y docs/llamadas.svg generados')
