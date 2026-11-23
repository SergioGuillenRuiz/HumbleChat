// Barra de canales: menú del servidor, texto y voz con participantes, panel de llamada y de usuario.
import { h, avatar, fill, store } from '../util.js'
import { icon } from '../icons.js'
import { state, bus, member, markRead, channel } from '../state.js'
import { voice, isMuted } from '../voice.js'
import { openSettings, openVolumeMenu, openContextMenu, openInvite, openChannelModal, confirmModal, toast } from './overlays.js'
import { openProfile } from './popout.js'

let root

export function mountSidebar(el) {
  root = el
  for (const evt of ['members', 'voice', 'unread', 'view', 'status', 'collapsed', 'channels', 'dms']) bus.on(evt, render)
  bus.on('speaking', applySpeaking)
  render()
}

export function openChannel(ch) {
  const c = channel(ch)
  if (!c) return
  if (c.type === 'voice' && state.voice?.ch !== ch) voice.join(ch)
  state.view.ch = ch
  bus.emit('view')
}

/** Abre (y deja en la lista) la conversación directa con un amigo. */
export function openDm(peer) {
  if (!state.dms.has(peer)) { state.dms.set(peer, 0); bus.emit('dms') }
  openChannel('dm:' + peer)
}

const failure = (e) => toast(String(e.message || e).replace(/^Error invoking remote method '[\w:]+': (Error: )?/, ''), 'warn')

async function deleteChannelFlow(c) {
  const ok = await confirmModal({ title: 'Eliminar canal', body: h('p', `¿Eliminar ${c.type === 'text' ? '#' : ''}${c.name} para todos? Los mensajes dejarán de verse.`), confirm: 'Eliminar canal', danger: true })
  if (ok) await window.humble.channelDelete(c.id).catch(failure)
}

async function channelDialog(opts) {
  const r = await openChannelModal(opts)
  if (!r) return
  try {
    if (opts.channel) {
      if (r.remove) await deleteChannelFlow(opts.channel)
      else if (r.name.trim()) await window.humble.channelRename(opts.channel.id, r.name)
    } else {
      const id = await window.humble.channelCreate(r.kind, r.name)
      if (r.kind === 'text') setTimeout(() => state.channels.some((c) => c.id === id) && openChannel(id), 150) // un canal de voz nuevo no te mete en la llamada
    }
  } catch (e) { failure(e) }
}

const STATUS = {
  connecting: ['Buscando a tus amigos…', 'warn'],
  offline: ['Sin conexión a Internet', 'bad']
}

async function markAllRead() {
  for (const id of [...state.channels.filter((x) => x.type === 'text').map((x) => x.id), ...[...state.dms.keys()].map((p) => 'dm:' + p)]) {
    const last = (await window.humble.history(id, { limit: 1 }))[0]
    if (last) markRead(id, last.ts)
  }
  state.unread.clear()
  state.mentions.clear()
  bus.emit('unread')
}

function serverMenu(e) {
  const r = e.currentTarget.getBoundingClientRect()
  state.menuOpen = true
  render()
  const close = openContextMenu(r.left + 10, r.bottom + 4, [
    { label: 'Invitar a amigos', icon: 'invite', onclick: () => openInvite() },
    { label: 'Crear canal', icon: 'add', onclick: () => channelDialog({}) },
    { label: 'Marcar todo como leído', icon: 'check', onclick: markAllRead },
    'sep',
    { label: 'Ajustes de usuario', icon: 'cog', onclick: () => openSettings(voice) },
    { label: 'Estado de la conexión', icon: 'signal', onclick: () => openSettings(voice, 'diag') }
  ])
  const watch = setInterval(() => { if (!document.querySelector('.ctxmenu')) { clearInterval(watch); state.menuOpen = false; render() } }, 150)
  return close
}

function toggleCategory(id) {
  state.collapsed[id] = !state.collapsed[id]
  store('collapsed', state.collapsed)
  bus.emit('collapsed')
}

function render() {
  const text = state.channels.filter((c) => c.type === 'text')
  const voices = state.channels.filter((c) => c.type === 'voice')
  const dms = [...state.dms].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  const [stText, stKind] = state.status.mismatch
    ? ['Un amigo tiene otra versión de la app: instalad todos la misma', 'warn']
    : STATUS[state.status.state] || []

  fill(root,
    h('button.sb-header' + (state.menuOpen ? '.open' : ''), { onclick: serverMenu },
      h('span.sb-name', state.server), icon(state.menuOpen ? 'close' : 'chevron', 18)),
    stText && h('div.sb-status.' + stKind, h('span.dot'), stText),
    h('div.sb-scroll',
      dms.length > 0 && category('dm', 'Mensajes directos'),
      ...dms.filter((id) => !state.collapsed.dm || visibleDmCollapsed(id)).map(dmRow),
      category('text', 'Canales de texto', () => channelDialog({ kind: 'text' })),
      ...text.filter((c) => !state.collapsed.text || visibleWhenCollapsed(c)).map(textChannel),
      category('voice', 'Canales de voz', () => channelDialog({ kind: 'voice' })),
      ...voices.filter((c) => !state.collapsed.voice || visibleWhenCollapsed(c)).map(voiceChannel)
    ),
    state.voice && callPanel(),
    userPanel()
  )
  applySpeaking()
}

// Como Discord: una categoría plegada sigue mostrando el canal abierto, el no leído y las llamadas con gente.
const visibleWhenCollapsed = (c) =>
  state.view.ch === c.id || state.unread.has(c.id) || state.voice?.ch === c.id || state.members.some((m) => m.online && m.voice?.ch === c.id)

const visibleDmCollapsed = (id) => state.view.ch === 'dm:' + id || state.unread.has('dm:' + id)

const category = (id, label, onAdd) => h('div.cat' + (state.collapsed[id] ? '.collapsed' : ''), { onclick: () => toggleCategory(id) },
  icon('chevronRight', 12), h('span.cat-label', label),
  onAdd && h('button.cat-add', { tip: id === 'voice' ? 'Crear canal de voz' : 'Crear canal de texto', tipPos: 'top', onclick: (e) => { e.stopPropagation(); onAdd() } }, icon('add', 16)))

function dmRow(id) {
  const m = member(id)
  const unread = state.unread.has('dm:' + id) && state.view.ch !== 'dm:' + id
  const pings = state.mentions.get('dm:' + id) || 0
  return h('div.ch.dm' + (state.view.ch === 'dm:' + id ? '.selected' : '') + (unread ? '.unread' : ''), { onclick: () => openChannel('dm:' + id) },
    h('span.pill'), h('div.dm-avatar', avatar(m, 24), h('span.status-dot.mini' + (m.online ? '.online' : '.off'))),
    h('span.ch-name', m.name),
    pings > 0 && state.view.ch !== 'dm:' + id && h('span.badge', String(pings)))
}

function channelMenu(e, c) {
  e.preventDefault()
  openContextMenu(e.clientX, e.clientY, [
    { label: 'Editar canal', icon: 'cog', onclick: () => channelDialog({ channel: c }) },
    'sep',
    { label: 'Eliminar canal', icon: 'trash', danger: true, onclick: () => deleteChannelFlow(c) }
  ])
}

function textChannel(c) {
  const unread = state.unread.has(c.id) && state.view.ch !== c.id
  const pings = state.mentions.get(c.id) || 0
  return h('div.ch' + (state.view.ch === c.id ? '.selected' : '') + (unread ? '.unread' : ''),
    { onclick: () => openChannel(c.id), oncontextmenu: (e) => channelMenu(e, c) },
    h('span.pill'), icon('hash', 20), h('span.ch-name', c.name),
    pings > 0 && state.view.ch !== c.id && h('span.badge', String(pings)),
    gear(c))
}

const gear = (c) => h('button.ch-gear', { tip: 'Editar canal', tipPos: 'top', onclick: (e) => { e.stopPropagation(); channelDialog({ channel: c }) } }, icon('cog', 16))

function voiceChannel(c) {
  const inside = state.members.filter((m) => m.online && m.voice?.ch === c.id)
  return h('div.vch',
    h('div.ch' + (state.view.ch === c.id ? '.selected' : '') + (state.voice?.ch === c.id ? '.connected' : ''),
      { onclick: () => openChannel(c.id), oncontextmenu: (e) => channelMenu(e, c), tip: state.voice?.ch === c.id ? '' : 'Pulsa para unirte a la llamada', tipPos: 'right' },
      h('span.pill'), icon('speaker', 20), h('span.ch-name', c.name),
      inside.length > 0 && h('span.vcount', inside.length + ' ' + (inside.length === 1 ? 'persona' : 'personas')),
      gear(c)),
    inside.length > 0 && h('div.vusers', ...inside.map((m) => vuser(m))))
}

function vuser(m) {
  const isMe = m.id === state.me.id
  const v = m.voice
  return h('div.vuser', {
    dataset: { uid: m.id },
    onclick: (e) => openProfile(e.currentTarget, m.id),
    oncontextmenu: (e) => { if (!isMe) { e.preventDefault(); openVolumeMenu(e.clientX, e.clientY, m.id, voice) } }
  },
    avatar(m, 24, 'speak-ring'),
    h('span.vname', m.name),
    v?.share && h('span.live', 'EN VIVO'),
    v?.cam && h('span.vstate', { tip: 'Cámara encendida', tipPos: 'top' }, icon('camera', 16)),
    (v?.mute || v?.deaf) && h('span.vstate', { tip: v.deaf ? 'Ensordecido' : 'Silenciado', tipPos: 'top' }, icon(v.deaf ? 'headphonesOff' : 'micOff', 16)))
}

const pingClass = (ms) => (ms == null || ms < 120 ? '' : ms < 250 ? '.warn' : '.bad')

function callPanel() {
  const c = state.channels.find((x) => x.id === state.voice.ch)
  const v = state.voice
  return h('div.callpanel',
    h('div.cp-top',
      h('div.cp-info',
        h('div.cp-state' + pingClass(v.ping), icon('signal', 16), 'Voz conectada',
          v.ping != null && h('span.cp-ping', v.ping + ' ms')),
        h('div.cp-where', `${c?.name || ''} / ${state.server}`)),
      h('button.icon-btn', { tip: 'Desconectar', tipPos: 'top', onclick: () => voice.leave() }, icon('hangup', 20))),
    h('div.cp-actions',
      h('button.cp-btn' + (v.cam ? '.on' : ''), { tip: v.cam ? 'Apagar cámara' : 'Encender cámara', onclick: () => voice.toggleCamera() }, icon(v.cam ? 'camera' : 'cameraOff', 18)),
      h('button.cp-btn' + (v.sharing ? '.on' : ''), {
        tip: v.sharing ? 'Dejar de compartir pantalla' : 'Compartir tu pantalla', onclick: () => (v.sharing ? voice.stopShare() : voice.startShare())
      }, icon('screen', 18))))
}

function userPanel() {
  const me = member(state.me.id)
  const inCall = !!state.voice
  const muted = isMuted()
  const sub = inCall ? (state.voice.deafened ? 'Ensordecido' : muted ? 'Silenciado' : 'En llamada') : 'En línea'
  const needCall = () => toast('Únete a un canal de voz primero.')
  return h('div.userpanel',
    h('div.up-id', { tip: 'Ajustes de usuario', tipPos: 'top', onclick: () => openSettings(voice) },
      h('div.up-avatar', avatar(me, 32, 'speak-ring'), h('span.status-dot.online')),
      h('div.up-text', h('div.up-name', me.name), h('div.up-sub', sub))),
    h('div.up-btns',
      h('button.icon-btn' + (muted ? '.off' : ''), {
        tip: muted ? 'Activar micrófono (Ctrl+Mayús+M)' : 'Silenciar (Ctrl+Mayús+M)', tipPos: 'top',
        onclick: () => (state.voice ? voice.toggleMute() : needCall())
      }, icon(muted ? 'micOff' : 'mic', 20)),
      h('button.icon-btn' + (state.voice?.deafened ? '.off' : ''), {
        tip: state.voice?.deafened ? 'Dejar de ensordecer (Ctrl+Mayús+D)' : 'Ensordecer (Ctrl+Mayús+D)', tipPos: 'top',
        onclick: () => (state.voice ? voice.toggleDeafen() : needCall())
      }, icon(state.voice?.deafened ? 'headphonesOff' : 'headphones', 20)),
      h('button.icon-btn', { tip: 'Ajustes de usuario', tipPos: 'top', onclick: () => openSettings(voice) }, icon('cog', 20))))
}

export function applySpeaking() {
  for (const el of root.querySelectorAll('[data-uid]')) {
    el.classList.toggle('speaking', state.speaking.has(el.dataset.uid))
  }
  const me = root.querySelector('.up-avatar .avatar')
  me?.classList.toggle('speaking', state.speaking.has(state.me.id))
}
