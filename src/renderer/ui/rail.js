// Barra de salas (a la izquierda): una por sala, con lo no leído, y el botón de añadir.
import { h, fill, colorFor } from '../util.js'
import { icon } from '../icons.js'
import { state, bus } from '../state.js'
import { openContextMenu, openRoomModal, renameRoomFlow, leaveRoomFlow, leaveCallBeforeRoomChange, toast } from './overlays.js'

let root

export function mountRail(el) {
  root = el
  bus.on('rooms', render)
  render()
}

const failure = (e) => toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'warn', 8000)

async function switchTo(r) {
  if (r.active || state.roomsLocked) return
  if (!(await leaveCallBeforeRoomChange('Al cambiar de sala saldrás de la llamada.'))) return
  await window.humble.roomsSwitch(r.id).catch(failure) // la interfaz se recarga con la sala elegida
}

function menu(e, r) {
  e.preventDefault()
  openContextMenu(e.clientX, e.clientY, [
    { label: 'Copiar el código de la sala', icon: 'file', onclick: async () => navigator.clipboard.writeText(await window.humble.roomsCode(r.id)).then(() => toast('Código de sala copiado', 'ok')) },
    ...(state.roomsLocked ? [] : [
      { label: 'Renombrar', icon: 'cog', onclick: () => renameRoomFlow(r) },
      'sep',
      { label: 'Salir de la sala', icon: 'trash', danger: true, onclick: () => leaveRoomFlow(r) }
    ])
  ])
}

function item(r) {
  const initial = ([...r.name][0] || '?').toUpperCase()
  const unread = !r.active && r.unread > 0
  return h('div.rail-item' + (r.active ? '.active' : '') + (unread ? '.unread' : ''), {
    tip: r.name + (unread ? ` · ${r.unread} sin leer` : ''), tipPos: 'right',
    dataset: { room: r.id },
    onclick: () => switchTo(r),
    oncontextmenu: (e) => menu(e, r)
  },
    h('span.rail-pill'),
    h('div.rail-icon', { style: { background: colorFor(r.id) } }, h('span', initial)),
    !r.active && r.mentions > 0 && h('span.rail-badge', String(Math.min(r.mentions, 99))))
}

function render() {
  fill(root,
    ...state.rooms.map(item),
    !state.roomsLocked && h('div.rail-sep'),
    !state.roomsLocked && h('button.rail-add', { tip: 'Añadir o crear una sala', tipPos: 'right', onclick: () => openRoomModal() }, icon('add', 24)))
}
