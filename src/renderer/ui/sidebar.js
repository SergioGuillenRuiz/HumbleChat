// Barra de canales: texto, voz con participantes, panel de llamada y panel de usuario.
import { h, avatar, fill } from '../util.js'
import { icon } from '../icons.js'
import { state, bus, member } from '../state.js'
import { voice, isMuted } from '../voice.js'
import { openSettings, openVolumeMenu, toast } from './overlays.js'

let root

export function mountSidebar(el) {
  root = el
  for (const evt of ['members', 'voice', 'unread', 'view', 'status']) bus.on(evt, render)
  bus.on('speaking', applySpeaking)
  render()
}

export function openChannel(ch) {
  const c = state.channels.find((x) => x.id === ch)
  if (!c) return
  if (c.type === 'voice' && state.voice?.ch !== ch) voice.join(ch)
  state.view.ch = ch
  bus.emit('view')
}

const STATUS = {
  connecting: ['Buscando a tus amigos…', 'warn'],
  offline: ['Sin conexión a Internet', 'bad']
}

function render() {
  const text = state.channels.filter((c) => c.type === 'text')
  const voices = state.channels.filter((c) => c.type === 'voice')
  const [stText, stKind] = STATUS[state.status.state] || []

  fill(root,
    h('div.sb-header', h('span.sb-name', state.server), icon('chevron', 18)),
    stText && h('div.sb-status.' + stKind, h('span.dot'), stText),
    h('div.sb-scroll',
      category('Canales de texto'),
      ...text.map(textChannel),
      category('Canales de voz'),
      ...voices.map(voiceChannel)
    ),
    state.voice && callPanel(),
    userPanel()
  )
  applySpeaking()
}

const category = (label) => h('div.cat', icon('chevronRight', 12), h('span', label))

function textChannel(c) {
  const unread = state.unread.has(c.id) && state.view.ch !== c.id
  return h('div.ch' + (state.view.ch === c.id ? '.selected' : '') + (unread ? '.unread' : ''),
    { onclick: () => openChannel(c.id) },
    h('span.pill'), icon('hash', 20), h('span.ch-name', c.name))
}

function voiceChannel(c) {
  const inside = state.members.filter((m) => m.online && m.voice?.ch === c.id)
  return h('div.vch',
    h('div.ch' + (state.view.ch === c.id ? '.selected' : '') + (state.voice?.ch === c.id ? '.connected' : ''),
      { onclick: () => openChannel(c.id) }, h('span.pill'), icon('speaker', 20), h('span.ch-name', c.name)),
    inside.length > 0 && h('div.vusers', ...inside.map((m) => vuser(m))))
}

function vuser(m) {
  const isMe = m.id === state.me.id
  const v = m.voice
  return h('div.vuser', {
    dataset: { uid: m.id },
    oncontextmenu: (e) => { if (!isMe) { e.preventDefault(); openVolumeMenu(e.clientX, e.clientY, m.id, voice) } }
  },
    avatar(m, 24, 'speak-ring'),
    h('span.vname', m.name),
    v?.share && h('span.live', 'EN VIVO'),
    (v?.mute || v?.deaf) && h('span.vstate', icon(v.deaf ? 'headphonesOff' : 'micOff', 16)))
}

function callPanel() {
  const c = state.channels.find((x) => x.id === state.voice.ch)
  return h('div.callpanel',
    h('div.cp-top',
      h('div.cp-info',
        h('div.cp-state', icon('signal', 16), 'Voz conectada'),
        h('div.cp-where', `${c?.name || ''} / ${state.server}`)),
      h('button.icon-btn', { title: 'Desconectar', onclick: () => voice.leave() }, icon('hangup', 20))),
    h('div.cp-actions',
      h('button.cp-btn' + (state.voice.sharing ? '.on' : ''), {
        onclick: () => (state.voice.sharing ? voice.stopShare() : voice.startShare())
      }, icon('screen', 18), state.voice.sharing ? 'Dejar de compartir' : 'Pantalla')))
}

function userPanel() {
  const me = member(state.me.id)
  const inCall = !!state.voice
  const muted = isMuted()
  const sub = inCall ? (state.voice.deafened ? 'Ensordecido' : muted ? 'Silenciado' : 'En llamada') : 'En línea'
  return h('div.userpanel',
    h('div.up-id', { title: 'Ajustes de usuario', onclick: () => openSettings(voice) },
      h('div.up-avatar', avatar(me, 32, 'speak-ring'), h('span.status-dot.online')),
      h('div.up-text', h('div.up-name', me.name), h('div.up-sub', sub))),
    h('div.up-btns',
      h('button.icon-btn' + (muted ? '.off' : ''), {
        title: muted ? 'Activar micrófono' : 'Silenciar',
        onclick: () => (state.voice ? voice.toggleMute() : toast('Únete a un canal de voz primero.'))
      }, icon(muted ? 'micOff' : 'mic', 20)),
      h('button.icon-btn' + (state.voice?.deafened ? '.off' : ''), {
        title: state.voice?.deafened ? 'Dejar de ensordecer' : 'Ensordecer',
        onclick: () => (state.voice ? voice.toggleDeafen() : toast('Únete a un canal de voz primero.'))
      }, icon(state.voice?.deafened ? 'headphonesOff' : 'headphones', 20)),
      h('button.icon-btn', { title: 'Ajustes de usuario', onclick: () => openSettings(voice) }, icon('cog', 20))))
}

export function applySpeaking() {
  for (const el of root.querySelectorAll('[data-uid]')) {
    el.classList.toggle('speaking', state.speaking.has(el.dataset.uid))
  }
  const me = root.querySelector('.up-avatar .avatar')
  me?.classList.toggle('speaking', state.speaking.has(state.me.id))
}
