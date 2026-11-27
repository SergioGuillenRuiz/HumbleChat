'use strict'
// Varias salas a la vez (sin Electron: la creación de nodos llega por parámetros, para probarlo con nodos simulados).
//
// Cada sala tiene su propio nodo P2P con su propia red y su propio historial: nada se mezcla entre salas. Todas están
// conectadas a la vez (así sigues recibiendo en las de segundo plano y los amigos te ven en línea), pero la interfaz
// muestra una sola, la activa. En las demás solo se cuentan los mensajes sin leer y las menciones.
const { fingerprint } = require('../core/groupkey')

class RoomHub {
  /**
   * @param {object} o
   * @param {import('./rooms').RoomStore} o.store
   * @param {(room: object) => object} o.createNode  nodo de la sala, sin arrancar (ChatNode o uno simulado)
   * @param {(node: object) => object} [o.createTunnels]  túneles UDP del nodo (voz); opcional
   * @param {() => void} [o.onChange]      cambió la lista de salas o lo no leído
   * @param {(entry: object|null) => void} [o.onActivate]  cambió la sala activa
   */
  constructor({ store, createNode, createTunnels = () => null, onChange = () => {}, onActivate = () => {} }) {
    Object.assign(this, { store, createNode, createTunnels, onChange, onActivate })
    this.entries = new Map() // id -> { room, node, tunnels, unread, mentions }
    this.activeId = null
  }

  get active() { return this.entries.get(this.activeId) || null }
  get node() { return this.active?.node ?? null }
  get tunnels() { return this.active?.tunnels ?? null }
  get room() { return this.active?.room ?? null }
  all() { return [...this.entries.values()] }

  /** Arranca todas las salas guardadas y deja activa la que lo estaba. */
  async startAll() {
    await Promise.all(this.store.list().map((room) => this._start(room)))
    const want = this.entries.has(this.store.activeId) ? this.store.activeId : this.entries.keys().next().value ?? null
    this._setActive(want, false)
  }

  async _start(room) {
    if (this.entries.has(room.id)) return this.entries.get(room.id)
    const node = this.createNode(room)
    const entry = { room, node, tunnels: this.createTunnels(node), unread: 0, mentions: 0 }
    this.entries.set(room.id, entry)
    node.on('event', (ev) => this._background(entry, ev))
    try { await node.start() } catch (e) { this.entries.delete(room.id); throw e }
    return entry
  }

  /** Lo que llega a una sala que no se está viendo: solo se cuenta. */
  _background(entry, ev) {
    if (entry.room.id === this.activeId || ev.a === entry.node.id) return
    // Los directos de otros equipos también se replican (cifrados): solo cuentan los dirigidos a ti.
    const mine = ev.t === 'dm' ? !!entry.node.openDm?.(ev) : ev.t === 'msg'
    if (!mine) return
    entry.unread++
    if (ev.t === 'dm' || (typeof ev.text === 'string' && ev.text.includes(`<@${entry.node.id}>`))) entry.mentions++
    this.onChange()
  }

  _setActive(id, persist = true) {
    const prev = this.active
    if (prev && prev.room.id !== id) prev.node.setVoice?.(null) // una llamada no sigue al cambiar de sala
    this.activeId = id
    const cur = this.active
    if (cur) { cur.unread = 0; cur.mentions = 0 }
    if (persist && cur) this.store.setActive(id)
    this.onActivate(cur)
    this.onChange()
  }

  switchTo(id) {
    if (!this.entries.has(id)) throw new Error('Esa sala no existe.')
    if (id !== this.activeId) this._setActive(id)
    return this.active
  }

  /** Añade una sala (o, si ya la tenías, solo te lleva a ella) y la deja activa. */
  async add(key, { name, adoptLegacy = false } = {}) {
    const room = this.store.add(key, { name, adoptLegacy })
    if (!this.entries.has(room.id)) {
      try { await this._start(room) } catch (e) {
        this.store.remove(room.id) // no se deja una sala que no arranca
        throw e
      }
    }
    return this.switchTo(room.id)
  }

  rename(id, name) {
    const n = this.store.rename(id, name)
    const e = this.entries.get(id)
    if (e) e.room.name = n
    this.onChange()
    return n
  }

  /** Sale de una sala. Devuelve el id de la sala que queda activa (null si ya no hay ninguna). */
  async leave(id, { deleteData = false } = {}) {
    const e = this.entries.get(id)
    if (!e) return this.activeId
    e.node.setVoice?.(null)
    e.tunnels?.closeAll?.()
    this.entries.delete(id)
    await e.node.stop().catch(() => {})
    this.store.remove(id, { deleteData }) // con el nodo ya parado: no queda nadie escribiendo en esa carpeta
    if (this.activeId === id) this._setActive(this.store.activeId && this.entries.has(this.store.activeId) ? this.store.activeId : this.entries.keys().next().value ?? null, false)
    else this.onChange()
    return this.activeId
  }

  list() {
    return this.all().map((e) => ({
      id: e.room.id, name: e.room.name, fingerprint: fingerprint(e.room.key),
      active: e.room.id === this.activeId, unread: e.unread, mentions: e.mentions,
      peers: e.node.peers?.size ?? 0
    }))
  }

  async stopAll() {
    const all = this.all()
    this.entries.clear()
    this.activeId = null
    await Promise.all(all.map(async (e) => { e.tunnels?.closeAll?.(); await e.node.stop().catch(() => {}) }))
    this.onActivate(null)
  }
}

module.exports = { RoomHub }
