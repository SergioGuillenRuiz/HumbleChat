// Estado compartido de la interfaz + bus de eventos mínimo.
import { store } from './util.js'

const listeners = new Map()
export const bus = {
  on(evt, fn) { (listeners.get(evt) || listeners.set(evt, new Set()).get(evt)).add(fn); return () => listeners.get(evt).delete(fn) },
  emit(evt, data) { for (const fn of listeners.get(evt) || []) { try { fn(data) } catch (e) { console.error(evt, e) } } }
}

export const state = {
  me: null,
  server: 'HumbleChat',
  channels: [],
  members: [],
  byId: new Map(),
  status: { state: 'connecting', peers: 0 },
  platform: 'linux',
  pickerNeeded: true,
  limits: { blob: 64 * 1024 * 1024, autoBlob: 16 * 1024 * 1024, avatar: 256 * 1024, attachments: 6, text: 4000, name: 32, channelName: 24 },
  dms: new Map(), // id del amigo -> marca de tiempo del último mensaje directo (0 = conversación recién abierta)
  iceServers: [],
  view: { ch: 'general' }, // canal que se muestra en el panel central
  unread: new Set(),
  lastRead: {}, // marca de lectura por canal; se carga al conocer la sala (cada sala tiene las suyas)
  lastReadKey: 'lastRead',
  rooms: [], // salas: { id, name, fingerprint, active, unread, mentions }
  roomsLocked: false, // sala fijada por el entorno: no se puede cambiar
  roomId: null,
  showMembers: store('showMembers') !== false,
  speaking: new Set(),
  voice: null, // { ch, muted, deafened, sharing } mientras estás en una llamada
  watching: null, // id de quien estás viendo compartir pantalla
  streams: new Map(), // id -> MediaStream de pantalla
  cams: new Map(), // id -> MediaStream de cámara
  prefs: { input: store('input') || '', output: store('output') || '', camera: store('camera') || '', denoise: store('denoise') || 'standard', gate: store('gate') || { on: false, level: 0.05 }, ptt: store('ptt') || { on: false, key: null } },
  firstRun: 0,
  typing: new Map(), // canal -> Map(id -> caduca)
  mentions: new Map(), // canal -> nº de menciones sin leer
  collapsed: store('collapsed') || {}, // categorías plegadas
  notify: { desktop: store('notifyDesktop') !== false, sounds: store('notifySounds') !== false }
}

/** Un canal, o (para "dm:<id>") una conversación directa con la misma forma que un canal de texto. */
export const channel = (id) => (typeof id === 'string' && id.startsWith('dm:')
  ? { id, type: 'dm', peer: id.slice(3), name: member(id.slice(3)).name }
  : state.channels.find((c) => c.id === id))
export const member = (id) => state.byId.get(id) || { id, name: 'Amigo ' + id.slice(0, 4), online: false }

export function setMembers(list) {
  state.members = list
  state.byId = new Map(list.map((m) => [m.id, m]))
  bus.emit('members')
}

export function markRead(ch, ts) {
  if (!ts || (state.lastRead[ch] || 0) >= ts) return
  state.lastRead[ch] = ts
  store(state.lastReadKey, state.lastRead)
}
