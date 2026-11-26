// Pantalla de actualización obligatoria. La usan la ventana de arranque (gate.html, sin red) y, en plena sesión,
// la capa que tapa la aplicación cuando aparece una versión nueva.
import { h } from '../util.js'

const REASON = {
  outdated: 'Hay una versión más nueva y HumbleChat solo funciona con la última.',
  'known-outdated': 'No hay conexión para comprobarlo, pero ya se vio una versión más nueva que la tuya.'
}

/** Rellena `root` según el mensaje de estado que manda el proceso principal. */
export function renderGate(root, u) {
  root.replaceChildren()
  if (!u || u.state !== 'forced') return
  const manual = u.mode === 'manual'
  const open = () => window.humble.openExternal(u.url || 'https://github.com')
  const body = [
    h('div.setup-logo', 'H'),
    h('h1', 'Actualización obligatoria'),
    h('p.muted', `${REASON[u.reason] || REASON.outdated} Tienes la versión ${u.current} y la última es la ${u.version}.`)
  ]
  if (manual) {
    body.push(
      h('p.muted', 'Descarga la versión nueva, instálala y vuelve a abrir HumbleChat. Mientras tanto no se conecta a tus amigos.'),
      h('button.btn.brand.big#gate-download', { onclick: open }, `Descargar la versión ${u.version}`),
      h('div.row', h('button.btn.secondary#gate-recheck', { onclick: async (e) => { e.target.disabled = true; await window.humble.updateRecheck().catch(() => {}); e.target.disabled = false } }, 'Ya la instalé, volver a comprobar'),
        h('button.btn.secondary#gate-quit', { onclick: () => window.humble.quit() }, 'Salir'))
    )
  } else {
    const stage = u.stage || 'checking'
    const text = {
      checking: 'Buscando la actualización…',
      downloading: `Descargando la actualización… ${u.percent ?? 0} %`,
      installing: 'Instalando y reiniciando…',
      error: `No se pudo descargar la actualización (${u.message || 'error desconocido'}). Se reintenta sola cada minuto.`
    }[stage]
    body.push(
      h('p.gate-stage#gate-stage', text),
      h('div.gate-bar', h('div.gate-fill', { style: { width: `${stage === 'installing' ? 100 : stage === 'downloading' ? u.percent ?? 0 : 0}%` } })),
      stage === 'error' && h('button.btn.secondary#gate-download', { onclick: open }, 'Descargar a mano'),
      h('div.row', h('button.btn.secondary#gate-quit', { onclick: () => window.humble.quit() }, 'Salir'))
    )
  }
  root.append(...body.filter(Boolean))
}
