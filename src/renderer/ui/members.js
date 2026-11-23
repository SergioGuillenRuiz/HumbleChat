// Lista de miembros (derecha): en línea / sin conexión.
import { h, avatar, fill } from '../util.js'
import { state, bus } from '../state.js'

let root

export function mountMembers(el) {
  root = el
  bus.on('members', render)
  bus.on('toggleMembers', render)
  render()
}

function row(m) {
  return h('div.member' + (m.online ? '' : '.offline'),
    h('div.m-avatar', avatar(m, 32), h('span.status-dot' + (m.online ? '.online' : '.off'))),
    h('span.m-name', m.name + (m.id === state.me.id ? ' (tú)' : '')))
}

function render() {
  root.classList.toggle('hidden', !state.showMembers)
  const sorted = [...state.members].sort((a, b) => a.name.localeCompare(b.name, 'es'))
  const on = sorted.filter((m) => m.online)
  const off = sorted.filter((m) => !m.online)
  fill(root,
    h('div.m-cat', `En línea — ${on.length}`), ...on.map(row),
    off.length > 0 && h('div.m-cat', `Sin conexión — ${off.length}`),
    ...off.map(row))
}
