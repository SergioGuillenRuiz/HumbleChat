import { h, $, store, append } from './util.js'
import { icon } from './icons.js'
import { state, bus, setMembers, channel } from './state.js'
import { mountSidebar, openChannel } from './ui/sidebar.js'
import { mountChat, showChannel, onEvents as onEventsChat, touchRead } from './ui/chat.js'
import { mountMembers } from './ui/members.js'
import { mountVoiceView, render as renderVoiceView } from './ui/voiceview.js'
import { voice } from './voice.js'
import { toast } from './ui/overlays.js'

const firstRun = store('firstRun') || (store('firstRun', Date.now()), Date.now())
let shownText = null

async function boot() {
  const init = await window.humble.init()
  Object.assign(state, {
    me: init.me, server: init.server, channels: init.channels, status: init.status, platform: init.platform,
    pickerNeeded: init.pickerNeeded, limits: init.limits, iceServers: init.iceServers
  })
  setMembers(init.members)
  for (const c of state.channels) {
    const last = init.last[c.id]
    if (last && last.a !== state.me.id && last.ts > (state.lastRead[c.id] || firstRun)) state.unread.add(c.id)
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
        h('div.rail-item.active', { title: state.server }, h('span.rail-pill'), h('div.rail-icon', h('span', state.server[0]))),
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
    document.title = (state.unread.size ? `(${state.unread.size}) ` : '') + state.server
  })
  window.addEventListener('focus', touchRead)
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a.link')
    if (a) { e.preventDefault(); window.humble.openExternal(a.href) }
  })
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('textarea,input')) e.preventDefault() })

  window.humble.onMessage(onMessage)
  onView()
  bus.emit('unread')
}

function onView() {
  const c = channel(state.view.ch)
  const isText = c.type === 'text'
  $('#chat').classList.toggle('hidden', !isText)
  $('#voiceview').classList.toggle('hidden', isText)
  if (isText) {
    if (shownText !== c.id) { shownText = c.id; showChannel(c.id) } else touchRead()
  } else renderVoiceView()
}

function onMessage(msg) {
  switch (msg.type) {
    case 'events': return onEvents(msg.evs)
    case 'members':
      setMembers(msg.members)
      state.me.name = state.byId.get(state.me.id)?.name || state.me.name
      return voice.sync()
    case 'status': state.status = msg.status; return bus.emit('status')
    case 'signal': return voice.onSignal(msg.from, msg.data)
    case 'open': return openChannel(msg.ch)
  }
}

function onEvents(evs) {
  onEventsChat(evs)
  for (const ev of evs) notifyFor(ev)
}

function notifyFor(ev) {
  if (ev.t !== 'msg' || ev.a === state.me.id) return
  const viewing = state.view.ch === ev.ch && document.hasFocus()
  if (viewing) return
  if (ev.ts > (state.lastRead[ev.ch] || firstRun)) {
    if (!state.unread.has(ev.ch)) { state.unread.add(ev.ch); bus.emit('unread') }
  }
  if (Date.now() - ev.ts < 30000) { // no avisar del historial que llega al sincronizar
    const who = state.byId.get(ev.a)?.name || 'Alguien'
    window.humble.notify({ title: `${who} · #${channel(ev.ch).name}`, body: ev.text || '📷 Imagen', ch: ev.ch }).catch(() => {})
  }
}

boot().catch((e) => {
  console.error(e)
  document.body.append(h('pre', { style: { color: '#f23f42', padding: '24px' } }, 'Error al iniciar: ' + (e.stack || e)))
})
