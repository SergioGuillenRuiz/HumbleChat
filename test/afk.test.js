'use strict'
// Inactividad en una llamada: detección del sistema (idle.js) y decisiones (afklogic.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { osIdleSeconds, parseGdbusUint } = require('../src/main/idle')

const MIN = 60 * 1000
const base = { osKnown: true, muted: false, muteOn: true, leaveOn: true, flags: { muted: false, warned: false } }

test('parseGdbusUint entiende la respuesta de gdbus', () => {
  assert.equal(parseGdbusUint('(uint64 1234,)\n'), 1234)
  assert.equal(parseGdbusUint('(uint32 0,)'), 0)
  assert.equal(parseGdbusUint('(5000,)'), 5000)
  assert.equal(parseGdbusUint('Error: no such name'), null)
  assert.equal(parseGdbusUint(''), null)
})

test('osIdleSeconds: Windows/X11 usan Electron; Wayland pregunta al escritorio; sin respuesta, null', async () => {
  const pm = (v) => ({ getSystemIdleTime: () => v })
  assert.equal(await osIdleSeconds({ powerMonitor: pm(42), wayland: false, platform: 'win32', env: {} }), 42)
  assert.equal(await osIdleSeconds({ powerMonitor: pm(7), wayland: false, platform: 'linux', env: {} }), 7)
  // Wayland: lo de Electron no vale (no ve las aplicaciones nativas de Wayland): se usa GNOME por D-Bus
  const gdbus = (out, err = null) => (cmd, args, opts, cb) => { assert.equal(cmd, 'gdbus'); assert.ok(args.includes('org.gnome.Mutter.IdleMonitor')); assert.ok(opts.timeout > 0); cb(err, out) }
  assert.equal(await osIdleSeconds({ powerMonitor: pm(9999), wayland: true, platform: 'linux', env: {}, exec: gdbus('(uint64 2500,)\n') }), 2.5)
  assert.equal(await osIdleSeconds({ powerMonitor: pm(9999), wayland: true, platform: 'linux', env: {}, exec: gdbus('', new Error('sin gdbus')) }), null, 'sin forma de saberlo: null, nunca el valor de Electron')
  assert.equal(await osIdleSeconds({ powerMonitor: pm(9999), wayland: true, platform: 'linux', env: {}, exec: gdbus('basura') }), null)
  // valores absurdos o errores
  assert.equal(await osIdleSeconds({ powerMonitor: pm(NaN), wayland: false, platform: 'win32', env: {} }), null)
  assert.equal(await osIdleSeconds({ powerMonitor: { getSystemIdleTime() { throw new Error('x') } }, wayland: false, platform: 'win32', env: {} }), null)
  // solo pruebas
  assert.equal(await osIdleSeconds({ powerMonitor: pm(1), wayland: false, platform: 'linux', env: { HUMBLECHAT_FAKE_IDLE: '123' } }), 123)
})

test('la inactividad es el menor tiempo conocido: hablar, tocar la ventana o el sistema cuentan como actividad', async () => {
  const { idleOf } = await import('../src/renderer/afklogic.js')
  assert.equal(idleOf({ osMs: 50 * MIN, windowMs: 40 * MIN, speechMs: 45 * MIN }), 40 * MIN)
  assert.equal(idleOf({ osMs: 50 * MIN, windowMs: 40 * MIN, speechMs: 2 * 1000 }), 2000, 'si estás hablando no estás inactivo')
  assert.equal(idleOf({ osMs: null, windowMs: 40 * MIN, speechMs: 45 * MIN }), 40 * MIN, 'sin dato del sistema, se usan los demás')
  assert.equal(idleOf({}), 0, 'sin ningún dato, no hay inactividad')
})

test('a los 30 min sin actividad se silencia, una sola vez; la hora saca de la llamada con aviso 5 min antes', async () => {
  const { afkStep } = await import('../src/renderer/afklogic.js')
  const step = (idleMin, over = {}) => afkStep({ ...base, idleMs: idleMin * MIN, ...over })
  assert.equal(step(10).action, 'none')
  assert.equal(step(29.9).action, 'none')
  const m = step(30)
  assert.equal(m.action, 'mute')
  assert.equal(step(31, { flags: m.flags }).action, 'none', 'ya silenciado en esta racha: no repite')
  assert.equal(step(54, { flags: m.flags, muted: true }).action, 'none')
  const w = step(55, { flags: m.flags, muted: true })
  assert.equal(w.action, 'warn', 'avisa 5 min antes de la hora')
  assert.equal(step(57, { flags: w.flags, muted: true }).action, 'none', 'el aviso es uno solo')
  assert.equal(step(60, { flags: w.flags, muted: true }).action, 'leave')
  assert.equal(step(120, { flags: w.flags, muted: true }).action, 'leave')
})

test('quien ya tiene el micro silenciado no se vuelve a silenciar; los ajustes desactivan cada paso', async () => {
  const { afkStep } = await import('../src/renderer/afklogic.js')
  const step = (idleMin, over = {}) => afkStep({ ...base, idleMs: idleMin * MIN, ...over })
  assert.equal(step(35, { muted: true }).action, 'none')
  assert.equal(step(35, { muteOn: false }).action, 'none', 'silenciar desactivado')
  assert.equal(step(61, { leaveOn: false, muted: true }).action, 'none', 'salir desactivado')
  assert.equal(step(61, { leaveOn: false }).action, 'mute', 'con salir desactivado, silenciar sigue funcionando')
})

test('sin saber de verdad lo que lleva el sistema inactivo, nunca se echa a nadie (solo se puede silenciar)', async () => {
  const { afkStep } = await import('../src/renderer/afklogic.js')
  const r = afkStep({ ...base, osKnown: false, idleMs: 3 * 60 * MIN })
  assert.equal(r.action, 'mute')
  const after = afkStep({ ...base, osKnown: false, idleMs: 3 * 60 * MIN, muted: true, flags: r.flags })
  assert.equal(after.action, 'none', 'ni siquiera tras horas')
})

test('al volver (actividad) empieza una racha nueva: puede volver a silenciarse y avisar', async () => {
  const { afkStep } = await import('../src/renderer/afklogic.js')
  let r = afkStep({ ...base, idleMs: 56 * MIN, muted: true, flags: { muted: true, warned: true } })
  assert.equal(r.action, 'none')
  r = afkStep({ ...base, idleMs: 5 * 1000, muted: true, flags: { muted: true, warned: true } })
  assert.deepEqual(r, { action: 'none', flags: { muted: false, warned: false } })
  assert.equal(afkStep({ ...base, idleMs: 31 * MIN, flags: r.flags }).action, 'mute')
})
