import { h, $, store, append } from './util.js'
import { icon } from './icons.js'
import { state, bus, setMembers, channel } from './state.js'
import { mountSidebar, openChannel } from './ui/sidebar.js'
import { mountChat, showChannel, onEvents as onEventsChat, touchRead } from './ui/chat.js'
import { mountMembers } from './ui/members.js'
import { mountVoiceView, render as renderVoiceView } from './ui/voiceview.js'
import { voice } from './voice.js'
import { toast } from './ui/overlays.js'
import { play } from './sounds.js'
import { initTooltips } from './tooltip.js'

const isFirstLaunch = !store('firstRun')
const firstRun = store('firstRun') || (store('firstRun', Date.now()), Date.now())
let shownText = null

async function boot() {
  initTooltips()
  const init = await window.humble.init()
  state.firstRun = firstRun
  state.settings = init.settings
  state.version = init.version
  Object.assign(state, {
    me: init.me, server: init.server, channels: init.channels, status: init.status, platform: init.platform,
    pickerNeeded: init.pickerNeeded, limits: init.limits, iceServers: init.iceServers
  })
  setMembers(init.members)
  for (const peer of init.dms || []) state.dms.set(peer, init.last['dm:' + peer]?.ts || 0)
  for (const id of [...state.channels.map((c) => c.id), ...[...state.dms.keys()].map((p) => 'dm:' + p)]) {
    const last = init.last[id]
    if (last && last.a !== state.me.id && last.ts > (state.lastRead[id] || firstRun)) state.unread.add(id)
  }
  state.view.ch = state.channels.find((c) => c.type === 'text')?.id

  const sidebar = h('aside#sidebar')
  const chat = h('section#chat.pane')
  const voiceView = h('section#voiceview.pane.hidden')
  const membersEl = h('aside#members')
  append($('#app'), [
    state.platform === 'win32' && h('div#titlebar', icon('logo', 14), h('span', state.server)),
    h('div.shell',
      h('nav.rail',
        h('div.rail-item.active', { tip: state.server, tipPos: 'right' }, h('span.rail-pill'), h('div.rail-icon', h('span', state.server[0]))),
        h('div.rail-sep')),
      sidebar,
      h('main#main', chat, voiceView),
      membersEl)
  ])

  mountSidebar(sidebar)
  mountChat(chat)
  mountVoiceView(voiceView)
  mountMembers(membersEl)

  bus.on('view', onView)
  bus.on('toggleMembersClick', () => {
    state.showMembers = !state.showMembers
    store('showMembers', state.showMembers)
    bus.emit('toggleMembers')
  })
  bus.on('unread', () => {
    const pings = [...state.mentions.values()].reduce((a, b) => a + b, 0)
    document.title = (pings ? `(${pings}) ` : state.unread.size ? '• ' : '') + state.server
    window.humble.badge(pings || state.unread.size).catch(() => {}) // insignia en la barra de tareas / dock
  })
  window.addEventListener('focus', touchRead)
  // Pulsar para hablar: tecla global (desde Electron) y, además, con la ventana enfocada.
  const pttKey = (e) => state.prefs.ptt?.on && state.prefs.ptt.key?.code && e.code === state.prefs.ptt.key.code
  window.addEventListener('keydown', (e) => { if (pttKey(e) && !e.repeat) voice.setPtt(true) })
  window.addEventListener('keyup', (e) => { if (pttKey(e)) voice.setPtt(false) })
  if (state.prefs.ptt?.on) window.humble.pttConfigure({ on: true, hook: state.prefs.ptt.key?.hook }).catch(() => {})
  // Atajos como en Discord (dentro de la ventana): Ctrl+Mayús+M silencia, Ctrl+Mayús+D ensordece.
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey) || !state.voice) return
    if (e.code === 'KeyM') { e.preventDefault(); voice.toggleMute() }
    if (e.code === 'KeyD') { e.preventDefault(); voice.toggleDeafen() }
  })
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a.link')
    if (a) { e.preventDefault(); window.humble.openExternal(a.href) }
  })
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('textarea,input')) e.preventDefault() })

  window.humble.onMessage(onMessage)
  onView()
  bus.emit('unread')
  if (isFirstLaunch) setTimeout(() => toast(`Tus amigos te verán como «${state.me.name}». Puedes cambiarlo en Ajustes (⚙ abajo a la izquierda).`), 1500)
}

/** Aviso de versión nueva: se instalará sola (instalador/AppImage) o se abre la página de descarga. */
function showUpdate(u) {
  document.querySelector('.update-bar')?.remove()
  const text = { downloading: `Descargando la versión ${u.version}…`, ready: `La versión ${u.version} está lista.`, available: `Hay una versión nueva (${u.version}).` }[u.state]
  const bar = h('div.update-bar', h('span', text),
    u.state === 'ready' && h('button', { onclick: () => window.humble.updateInstall() }, 'Reiniciar para actualizar'),
    u.state === 'available' && h('button', { onclick: () => window.humble.openExternal(u.url) }, 'Descargar'),
    h('button', { onclick: () => bar.remove() }, 'Ahora no'))
  const shell = document.querySelector('.shell')
  shell.parentNode.insertBefore(bar, shell)
}

function onView() {
  const c = channel(state.view.ch)
  if (!c) { state.view.ch = state.channels.find((x) => x.type === 'text')?.id; return state.view.ch && onView() }
  const isText = c.type !== 'voice' // texto o conversación directa
  $('#chat').classList.toggle('hidden', !isText)
  $('#voiceview').classList.toggle('hidden', isText)
  if (isText) {
    if (shownText !== c.id) { shownText = c.id; showChannel(c.id) } else touchRead()
  } else renderVoiceView()
}

function onMessage(msg) {
  switch (msg.type) {
    case 'events': return onEvents(msg.evs, msg.updates)
    case 'typing': {
      const map = state.typing.get(msg.ch) || state.typing.set(msg.ch, new Map()).get(msg.ch)
      map.set(msg.id, Date.now() + 6000)
      return bus.emit('typing')
    }
    case 'members':
      setMembers(msg.members)
      state.me.name = state.byId.get(state.me.id)?.name || state.me.name
      return voice.sync()
    case 'status': state.status = msg.status; return bus.emit('status')
    case 'channels': {
      state.channels = msg.channels
      for (const id of [...state.unread]) if (!id.startsWith('dm:') && !channel(id)) state.unread.delete(id)
      if (state.voice && !channel(state.voice.ch)) voice.leave()
      bus.emit('channels')
      bus.emit('view') // si el canal que mirabas ya no existe, onView te lleva a otro
      return bus.emit('unread')
    }
    case 'signal': return voice.onSignal(msg.from, msg.data)
    case 'toggleMute': return state.voice && voice.toggleMute()
    case 'ptt': return voice.setPtt(msg.down)
    case 'update': return showUpdate(msg)
    case 'open': return openChannel(msg.ch)
  }
}

function onEvents(evs, updates) {
  onEventsChat(evs, updates)
  let dmsChanged = false
  for (const ev of evs) {
    if (ev.dm) { state.dms.set(ev.ch.slice(3), Math.max(state.dms.get(ev.ch.slice(3)) || 0, ev.ts)); dmsChanged = true }
    notifyFor(ev)
  }
  if (dmsChanged) bus.emit('dms')
}

function notifyFor(ev) {
  if (ev.t !== 'msg' || ev.a === state.me.id) return
  const viewing = state.view.ch === ev.ch && document.hasFocus()
  const mentioned = ev.dm || ev.text.includes(`<@${state.me.id}>`) // un mensaje directo siempre cuenta como aviso
  if (!viewing && ev.ts > (state.lastRead[ev.ch] || firstRun)) {
    let changed = false
    if (!state.unread.has(ev.ch)) { state.unread.add(ev.ch); changed = true }
    if (mentioned) { state.mentions.set(ev.ch, (state.mentions.get(ev.ch) || 0) + 1); changed = true }
    if (changed) bus.emit('unread')
  }
  if (viewing || Date.now() - ev.ts > 30000) return // no avisar del historial que llega al sincronizar
  if (state.notify.desktop) {
    const who = state.byId.get(ev.a)?.name || 'Alguien'
    const body = (ev.text || '📎 Archivo').replace(/<@([0-9a-f]{64})>/g, (_s, id) => '@' + (state.byId.get(id)?.name || ''))
    const where = ev.dm ? 'mensaje directo' : '#' + (channel(ev.ch)?.name || '')
    window.humble.notify({ title: `${who} · ${where}`, body, ch: ev.ch }).catch(() => {})
  }
  if (state.notify.sounds && (mentioned || !document.hasFocus())) play('message')
}

boot().catch((e) => {
  console.error(e)
  document.body.append(h('pre', { style: { color: '#f23f42', padding: '24px' } }, 'Error al iniciar: ' + (e.stack || e)))
})
