// Utilidades de la llamada: ruleta, equipos, cara o cruz, dado y orden aleatorio.
// Quien pulsa calcula el resultado una vez (toolslogic.js) y se lo manda a los demás de la llamada: todos ven lo mismo, con la misma animación.
import { h } from '../util.js'
import { icon } from '../icons.js'
import { state } from '../state.js'
import { utilBus, sendToCall } from '../voice.js'
import { layer, toast, openContextMenu } from './overlays.js'
import * as T from '../toolslogic.js'

const PALETTE = ['#5865f2', '#3ba55d', '#faa61a', '#eb459e', '#ed4245', '#1abc9c', '#9b59b6', '#e67e22']
const nameOf = (id) => state.byId.get(id)?.name || 'Alguien'

export function mountTools() { utilBus.handler = (fromId, m) => { const r = T.validateResult(m); if (r) showResult(r, nameOf(fromId)) } }

/** Los de este canal de voz que están en línea y dentro de la llamada. */
const participants = (ch) => state.members.filter((m) => m.online && m.voice?.ch === ch).map((m) => m.name)

/** Desplegable con las utilidades, para el canal de voz `ch`. */
export function openToolsMenu(anchor, ch) {
  const r = anchor.getBoundingClientRect()
  const x = Math.min(r.left, window.innerWidth - 240)
  openContextMenu(x, Math.max(8, r.top - 6 - 5 * 36), [
    { label: 'Ruleta', icon: 'wheel', onclick: () => openChooser({ ch, kind: 'wheel' }) },
    { label: 'Equipos aleatorios', icon: 'people', onclick: () => openChooser({ ch, kind: 'teams' }) },
    { label: 'Cara o cruz', icon: 'coin', onclick: () => run(T.flipCoin()) },
    { label: 'Dado', icon: 'dice', onclick: () => openDice() },
    { label: 'Orden aleatorio', icon: 'shuffle', onclick: () => openChooser({ ch, kind: 'order' }) }
  ])
}

/** Lanza un resultado: se lo enseña a los de la llamada y se lo enseña a uno mismo. */
function run(result) {
  sendToCall({ k: 'util', d: result })
  showResult(result, state.me.name, true)
}

const TITLES = { wheel: 'Ruleta', teams: 'Equipos aleatorios', order: 'Orden aleatorio' }
const HELP = {
  wheel: 'Cada persona de la llamada tiene su porción. Quita a quien no participe o añade opciones.',
  teams: 'Se reparten al azar, lo más parejo posible. Quita a quien no juegue.',
  order: 'Se ordena al azar a todos los marcados (por ejemplo, para saber quién empieza).'
}

/** Elegir quién entra (los de la llamada, más opciones propias) y cuántos equipos si hace falta. */
function openChooser({ ch, kind }) {
  const { el, close } = layer('modal-bg')
  el.addEventListener('mousedown', (e) => { if (e.target === el) close() })
  const items = participants(ch).map((name) => ({ name, on: true, mine: false }))
  let teams = 2
  const chips = h('div.chips')
  const extra = h('input.text', { placeholder: 'Añadir una opción y pulsar Intro', maxLength: 40, spellcheck: false })
  const count = h('span.stepper-n', '2')
  const hint = h('p.muted.util-hint')
  const sel = () => items.filter((i) => i.on).map((i) => i.name)
  function draw() {
    chips.replaceChildren(...items.map((it, i) => h('button.chip' + (it.on ? '.on' : ''), {
      type: 'button', onclick: () => { it.on = !it.on; draw() },
      oncontextmenu: (e) => { if (it.mine) { e.preventDefault(); items.splice(i, 1); draw() } }
    }, it.name, it.mine && h('span.chip-x', { tip: 'Quitar', onclick: (e) => { e.stopPropagation(); items.splice(i, 1); draw() } }, '×'))))
    const n = sel().length
    hint.textContent = n === 0 ? 'No hay nadie en esta llamada. Añade opciones a mano.' : `${n} ${n === 1 ? 'seleccionada' : 'seleccionadas'}.`
  }
  extra.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !extra.value.trim()) return
    const [name] = T.cleanNames([extra.value])
    if (name && items.length < T.LIMITS.names) items.push({ name, on: true, mine: true })
    extra.value = ''
    draw()
  })
  const go = () => {
    try {
      const names = sel()
      const r = kind === 'wheel' ? T.spinWheel(names) : kind === 'teams' ? T.makeTeams(names, teams) : T.randomOrder(names)
      close()
      run(r)
    } catch (e) { toast(e.message, 'warn') }
  }
  const stepper = kind === 'teams' && h('div.field', h('div.label', 'Número de equipos'),
    h('div.stepper',
      h('button.btn.secondary.small', { type: 'button', onclick: () => { teams = Math.max(2, teams - 1); count.textContent = String(teams) } }, '−'), count,
      h('button.btn.secondary.small', { type: 'button', onclick: () => { teams = Math.min(T.LIMITS.teams, teams + 1); count.textContent = String(teams) } }, '+')))
  el.append(h('div.modal',
    h('div.modal-body', h('h2', TITLES[kind]), h('p.muted', HELP[kind]), chips, hint, h('label.field', 'Añadir opción', extra), stepper),
    h('div.modal-foot', h('button.btn.link', { onclick: close }, 'Cancelar'),
      h('button.btn.brand', { onclick: go, dataset: { go: kind } }, kind === 'wheel' ? 'Girar' : kind === 'teams' ? 'Crear equipos' : 'Ordenar'))))
  draw()
  extra.focus()
}

function openDice() {
  const { el, close } = layer('modal-bg')
  el.addEventListener('mousedown', (e) => { if (e.target === el) close() })
  const sides = h('select', ...[4, 6, 8, 10, 12, 20, 100].map((n) => h('option', { value: n, selected: n === 6 }, 'd' + n)))
  const n = h('select', ...[1, 2, 3, 4, 5, 6].map((c) => h('option', { value: c }, String(c))))
  el.append(h('div.modal',
    h('div.modal-body', h('h2', 'Dado'),
      h('label.field', 'Caras', sides), h('label.field', 'Cuántos dados', n)),
    h('div.modal-foot', h('button.btn.link', { onclick: close }, 'Cancelar'),
      h('button.btn.brand', { dataset: { go: 'dice' }, onclick: () => { close(); run(T.rollDice(Number(sides.value), Number(n.value))) } }, 'Tirar'))))
}

// ───────────── Resultado (lo ven todos) ─────────────
const RESULT_TITLE = { wheel: 'Ruleta', teams: 'Equipos aleatorios', coin: 'Cara o cruz', dice: 'Dado', order: 'Orden aleatorio' }
const SVG = 'http://www.w3.org/2000/svg'

function wheelSvg(items) {
  const n = items.length
  const R = 140
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '-150 -150 300 300')
  svg.classList.add('wheel-svg')
  const g = document.createElementNS(SVG, 'g')
  g.classList.add('wheel-g')
  const pt = (a, r) => [Math.sin((a * Math.PI) / 180) * r, -Math.cos((a * Math.PI) / 180) * r]
  items.forEach((name, i) => {
    const a0 = (360 / n) * i
    const a1 = (360 / n) * (i + 1)
    const [x0, y0] = pt(a0, R)
    const [x1, y1] = pt(a1, R)
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', n === 1 ? '' : `M0 0 L${x0} ${y0} A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1} Z`)
    path.setAttribute('fill', PALETTE[i % PALETTE.length])
    path.setAttribute('stroke', '#1e1f22')
    path.setAttribute('stroke-width', '2')
    g.append(path)
    const mid = (a0 + a1) / 2
    const [tx, ty] = pt(mid, R * 0.62)
    const t = document.createElementNS(SVG, 'text')
    t.setAttribute('x', tx); t.setAttribute('y', ty)
    t.setAttribute('transform', `rotate(${mid - 90 + (mid > 180 ? 180 : 0)} ${tx} ${ty})`)
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'middle')
    t.setAttribute('fill', '#fff'); t.setAttribute('font-size', n > 12 ? '9' : '12'); t.setAttribute('font-weight', '700')
    t.textContent = name.length > 14 ? name.slice(0, 13) + '…' : name
    g.append(t)
  })
  svg.append(g)
  const hub = document.createElementNS(SVG, 'circle')
  hub.setAttribute('r', '10'); hub.setAttribute('fill', '#1e1f22')
  svg.append(hub)
  return { svg, g }
}

function showResult(r, by, mine = false) {
  document.querySelectorAll('.util-result').forEach((x) => x.closest('.layer')?.remove())
  const { el, close } = layer('modal-bg')
  el.addEventListener('mousedown', (e) => { if (e.target === el) close() })
  const out = h('div.util-out')
  const box = h('div.modal.util-result', { dataset: { kind: r.t, done: '' } },
    h('div.modal-body',
      h('div.util-by', mine ? 'Tú' : by, ' · ', RESULT_TITLE[r.t]),
      out),
    h('div.modal-foot', h('button.btn.brand', { onclick: close }, 'Cerrar')))
  const done = (summary) => { box.dataset.done = '1'; box.dataset.result = summary }
  el.append(box)

  if (r.t === 'wheel') {
    const { svg, g } = wheelSvg(r.items)
    out.append(h('div.wheel', h('div.wheel-pointer'), svg))
    const final = T.wheelAngle(r.items.length, r.win, r.off, 5)
    const win = h('div.util-win')
    out.append(win)
    requestAnimationFrame(() => requestAnimationFrame(() => { g.style.transform = `rotate(${final}deg)` }))
    const fin = () => { win.replaceChildren('🎡 ', h('b', r.items[r.win])); done(r.items[r.win]) }
    g.addEventListener('transitionend', fin, { once: true })
    setTimeout(() => { if (!box.dataset.done) fin() }, 5600)
  } else if (r.t === 'coin') {
    const face = r.r === 0 ? 'Cara' : 'Cruz'
    const coin = h('div.coin.flip-' + r.r, h('div.coin-f.front', 'CARA'), h('div.coin-f.back', 'CRUZ'))
    const win = h('div.util-win')
    out.append(h('div.coin-wrap', coin), win)
    setTimeout(() => { win.replaceChildren('🪙 ', h('b', face)); done(face.toLowerCase()) }, 1700)
  } else if (r.t === 'dice') {
    const sum = r.rolls.reduce((a, b) => a + b, 0)
    out.append(h('div.dice', ...r.rolls.map((x) => h('div.die', String(x)))),
      h('div.util-win', `d${r.sides}`, r.rolls.length > 1 && [' · total ', h('b', String(sum))]))
    done(r.rolls.join(','))
  } else if (r.t === 'teams') {
    out.append(h('div.teams', ...r.teams.map((t, i) => h('div.team', { style: { borderColor: PALETTE[i % PALETTE.length] } },
      h('div.team-h', { style: { color: PALETTE[i % PALETTE.length] } }, 'Equipo ' + (i + 1)), ...t.map((n) => h('div.team-n', n))))))
    done(r.teams.map((t) => t.join('+')).join('|'))
  } else if (r.t === 'order') {
    out.append(h('ol.order', ...r.list.map((n) => h('li', n))))
    done(r.list.join('>'))
  }
}
