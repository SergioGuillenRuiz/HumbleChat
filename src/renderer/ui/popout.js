// Tarjeta de perfil al pulsar un nombre o avatar (como el popout de Discord).
import { h, avatar, colorFor } from '../util.js'
import { icon } from '../icons.js'
import { state, member, channel, bus } from '../state.js'
import { voice } from '../voice.js'
import { openSettings } from './overlays.js'
import { openDm } from './sidebar.js'

export function openProfile(anchor, id) {
  document.querySelector('.profile-card')?.remove()
  const m = member(id)
  const isMe = id === state.me.id
  const inVoice = m.online && m.voice ? channel(m.voice.ch) : null
  const status = isMe || m.online ? 'En línea' : 'Sin conexión'
  const joined = state.voice?.ch === m.voice?.ch

  const card = h('div.profile-card',
    h('div.pc-banner', { style: { background: colorFor(id) } }),
    h('div.pc-avatar', avatar(m, 80), h('span.status-dot.big' + (isMe || m.online ? '.online' : '.off'))),
    h('div.pc-body',
      h('div.pc-name', m.name + (isMe ? ' (tú)' : '')),
      h('div.pc-status', status),
      h('div.pc-sep'),
      inVoice && h('div.pc-section', h('div.pc-title', 'En llamada'),
        h('div.pc-voice', icon('speaker', 18), h('span', inVoice.name),
          !joined && h('button.btn.green.small', { onclick: () => { card.remove(); voice.join(inVoice.id); state.view.ch = inVoice.id; bus.emit('view') } }, 'Unirse'))),
      !isMe && h('button.btn.brand.wide', { onclick: () => { card.remove(); openDm(id) } }, 'Enviar mensaje'),
      isMe && h('button.btn.secondary.wide', { onclick: () => { card.remove(); openSettings(voice) } }, 'Editar perfil'),
      !isMe && !inVoice && h('div.pc-muted', m.online ? 'Conectado, sin llamada.' : 'Se ha ido por ahora. Verá lo que escribas cuando vuelva.')))
  document.body.append(card)
  const r = anchor.getBoundingClientRect()
  const w = card.offsetWidth
  const hh = card.offsetHeight
  const left = r.right + 8 + w < innerWidth ? r.right + 8 : r.left - w - 8
  card.style.left = Math.max(8, left) + 'px'
  card.style.top = Math.max(8, Math.min(r.top - 20, innerHeight - hh - 8)) + 'px'
  const close = () => { card.remove(); removeEventListener('mousedown', off, true); removeEventListener('keydown', onKey, true) }
  const off = (e) => { if (!card.contains(e.target)) close() }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  setTimeout(() => { addEventListener('mousedown', off, true); addEventListener('keydown', onKey, true) })
}
