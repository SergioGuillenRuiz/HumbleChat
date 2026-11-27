// Inactividad en una llamada (lógica pura, sin pantalla): qué hay que hacer según cuánto lleva el usuario sin actividad.
//   · pasado `muteAfterMs` (30 min) sin actividad: se silencia el micrófono;
//   · `warnBeforeMs` (5 min) antes de `leaveAfterMs` (1 h): se avisa;
//   · pasado `leaveAfterMs`: se sale de la llamada, pero SOLO si el sistema sabe de verdad cuánto lleva sin tocarse
//     (`osKnown`). Si no se sabe, no se echa a nadie: un falso positivo (echar a quien está jugando) es peor que no hacer nada.
// Actividad = uso del sistema, hablar o usar la ventana: `idleMs` es el menor de los tiempos que se conozcan.

export const AFK = { muteAfterMs: 30 * 60 * 1000, leaveAfterMs: 60 * 60 * 1000, warnBeforeMs: 5 * 60 * 1000, backMs: 60 * 1000 }

/** Menor tiempo sin actividad entre las fuentes conocidas (null = no se conoce). */
export function idleOf({ osMs = null, windowMs = null, speechMs = null }) {
  const known = [osMs, windowMs, speechMs].filter((x) => Number.isFinite(x) && x >= 0)
  return known.length ? Math.min(...known) : 0
}

/**
 * @param {object} s
 * @param {number} s.idleMs
 * @param {boolean} s.osKnown          ¿se sabe de verdad lo que lleva el sistema sin actividad?
 * @param {boolean} s.muted            micrófono ya silenciado (o ensordecido, o sin micro)
 * @param {boolean} s.muteOn           ajuste: silenciar por inactividad
 * @param {boolean} s.leaveOn          ajuste: salir de la llamada por inactividad
 * @param {{ muted: boolean, warned: boolean }} s.flags  lo ya hecho en esta racha de inactividad
 * @param {object} [s.limits]
 * @returns {{ action: 'none'|'mute'|'warn'|'leave', flags: { muted: boolean, warned: boolean } }}
 */
export function afkStep({ idleMs, osKnown, muted, muteOn, leaveOn, flags, limits = AFK }) {
  if (idleMs < limits.backMs) return { action: 'none', flags: { muted: false, warned: false } } // ha vuelto: nueva racha
  if (leaveOn && osKnown && idleMs >= limits.leaveAfterMs) return { action: 'leave', flags }
  if (leaveOn && osKnown && idleMs >= limits.leaveAfterMs - limits.warnBeforeMs && !flags.warned) return { action: 'warn', flags: { ...flags, warned: true } }
  if (muteOn && !muted && !flags.muted && idleMs >= limits.muteAfterMs) return { action: 'mute', flags: { ...flags, muted: true } }
  return { action: 'none', flags }
}
