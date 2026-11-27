// Utilidades de la llamada (ruleta, equipos, moneda, dado, orden): lógica pura, sin pantalla.
// Quien pulsa «girar» (o «lanzar»…) calcula el resultado una sola vez y lo manda a los demás de la llamada: todos ven lo mismo.

export const LIMITS = { names: 30, nameLen: 40, teams: 8, dice: 10, sides: 1000 }

/** Entero aleatorio en [0, n) con aleatoriedad criptográfica y sin sesgo (descarta lo que desigualaría el reparto). */
export function randomInt(n, bytes = (len) => crypto.getRandomValues(new Uint32Array(len))) {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new RangeError('n fuera de rango')
  const limit = Math.floor(2 ** 32 / n) * n
  for (;;) {
    const x = bytes(1)[0]
    if (x < limit) return x % n
  }
}

/** Reordena (Fisher-Yates) sin tocar el original. */
export function shuffle(list, rnd = randomInt) {
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

/** Nombres limpios: sin caracteres de control, recortados, sin vacíos, con tope. */
export function cleanNames(list, { max = LIMITS.names } = {}) {
  const out = []
  for (const x of Array.isArray(list) ? list : []) {
    const s = String(x ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.nameLen)
    if (s) out.push(s)
    if (out.length >= max) break
  }
  return out
}

/** Ruleta: la opción ganadora y un desplazamiento dentro de su porción (para que la aguja no caiga siempre en el centro). */
export function spinWheel(items, rnd = randomInt) {
  const list = cleanNames(items)
  if (list.length < 2) throw new RangeError('Hacen falta al menos 2 opciones')
  return { t: 'wheel', items: list, win: rnd(list.length), off: (rnd(80) + 10) / 100 }
}

/** Equipos: reparto al azar lo más parejo posible (los tamaños difieren como mucho en 1). */
export function makeTeams(names, count, rnd = randomInt) {
  const list = cleanNames(names)
  if (!Number.isInteger(count) || count < 2 || count > LIMITS.teams) throw new RangeError('El número de equipos debe estar entre 2 y ' + LIMITS.teams)
  if (list.length < count) throw new RangeError('Hacen falta al menos tantas personas como equipos')
  const teams = Array.from({ length: count }, () => [])
  shuffle(list, rnd).forEach((n, i) => teams[i % count].push(n))
  return { t: 'teams', teams }
}

export const flipCoin = (rnd = randomInt) => ({ t: 'coin', r: rnd(2) }) // 0 = cara, 1 = cruz

export function rollDice(sides, count = 1, rnd = randomInt) {
  if (!Number.isInteger(sides) || sides < 2 || sides > LIMITS.sides) throw new RangeError('Caras fuera de rango')
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.dice) throw new RangeError('Número de dados fuera de rango')
  return { t: 'dice', sides, rolls: Array.from({ length: count }, () => rnd(sides) + 1) }
}

export function randomOrder(names, rnd = randomInt) {
  const list = cleanNames(names)
  if (list.length < 2) throw new RangeError('Hacen falta al menos 2 personas')
  return { t: 'order', list: shuffle(list, rnd) }
}

/** Lo que llega de otro equipo no se fía: se valida todo y se devuelve un resultado limpio, o null. */
export function validateResult(m) {
  if (!m || typeof m !== 'object') return null
  const names = (v, min, max) => { const c = cleanNames(v, { max }); return Array.isArray(v) && c.length === v.length && c.length >= min ? c : null }
  switch (m.t) {
    case 'wheel': {
      const items = names(m.items, 2, LIMITS.names)
      if (!items || !Number.isInteger(m.win) || m.win < 0 || m.win >= items.length) return null
      if (!(typeof m.off === 'number' && m.off >= 0 && m.off <= 1)) return null
      return { t: 'wheel', items, win: m.win, off: m.off }
    }
    case 'teams': {
      if (!Array.isArray(m.teams) || m.teams.length < 2 || m.teams.length > LIMITS.teams) return null
      const teams = m.teams.map((t) => names(t, 1, LIMITS.names))
      if (teams.some((t) => !t) || teams.reduce((n, t) => n + t.length, 0) > LIMITS.names) return null
      return { t: 'teams', teams }
    }
    case 'coin': return m.r === 0 || m.r === 1 ? { t: 'coin', r: m.r } : null
    case 'dice': {
      if (!Number.isInteger(m.sides) || m.sides < 2 || m.sides > LIMITS.sides) return null
      if (!Array.isArray(m.rolls) || m.rolls.length < 1 || m.rolls.length > LIMITS.dice) return null
      if (m.rolls.some((r) => !Number.isInteger(r) || r < 1 || r > m.sides)) return null
      return { t: 'dice', sides: m.sides, rolls: m.rolls.slice() }
    }
    case 'order': { const list = names(m.list, 2, LIMITS.names); return list ? { t: 'order', list } : null }
    default: return null
  }
}

/** Ángulo final (grados, giro horario) de la ruleta para que la aguja (arriba) caiga en `win`, tras `turns` vueltas completas. */
export function wheelAngle(count, win, off, turns = 5) {
  const slice = 360 / count
  return turns * 360 + (360 - (win + off) * slice)
}
