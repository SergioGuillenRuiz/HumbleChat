'use strict'
// Escuchar juntos: enlaces, validación de lo que llega de otros equipos, acciones sobre la cola, convergencia y reconciliación con el reproductor.
const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../src/renderer/musiclogic.js')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const track = (v, n, by = A, t = 'Canción ' + n) => ({ v, n, t, a: 'Canal', by })
const V1 = 'dQw4w9WgXcQ'
const V2 = 'aaaaaaaaaaa'
const V3 = 'bbbbbbbbbbb'

test('parseYouTube entiende los enlaces habituales y rechaza el resto', async () => {
  const { parseYouTube } = await load()
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLxyz', 'http://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=abc', 'https://youtu.be/dQw4w9WgXcQ?t=3', 'youtu.be/dQw4w9WgXcQ', 'www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ?feature=share',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', '  dQw4w9WgXcQ  '
  ]) assert.equal(parseYouTube(u), V1, u)
  for (const u of [
    '', 'hola', 'https://www.youtube.com/playlist?list=PL123', 'https://www.youtube.com/', 'https://www.youtube.com/watch?v=corto',
    'https://evil.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'https://evilyoutube.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)', 'file:///etc/passwd', 'https://youtu.be/', null, undefined, 42
  ]) assert.equal(parseYouTube(u), null, String(u))
})

test('fmtTime', async () => {
  const { fmtTime } = await load()
  assert.equal(fmtTime(0), '0:00')
  assert.equal(fmtTime(83.9), '1:23')
  assert.equal(fmtTime(3725), '1:02:05')
  assert.equal(fmtTime(-5), '0:00')
  assert.equal(fmtTime(NaN), '0:00')
})

test('validateState acepta lo bien formado y rechaza lo que no lo es', async () => {
  const { validateState, emptyState } = await load()
  const ok = { rev: 3, by: A, q: [track(V1, 'n001'), track(V2, 'n002')], i: 1, play: true, pos: 12.5 }
  assert.deepEqual(validateState(ok), ok)
  assert.deepEqual(validateState(emptyState()), emptyState())
  // saneado: títulos largos y caracteres de control; sin pista actual no puede estar sonando
  const sucio = validateState({ ...ok, q: [{ ...track(V1, 'n001'), t: 'x'.repeat(500) + '\u0007' }], i: 1, play: true, pos: 9 })
  assert.equal(sucio.q[0].t.length, 120)
  assert.equal(sucio.play, false)
  assert.equal(sucio.pos, 0)
  assert.equal(validateState({ ...ok, pos: 1e9 }).pos, 86400)
  assert.equal(validateState({ ...ok, q: [{ ...track(V1, 'n001'), t: '   ' }], i: 0 }).q[0].t, 'Vídeo de YouTube')
  for (const bad of [
    null, 'x', [], {}, { ...ok, q: 'no' }, { ...ok, rev: -1 }, { ...ok, rev: 1.5 }, { ...ok, rev: 2e9 }, { ...ok, by: 'xyz' }, { ...ok, by: null },
    { ...ok, i: 3 }, { ...ok, i: -1 }, { ...ok, i: 0.5 }, { ...ok, pos: 'a' }, { ...ok, pos: Infinity },
    { ...ok, q: [track('corto', 'n001')], i: 0 }, { ...ok, q: [{ ...track(V1, 'n001'), n: 'a' }], i: 0 },
    { ...ok, q: [track(V1, 'n001'), track(V2, 'n001')], i: 0 }, // identificadores repetidos
    { ...ok, q: Array.from({ length: 51 }, (_, k) => track(V1, 'n' + String(k).padStart(3, '0'))), i: 0 }
  ]) assert.equal(validateState(bad), null, JSON.stringify(bad)?.slice(0, 80))
  // `by` de una pista inválido se vacía en vez de rechazar
  assert.equal(validateState({ ...ok, q: [{ ...track(V1, 'n001'), by: 'zz' }], i: 0 }).q[0].by, '')
})

test('validateMessage: solo existe el mensaje «estado»', async () => {
  const { validateMessage, emptyState } = await load()
  assert.equal(validateMessage({ t: 'st', s: emptyState() }).t, 'st')
  assert.equal(validateMessage({ t: 'otro', s: emptyState() }), null)
  assert.equal(validateMessage({ t: 'st', s: { ...emptyState(), rev: 'x' } }), null)
  assert.equal(validateMessage(null), null)
})

test('añadir: si no suena nada, empieza; si ya suena algo, se pone en cola', async () => {
  const m = await load()
  const { emptyState, addTrack, current } = m
  let s = addTrack(emptyState(), track(V1, 'n001'), A)
  assert.deepEqual([s.rev, s.by, s.i, s.play, s.pos], [1, A, 0, true, 0])
  assert.equal(current(s).n, 'n001')
  s = addTrack(s, track(V2, 'n002', B), B)
  assert.deepEqual([s.rev, s.by, s.i, s.q.length], [2, B, 0, 2])
  assert.equal(current(s).n, 'n001', 'no cambia la que suena')
  // la cola se llena
  let lleno = emptyState()
  for (let k = 0; k < 50; k++) lleno = addTrack(lleno, track(V1, 'q' + String(k).padStart(3, '0')), A)
  assert.throws(() => addTrack(lleno, track(V2, 'qxxx'), A), /cola está llena/)
  // al agotarse la cola, una canción nueva vuelve a sonar
  let fin = addTrack(emptyState(), track(V1, 'n001'), A)
  fin = m.next(fin, A)
  assert.equal(current(fin), null)
  fin = addTrack(fin, track(V2, 'n002'), A)
  assert.deepEqual([current(fin).n, fin.play, fin.pos], ['n002', true, 0])
})

test('quitar: ajusta la pista actual según lo que se quite', async () => {
  const m = await load()
  const base = () => ({ ...m.emptyState(), q: [track(V1, 'n001'), track(V2, 'n002'), track(V3, 'n003')], i: 1, play: true, pos: 30, rev: 5, by: A })
  // antes de la actual: sigue sonando la misma
  let s = m.removeTrack(base(), 'n001', B)
  assert.deepEqual([m.current(s).n, s.i, s.pos, s.play], ['n002', 0, 30, true])
  // después de la actual: no cambia nada salvo la cola
  s = m.removeTrack(base(), 'n003', B)
  assert.deepEqual([m.current(s).n, s.i, s.pos, s.q.length], ['n002', 1, 30, 2])
  // la actual: pasa a sonar la siguiente desde el principio, sin perder el «sonando»
  s = m.removeTrack(base(), 'n002', B)
  assert.deepEqual([m.current(s).n, s.i, s.pos, s.play], ['n003', 1, 0, true])
  // la actual y última: se para
  s = m.removeTrack({ ...base(), i: 2 }, 'n003', B)
  assert.deepEqual([m.current(s), s.i, s.play], [null, 2, false])
  // la que no existe: el mismo estado
  const b = base()
  assert.equal(m.removeTrack(b, 'zzzz', B), b)
  // con la cola agotada, quitar una antigua deja la cola agotada
  const ag = m.removeTrack({ ...b, i: 3, play: false, pos: 0 }, 'n001', B)
  assert.deepEqual([ag.i, ag.q.length, m.current(ag)], [2, 2, null])
})

test('pausar, buscar, saltar, anterior y siguiente', async () => {
  const m = await load()
  let s = m.addTrack(m.addTrack(m.addTrack(m.emptyState(), track(V1, 'n001'), A), track(V2, 'n002'), A), track(V3, 'n003'), A)
  s = m.setPlay(s, false, 41, B)
  assert.deepEqual([s.play, s.pos, s.by], [false, 41, B])
  s = m.setPlay(s, true, 41, B)
  s = m.seekTo(s, 100, C)
  assert.deepEqual([s.pos, s.play], [100, true])
  assert.equal(m.seekTo(s, -4, C).pos, 0)
  assert.equal(m.seekTo(s, 1e12, C).pos, 86400)
  // anterior: pasados 3 s reinicia; en los primeros 3 s va a la anterior; en la primera solo reinicia
  s = m.jumpTo(s, 'n002', A)
  assert.deepEqual([s.i, s.pos, s.play], [1, 0, true])
  assert.equal(m.prev(s, 10, A).i, 1)
  assert.equal(m.prev(s, 10, A).pos, 0)
  assert.equal(m.prev(s, 1, A).i, 0)
  assert.equal(m.prev(m.jumpTo(s, 'n001', A), 1, A).i, 0)
  // siguiente, y al final de la cola se agota
  s = m.next(s, A)
  assert.equal(m.current(s).n, 'n003')
  s = m.next(s, A)
  assert.deepEqual([m.current(s), s.play, s.i], [null, false, 3])
  assert.equal(m.next(s, A), s, 'sin pista actual no hay nada que hacer')
  assert.equal(m.setPlay(s, true, 0, A), s)
  assert.equal(m.seekTo(s, 3, A), s)
  assert.equal(m.jumpTo(s, 'zzzz', A), s)
  assert.equal(m.clear(m.emptyState(), A).rev, 0, 'vaciar lo ya vacío no crea una versión nueva')
  assert.deepEqual(m.clear(s, A).q, [])
})

test('advance: lo propone quien oye acabar la pista y es idéntico en todos (no se pisan)', async () => {
  const m = await load()
  const base = { ...m.emptyState(), q: [track(V1, 'n001'), track(V2, 'n002')], i: 0, play: true, pos: 200, rev: 7, by: B }
  const x = m.advance(base, 'n001')
  const y = m.advance(base, 'n001')
  assert.deepEqual(x, y)
  assert.deepEqual([x.i, x.pos, x.play, x.rev, x.by], [1, 0, true, 8, ''])
  assert.equal(m.advance(base, 'n002'), base, 'si ya no es la actual, nada que hacer')
  assert.equal(m.advance(x, 'n001'), x, 'idempotente')
  const fin = m.advance(x, 'n002')
  assert.deepEqual([m.current(fin), fin.play], [null, false])
  // una acción de una persona al mismo tiempo gana a la automática (by '' es el menor)
  const manual = m.setPlay(base, false, 150, A)
  assert.ok(m.newer(manual, x))
  assert.ok(!m.newer(x, manual))
})

test('newer: mayor rev; a igualdad, mayor by; el mismo no gana', async () => {
  const { newer } = await load()
  assert.ok(newer({ rev: 2, by: A }, { rev: 1, by: C }))
  assert.ok(newer({ rev: 1, by: B }, { rev: 1, by: A }))
  assert.ok(!newer({ rev: 1, by: A }, { rev: 1, by: B }))
  assert.ok(!newer({ rev: 1, by: A, q: [], i: 0, play: false }, { rev: 1, by: A, q: [], i: 0, play: false }))
})

test('dos fines de pista automáticos con contenido distinto en el mismo rev: todos eligen el mismo', async () => {
  const m = await load()
  // X y Z actuaron a la vez sobre el rev 6 (rev 7 por B y por A) y ambos oyeron acabar su pista antes de verse
  const x = { ...m.emptyState(), rev: 7, by: B, q: [track(V1, 'n001'), track(V2, 'n002'), track(V3, 'n003')], i: 0, play: true, pos: 0 }
  const z = { ...x, by: A, i: 1 }
  const ax = m.advance(x, 'n001')
  const az = m.advance(z, 'n002')
  assert.equal(ax.rev, az.rev)
  assert.equal(ax.by, az.by)
  assert.notEqual(JSON.stringify(ax), JSON.stringify(az))
  assert.notEqual(m.newer(ax, az), m.newer(az, ax), 'uno de los dos tiene que ganar siempre')
  const rx = m.merge({ state: ax, at: 0 }, az, 0)
  const rz = m.merge({ state: az, at: 0 }, ax, 0)
  assert.deepEqual(rx.state, rz.state, 'los dos acaban con el mismo')
  // la misma versión contada en otro instante (otra posición) no se toma por nueva
  assert.equal(m.merge({ state: ax, at: 0 }, { ...ax, pos: 50 }, 0).adopted, false)
})

test('convergencia: tres equipos actúan a la vez, se pasan los estados en cualquier orden y acaban con el mismo', async () => {
  const m = await load()
  for (let ronda = 0; ronda < 200; ronda++) {
    const ids = [A, B, C]
    const reps = ids.map(() => ({ state: m.emptyState(), at: 0 }))
    const acciones = [
      (s, me, k) => m.addTrack(s, track([V1, V2, V3][k], 'n' + me[0] + ronda, me), me),
      (s, me) => m.setPlay(s, Math.random() < 0.5, Math.random() * 100, me),
      (s, me) => m.seekTo(s, Math.random() * 100, me),
      (s, me) => m.next(s, me),
      (s) => (m.current(s) ? m.advance(s, m.current(s).n) : s), // fin de pista: lo propone cualquiera, a la vez que acciones de otros
      (s, me) => (s.q[0] ? m.removeTrack(s, s.q[0].n, me) : s)
    ]
    const mandar = (from, to) => {
      const r = m.merge(reps[to], JSON.parse(JSON.stringify(reps[from].state)), 0)
      reps[to] = { state: r.state, at: 0 }
    }
    for (let paso = 0; paso < 12; paso++) {
      const k = Math.floor(Math.random() * 3)
      const act = acciones[Math.floor(Math.random() * acciones.length)]
      try { reps[k].state = act(reps[k].state, ids[k], k) } catch {}
      if (Math.random() < 0.6) { // reparto parcial y desordenado
        const a = Math.floor(Math.random() * 3)
        const b = (a + 1 + Math.floor(Math.random() * 2)) % 3
        mandar(a, b)
      }
    }
    for (let vuelta = 0; vuelta < 2; vuelta++) for (const a of [0, 1, 2]) for (const b of [0, 1, 2]) if (a !== b) mandar(a, b)
    const [s0, s1, s2] = reps.map((r) => JSON.stringify(r.state))
    assert.equal(s0, s1, 'ronda ' + ronda)
    assert.equal(s1, s2, 'ronda ' + ronda)
  }
})

test('dos personas pegan una canción a la vez: ninguna se pierde', async () => {
  const m = await load()
  const base = m.addTrack(m.emptyState(), track(V1, 'n001'), A)
  const ta = track(V2, 'nAAA', A)
  const tb = track(V3, 'nBBB', B)
  const ea = { state: m.addTrack(base, ta, A), at: 0 }
  const eb = { state: m.addTrack(base, tb, B), at: 0 }
  assert.equal(ea.state.rev, eb.state.rev)
  // B gana el empate (by mayor): A adopta el de B y, como no trae su canción, la vuelve a añadir
  const ra = m.merge(ea, eb.state, 10, new Map([['nAAA', ta]]), A)
  assert.ok(ra.adopted && ra.changed)
  assert.deepEqual(ra.state.q.map((t) => t.n), ['n001', 'nBBB', 'nAAA'])
  // B ve el estado de A (más nuevo) y lo adopta; su canción ya está dentro, así que no añade nada
  const rb = m.merge(eb, ra.state, 11, new Map([['nBBB', tb]]), B)
  assert.ok(rb.adopted && !rb.changed)
  assert.deepEqual(rb.state, ra.state)
  // el que pierde sin nada pendiente no toca nada
  const quieto = m.merge(ea, eb.state, 10)
  assert.ok(quieto.adopted && !quieto.changed)
  // lo que no es más nuevo no se adopta
  assert.equal(m.merge(eb, base, 10).adopted, false)
  assert.equal(m.merge(eb, eb.state, 10).adopted, false)
})

test('un recién llegado recibe la posición de ahora, no la de cuando se creó el estado', async () => {
  const m = await load()
  let s = m.addTrack(m.emptyState(), track(V1, 'n001'), A) // pos 0 en t = 1000
  const at = 1000
  assert.equal(m.expectedPos(s, at, 1000), 0)
  assert.equal(m.expectedPos(s, at, 91000), 90)
  assert.equal(m.expectedPos(s, at, 500), 0, 'un reloj que retrocede no da posiciones negativas')
  const snap = m.snapshot(s, at, 91000)
  assert.equal(snap.pos, 90)
  assert.equal(snap.rev, s.rev, 'misma versión: quien ya lo tiene no lo toma por nuevo')
  const llegado = m.merge({ state: m.emptyState(), at: 0 }, snap, 91000)
  assert.ok(llegado.adopted)
  assert.equal(m.expectedPos(llegado.state, llegado.at, 94000), 93)
  s = m.setPlay(s, false, 90, A)
  assert.equal(m.expectedPos(s, at, 999999), 90, 'en pausa no avanza')
  assert.equal(m.expectedPos(m.emptyState(), 0, 5000), 0)
})

test('plan: qué le dice el estado al reproductor local', async () => {
  const m = await load()
  const s = { ...m.addTrack(m.emptyState(), track(V1, 'n001'), A), pos: 10 } // suena, pos 10 en at = 0
  const base = { state: s, at: 0, now: 5000, listening: true, player: { n: null, st: 'none', pos: 0 } }
  // sin escuchar: nada (y si ya había algo cargado, se para)
  assert.deepEqual(m.plan({ ...base, listening: false }), [])
  assert.deepEqual(m.plan({ ...base, listening: false, player: { n: 'n001', st: 'playing', pos: 15 } }), [{ op: 'stop' }])
  // escuchando y nada cargado: carga la pista, en la posición que toca y sonando
  assert.deepEqual(m.plan(base), [{ op: 'load', v: V1, n: 'n001', pos: 15, play: true }])
  // recién mandado «cargar»: no lo repite mientras el reproductor lo confirma, pero sí pasada la gracia
  assert.deepEqual(m.plan({ ...base, sent: { n: 'n001', at: 4000 } }), [])
  assert.equal(m.plan({ ...base, sent: { n: 'n001', at: 1000 } })[0].op, 'load')
  // la pista cargada no es la actual (alguien saltó): carga la nueva
  assert.equal(m.plan({ ...base, player: { n: 'otra', st: 'playing', pos: 3 } })[0].op, 'load')
  // al día: no hace nada
  assert.deepEqual(m.plan({ ...base, player: { n: 'n001', st: 'playing', pos: 15.4 } }), [])
  // pausado pero debería sonar
  assert.deepEqual(m.plan({ ...base, player: { n: 'n001', st: 'paused', pos: 15 } }), [{ op: 'play' }])
  // sonando pero debería estar en pausa (y con la posición que dice el estado)
  const pausa = { ...s, play: false, pos: 20 }
  assert.deepEqual(m.plan({ ...base, state: pausa, player: { n: 'n001', st: 'playing', pos: 20 } }), [{ op: 'pause' }])
  assert.deepEqual(m.plan({ ...base, state: pausa, player: { n: 'n001', st: 'paused', pos: 20.5 } }), [])
  assert.deepEqual(m.plan({ ...base, state: pausa, player: { n: 'n001', st: 'paused', pos: 3 } }), [{ op: 'seek', pos: 20 }])
  // desvío grande sonando: corrige; uno pequeño no; ni con la corrección reciente
  assert.deepEqual(m.plan({ ...base, player: { n: 'n001', st: 'playing', pos: 40 } }), [{ op: 'seek', pos: 15 }])
  assert.deepEqual(m.plan({ ...base, player: { n: 'n001', st: 'playing', pos: 13 } }), [])
  assert.deepEqual(m.plan({ ...base, lastSeekAt: 3000, player: { n: 'n001', st: 'playing', pos: 40 } }), [])
  // suena otro vídeo (un anuncio): no se le pide nada aunque el desvío sea enorme
  assert.deepEqual(m.plan({ ...base, player: { n: 'n001', st: 'playing', pos: 40, vid: 'anuncio0001' } }), [])
  assert.deepEqual(m.plan({ ...base, player: { n: 'n001', st: 'playing', pos: 40, vid: V1 } }), [{ op: 'seek', pos: 15 }])
  // cargando o con error: no se le pide nada
  assert.deepEqual(m.plan({ ...base, player: { n: 'n001', st: 'loading', pos: 0 } }), [])
  assert.deepEqual(m.plan({ ...base, player: { n: 'n001', st: 'error', pos: 0 } }), [])
  // cola agotada: se para
  const fin = m.next(s, A)
  assert.deepEqual(m.plan({ ...base, state: fin, player: { n: 'n001', st: 'ended', pos: 200 } }), [{ op: 'stop' }])
  assert.deepEqual(m.plan({ ...base, state: fin }), [])
})

test('shouldAdvance solo cuando la pista que acaba es la que toca', async () => {
  const m = await load()
  const s = m.addTrack(m.emptyState(), track(V1, 'n001'), A)
  assert.ok(m.shouldAdvance({ state: s, player: { n: 'n001', st: 'ended' } }))
  assert.ok(!m.shouldAdvance({ state: s, player: { n: 'n001', st: 'playing' } }))
  assert.ok(!m.shouldAdvance({ state: s, player: { n: 'vieja', st: 'ended' } }))
  assert.ok(!m.shouldAdvance({ state: s, player: { n: null, st: 'ended' } }))
})

test('errores del reproductor: se explican y se distingue qué vale la pena saltar', async () => {
  const m = await load()
  for (const c of [100, 101, 150, 2]) assert.ok(m.SKIP_ERRORS.has(c))
  for (const c of [152, 153]) assert.ok(!m.SKIP_ERRORS.has(c) && m.BLOCKED_ERRORS.has(c))
  assert.match(m.explainError(150), /no permite/)
  assert.match(m.explainError(100), /ya no existe/)
  assert.match(m.explainError(153), /no deja reproducirlo/)
  assert.match(m.explainError(999), /999/)
})

test('newTrack genera identificadores únicos y válidos, y rechaza vídeos que no lo son', async () => {
  const m = await load()
  const ns = new Set()
  for (let k = 0; k < 500; k++) { const t = m.newTrack(V1, { title: 'x', author: 'y' }, A); assert.ok(t); ns.add(t.n) }
  assert.equal(ns.size, 500)
  assert.equal(m.newTrack('corto', {}, A), null)
  assert.equal(m.newTrack(V1, null, A).t, 'Vídeo de YouTube')
})

// ───────────── Lado del proceso principal (sin Electron: la red llega por parámetro) ─────────────

const { fetchMeta, fetchThumb } = require('../src/main/ytmeta')
const { cleanCommand, cleanEvent } = require('../src/main/musicplayer')
const reply = (status, body, headers = {}) => async () => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => { if (body === undefined) throw new Error('no es JSON'); return body },
  arrayBuffer: async () => body
})

test('oEmbed: título y canal, y distingue «no se puede reproducir fuera de YouTube» de «no existe»', async () => {
  const ok = await fetchMeta('dQw4w9WgXcQ', reply(200, { title: '  Una   canción \u0007 ', author_name: 'Un canal', html: '<iframe>' }))
  assert.deepEqual(ok, { ok: true, title: 'Una canción', author: 'Un canal' })
  assert.equal((await fetchMeta('dQw4w9WgXcQ', reply(200, { title: 'x'.repeat(500) }))).title.length, 120)
  assert.deepEqual(await fetchMeta('dQw4w9WgXcQ', reply(401, {})), { ok: false, reason: 'noembed' })
  assert.deepEqual(await fetchMeta('dQw4w9WgXcQ', reply(404, {})), { ok: false, reason: 'notfound' })
  assert.deepEqual(await fetchMeta('corto', reply(200, {})), { ok: false, reason: 'invalid' })
  // sin conexión, límite de peticiones o respuesta rara: se deja añadir (el reproductor avisará si falla)
  for (const f of [async () => { throw new Error('ECONNRESET') }, reply(429, {}), reply(503, {}), reply(200, undefined)]) {
    const r = await fetchMeta('dQw4w9WgXcQ', f)
    assert.deepEqual([r.ok, r.unknown, r.title], [true, true, null])
  }
  // la petición solo lleva el identificador del vídeo
  let visto = null
  await fetchMeta('dQw4w9WgXcQ', async (u, o) => { visto = { u, o }; return reply(200, { title: 't' })() })
  assert.match(visto.u, /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DdQw4w9WgXcQ$/)
  assert.ok(visto.o.signal, 'con límite de tiempo')
})

test('miniatura: solo un JPEG razonable de i.ytimg.com, como data:', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  const t = await fetchThumb('dQw4w9WgXcQ', reply(200, jpg, { 'content-type': 'image/jpeg' }))
  assert.equal(t, 'data:image/jpeg;base64,' + jpg.toString('base64'))
  assert.equal(await fetchThumb('dQw4w9WgXcQ', reply(200, jpg, { 'content-type': 'text/html' })), null)
  assert.equal(await fetchThumb('dQw4w9WgXcQ', reply(200, Buffer.alloc(400 * 1024), { 'content-type': 'image/jpeg' })), null)
  assert.equal(await fetchThumb('dQw4w9WgXcQ', reply(404, jpg, { 'content-type': 'image/jpeg' })), null)
  assert.equal(await fetchThumb('dQw4w9WgXcQ', async () => { throw new Error('x') }), null)
  assert.equal(await fetchThumb('../../etc/passwd', reply(200, jpg, { 'content-type': 'image/jpeg' })), null)
  let url = null
  await fetchThumb('dQw4w9WgXcQ', async (u) => { url = u; return reply(404, null)() })
  assert.equal(url, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg')
})

test('el proceso principal solo acepta órdenes y eventos con la forma exacta', () => {
  assert.deepEqual(cleanCommand({ op: 'load', v: 'dQw4w9WgXcQ', n: 'abcd1234', pos: 12.5, play: 1, extra: 'x' }), { op: 'load', v: 'dQw4w9WgXcQ', n: 'abcd1234', pos: 12.5, play: true })
  assert.equal(cleanCommand({ op: 'load', v: 'dQw4w9WgXcQ', n: 'abcd1234', pos: 1e12 }).pos, 86400)
  assert.equal(cleanCommand({ op: 'load', v: 'dQw4w9WgXcQ', n: 'abcd1234', pos: -3 }).pos, 0)
  assert.equal(cleanCommand({ op: 'load', v: '"><script>', n: 'abcd1234' }), null)
  assert.equal(cleanCommand({ op: 'load', v: 'dQw4w9WgXcQ', n: 'x' }), null)
  assert.deepEqual(cleanCommand({ op: 'volume', vol: 250, mute: 'sí' }), { op: 'volume', vol: 100, mute: true })
  assert.deepEqual(cleanCommand({ op: 'seek', pos: 7 }), { op: 'seek', pos: 7 })
  for (const op of ['play', 'pause', 'stop']) assert.deepEqual(cleanCommand({ op, junk: 1 }), { op })
  for (const bad of [null, undefined, 'load', {}, { op: 'eval' }, { op: 'navigate', url: 'file:///etc/passwd' }]) assert.equal(cleanCommand(bad), null)

  assert.deepEqual(cleanEvent({ e: 'tick', n: 'abcd1234', st: 'playing', pos: 3.5, dur: 212, vid: 'dQw4w9WgXcQ', otra: 1 }), { e: 'tick', n: 'abcd1234', st: 'playing', pos: 3.5, dur: 212, vid: 'dQw4w9WgXcQ' })
  assert.equal(cleanEvent({ e: 'tick', vid: '<script>' }).vid, null)
  assert.deepEqual(cleanEvent({ e: 'error', n: 'abcd1234', st: 'error', pos: 0, dur: 0, code: 150 }), { e: 'error', n: 'abcd1234', st: 'error', pos: 0, dur: 0, vid: null, code: 150 })
  assert.equal(cleanEvent({ e: 'state', n: 'no valido!', st: 'rarísimo', pos: NaN, dur: 'x' }).st, 'none')
  assert.equal(cleanEvent({ e: 'state', n: 'no valido!', st: 'x', pos: NaN, dur: 'x' }).n, null)
  assert.equal(cleanEvent({ e: 'state', st: 'playing', pos: Infinity }).pos, 0)
  for (const bad of [null, {}, { e: 'otro' }, 'x']) assert.equal(cleanEvent(bad), null)
})

test('el estado más grande posible cabe holgado en el límite de 64 KB de una señal', async () => {
  const m = await load()
  const lleno = {
    rev: 999999999, by: A, i: 49, play: true, pos: 86400,
    q: Array.from({ length: 50 }, (_, k) => ({ v: V1, n: 'z'.repeat(24 - String(k).length) + k, t: 'ñ'.repeat(120), a: 'á'.repeat(60), by: B }))
  }
  const s = m.validateState(lleno)
  assert.ok(s, 'el estado máximo es válido')
  const tam = JSON.stringify({ k: 'mus', d: { t: 'st', s } }).length
  assert.ok(tam < 32 * 1024, 'ocupa ' + tam + ' caracteres')
})
