// Vista de un canal de voz: participantes (con cámara), pantalla compartida y controles de llamada.
import { h, avatar, fill } from '../util.js'
import { icon } from '../icons.js'
import { state, bus, channel } from '../state.js'
import { voice, isMuted } from '../voice.js'
import { openVolumeMenu } from './overlays.js'
import { openProfile } from './popout.js'

let root
let video = null
const camEls = new Map() // id -> <video> de cámara, reutilizados entre renders para que no parpadeen

export function mountVoiceView(el) {
  root = el
  for (const evt of ['members', 'voice', 'streams', 'view', 'toggleMembers']) bus.on(evt, render)
  bus.on('speaking', applySpeaking)
}

function camVideo(id, stream) {
  let v = camEls.get(id)
  if (!v) { v = h('video.cam', { autoplay: true, playsinline: true, muted: true }); camEls.set(id, v) }
  if (v.srcObject !== stream) v.srcObject = stream
  v.classList.toggle('mirror', id === state.me.id)
  return v
}

export function render() {
  if (!root || root.classList.contains('hidden')) return
  const c = channel(state.view.ch)
  if (!c || c.type !== 'voice') return
  const inside = state.members.filter((m) => m.online && m.voice?.ch === c.id)
  const joined = state.voice?.ch === c.id
  const watched = state.watching && state.streams.get(state.watching) && inside.some((m) => m.id === state.watching) ? state.watching : null
  for (const id of [...camEls.keys()]) if (!state.cams.has(id)) camEls.delete(id)

  const tile = (m, small) => {
    const v = m.voice
    const isMe = m.id === state.me.id
    const cam = v?.cam && state.cams.get(m.id)
    return h('div.tile' + (small ? '.small' : '') + (cam ? '.has-cam' : ''), {
      dataset: { uid: m.id },
      oncontextmenu: (e) => { if (!isMe && joined) { e.preventDefault(); openVolumeMenu(e.clientX, e.clientY, m.id, voice) } }
    },
      cam ? camVideo(m.id, cam) : h('div.tile-avatar', { onclick: (e) => openProfile(e.currentTarget, m.id) }, avatar(m, small ? 48 : 96, 'speak-ring')),
      v?.share && h('div.tile-live', 'EN VIVO'),
      h('div.tile-name', (v?.mute || v?.deaf) && icon(v.deaf ? 'headphonesOff' : 'micOff', 16), m.name),
      v?.share && joined && h('button.tile-watch', {
        onclick: () => voice.watch(state.watching === m.id ? null : m.id)
      }, icon('screen', 16), state.watching === m.id ? 'Dejar de ver' : isMe ? 'Ver mi pantalla' : 'Ver pantalla'))
  }

  let stage
  if (watched) {
    if (!video) video = h('video', { autoplay: true, playsinline: true, muted: true })
    const stream = state.streams.get(watched)
    if (video.srcObject !== stream) video.srcObject = stream
    const who = state.byId.get(watched)
    stage = h('div.stage.theater',
      h('div.theater-video', video,
        h('div.theater-bar',
          h('span', watched === state.me.id ? 'Tu pantalla' : `Pantalla de ${who?.name || ''}`),
          h('button.lb-btn', { onclick: () => video.requestFullscreen?.() }, 'Pantalla completa'),
          h('button.lb-btn', { onclick: () => voice.watch(null) }, 'Dejar de ver'))),
      h('div.strip', ...inside.map((m) => tile(m, true))))
  } else {
    stage = h('div.stage', inside.length
      ? h('div.grid.n' + Math.min(inside.length, 6), ...inside.map((m) => tile(m, false)))
      : h('div.empty-voice', h('div.ev-icon', icon('speaker', 48)), h('h2', c.name), h('p', 'Nadie está en este canal de voz.'),
          !joined && h('button.btn.green.big', { onclick: () => voice.join(c.id) }, 'Unirse a la llamada')))
  }

  fill(root,
    h('div.header', icon('speaker', 24), h('span.h-title', c.name),
      h('div.h-tools', h('button.icon-btn' + (state.showMembers ? '.active' : ''), {
        tip: state.showMembers ? 'Ocultar lista de miembros' : 'Mostrar lista de miembros', tipPos: 'bottom',
        onclick: () => bus.emit('toggleMembersClick')
      }, icon('people', 24)))),
    stage,
    h('div.vcontrols', joined ? controls() : inside.length ? h('button.btn.green.big', { onclick: () => voice.join(c.id) }, 'Unirse a la llamada') : null))
  applySpeaking()
}

function controls() {
  const v = state.voice
  const muted = isMuted()
  return [
    h('button.round' + (muted ? '.off' : ''), { tip: muted ? 'Activar micrófono (Ctrl+Mayús+M)' : 'Silenciar (Ctrl+Mayús+M)', onclick: () => voice.toggleMute() }, icon(muted ? 'micOff' : 'mic', 24)),
    h('button.round' + (v.deafened ? '.off' : ''), { tip: v.deafened ? 'Dejar de ensordecer (Ctrl+Mayús+D)' : 'Ensordecer (Ctrl+Mayús+D)', onclick: () => voice.toggleDeafen() }, icon(v.deafened ? 'headphonesOff' : 'headphones', 24)),
    h('button.round' + (v.cam ? '.on' : ''), { tip: v.cam ? 'Apagar cámara' : 'Encender cámara', onclick: () => voice.toggleCamera() }, icon(v.cam ? 'camera' : 'cameraOff', 24)),
    h('button.round' + (v.sharing ? '.on' : ''), { tip: v.sharing ? 'Dejar de compartir pantalla' : 'Compartir pantalla', onclick: () => (v.sharing ? voice.stopShare() : voice.startShare()) }, icon('screen', 24)),
    h('button.round.hang', { tip: 'Desconectar', onclick: () => voice.leave() }, icon('hangup', 24))
  ]
}

function applySpeaking() {
  if (!root) return
  for (const el of root.querySelectorAll('[data-uid]')) el.classList.toggle('speaking', state.speaking.has(el.dataset.uid))
}
