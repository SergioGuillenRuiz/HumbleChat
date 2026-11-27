'use strict'
// Utilidades de la llamada: aleatoriedad sin sesgo, reparto de equipos y validación de lo que llega de otros equipos.
const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/toolslogic.js')
// Generador determinista para probar: devuelve siempre el siguiente de una lista (módulo n)
const seq = (...vals) => { let i = 0; return (n) => vals[i++ % vals.length] % n }

test('randomInt no tiene sesgo: reparto uniforme y rechaza lo que lo rompería', async () => {
  const { randomInt } = await load()
  const bytes = (values) => { let i = 0; return () => new Uint32Array([values[i++]]) }
  // n = 3: 2**32 no es múltiplo de 3, el último trozo (4294967295) se descarta y se vuelve a sacar
  assert.equal(randomInt(3, bytes([4294967295, 7])), 1, 'descarta el valor del trozo incompleto')
  assert.equal(randomInt(6, bytes([0])), 0)
  assert.equal(randomInt(6, bytes([5])), 5)
  assert.throws(() => randomInt(0), RangeError)
  assert.throws(() => randomInt(1.5), RangeError)
  // con el generador real, 60 000 tiradas de un dado de 6 quedan cerca de 10 000 cada cara
  const c = Array(6).fill(0)
  for (let i = 0; i < 60000; i++) c[randomInt(6)]++
  for (const n of c) assert.ok(n > 9300 && n < 10700, 'reparto uniforme: ' + c)
})

test('shuffle conserva los elementos, no toca el original y puede dejar cualquier orden', async () => {
  const { shuffle } = await load()
  const a = ['a', 'b', 'c', 'd']
  const s = shuffle(a)
  assert.deepEqual([...s].sort(), a)
  assert.deepEqual(a, ['a', 'b', 'c', 'd'])
  const seen = new Set()
  for (let i = 0; i < 400; i++) seen.add(shuffle(['x', 'y', 'z']).join(''))
  assert.equal(seen.size, 6, 'salen las 6 ordenaciones posibles')
})

test('nombres: se limpian, se recortan y se limita su número', async () => {
  const { cleanNames } = await load()
  assert.deepEqual(cleanNames(['  Ana  ', '', 'Be\u0000to', '   ', 'x'.repeat(100)]), ['Ana', 'Beto', 'x'.repeat(40)])
  assert.equal(cleanNames(Array.from({ length: 80 }, (_, i) => 'n' + i)).length, 30)
  assert.deepEqual(cleanNames('no es lista'), [])
})

test('ruleta: gana una opción válida; hacen falta 2; el ángulo final deja la aguja sobre la ganadora', async () => {
  const { spinWheel, wheelAngle } = await load()
  const r = spinWheel(['Ana', 'Beto', 'Carla'], seq(2, 50))
  assert.deepEqual(r, { t: 'wheel', items: ['Ana', 'Beto', 'Carla'], win: 2, off: 0.6 })
  assert.throws(() => spinWheel(['sola']), /al menos 2/)
  // la aguja está arriba y la rueda gira en sentido horario: tras el giro, lo que queda arriba es la porción ganadora
  for (const [n, win, off] of [[3, 0, 0.5], [3, 2, 0.1], [7, 4, 0.9], [2, 1, 0.5]]) {
    const ang = wheelAngle(n, win, off) % 360 // cuánto ha girado la rueda
    const bajoLaAguja = ((360 - ang) % 360) / (360 / n) // posición (en porciones) que queda arriba
    assert.equal(Math.floor(bajoLaAguja + 1e-9), win)
  }
  // reparto: con el generador real todas las opciones pueden ganar
  const gana = new Set()
  for (let i = 0; i < 300; i++) gana.add(spinWheel(['a', 'b', 'c', 'd']).win)
  assert.equal(gana.size, 4)
})

test('equipos: reparto parejo, todos en un equipo, sin repetir, y errores claros', async () => {
  const { makeTeams } = await load()
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
  const { teams } = makeTeams(names, 3)
  assert.equal(teams.length, 3)
  assert.deepEqual(teams.flat().sort(), names, 'cada persona en un equipo y solo uno')
  const sizes = teams.map((t) => t.length)
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, 'tamaños parejos: ' + sizes)
  assert.throws(() => makeTeams(['A', 'B'], 3), /al menos tantas personas/)
  assert.throws(() => makeTeams(names, 1), /entre 2 y/)
  assert.throws(() => makeTeams(names, 9), /entre 2 y/)
  // los equipos cambian de una vez a otra
  const dist = new Set()
  for (let i = 0; i < 50; i++) dist.add(JSON.stringify(makeTeams(['A', 'B', 'C', 'D'], 2).teams.map((t) => [...t].sort())))
  assert.ok(dist.size > 1)
})

test('moneda, dado y orden', async () => {
  const { flipCoin, rollDice, randomOrder } = await load()
  assert.deepEqual(flipCoin(() => 0), { t: 'coin', r: 0 })
  assert.deepEqual(flipCoin(() => 1), { t: 'coin', r: 1 })
  const caras = new Set(); for (let i = 0; i < 100; i++) caras.add(flipCoin().r)
  assert.equal(caras.size, 2)
  const d = rollDice(20, 3)
  assert.equal(d.rolls.length, 3)
  assert.ok(d.rolls.every((x) => x >= 1 && x <= 20))
  assert.deepEqual(rollDice(6, 2, seq(0, 5)).rolls, [1, 6], 'el dado va de 1 a sus caras')
  assert.throws(() => rollDice(1), RangeError)
  assert.throws(() => rollDice(6, 0), RangeError)
  assert.throws(() => rollDice(6, 99), RangeError)
  const o = randomOrder(['A', 'B', 'C'])
  assert.deepEqual([...o.list].sort(), ['A', 'B', 'C'])
  assert.throws(() => randomOrder(['A']), /al menos 2/)
})

test('lo que llega de otro equipo se valida: formas inválidas, índices fuera de rango y contenido raro se rechazan', async () => {
  const { validateResult, spinWheel, makeTeams, rollDice, randomOrder, flipCoin } = await load()
  // lo legítimo pasa tal cual
  for (const r of [spinWheel(['a', 'b', 'c']), makeTeams(['a', 'b', 'c', 'd'], 2), rollDice(6, 2), randomOrder(['a', 'b']), flipCoin()]) assert.deepEqual(validateResult(r), r)
  // lo malo no
  const malos = [null, 'x', {}, { t: 'otra' },
    { t: 'wheel', items: ['a'], win: 0, off: 0.5 }, { t: 'wheel', items: ['a', 'b'], win: 2, off: 0.5 }, { t: 'wheel', items: ['a', 'b'], win: -1, off: 0.5 },
    { t: 'wheel', items: ['a', 'b'], win: 0, off: 5 }, { t: 'wheel', items: ['a', '', 'b'], win: 0, off: 0.5 }, { t: 'wheel', items: 'ab', win: 0, off: 0.5 },
    { t: 'teams', teams: [['a']] }, { t: 'teams', teams: [['a'], []] }, { t: 'teams', teams: [['a'], 'b'] },
    { t: 'coin', r: 2 }, { t: 'coin', r: '1' },
    { t: 'dice', sides: 6, rolls: [7] }, { t: 'dice', sides: 1, rolls: [1] }, { t: 'dice', sides: 6, rolls: [] }, { t: 'dice', sides: 6, rolls: [1.5] },
    { t: 'order', list: ['solo'] }]
  for (const m of malos) assert.equal(validateResult(m), null, JSON.stringify(m))
  // demasiada gente
  assert.equal(validateResult({ t: 'order', list: Array.from({ length: 31 }, (_, i) => 'n' + i) }), null)
  // los textos se limpian: nada de caracteres de control ni nombres kilométricos, y quedan como mucho 40 caracteres
  const r = validateResult({ t: 'order', list: ['Ana\u0007', 'x'.repeat(40)] })
  assert.deepEqual(r.list, ['Ana', 'x'.repeat(40)].map((x) => x.replace(/\p{Cc}/gu, '')))
  // un nombre más largo que el tope se recorta (no se tira un resultado legítimo por eso), pero nunca pasa entero
  assert.deepEqual(validateResult({ t: 'order', list: ['Ana', 'x'.repeat(50)] }).list, ['Ana', 'x'.repeat(40)])
})
