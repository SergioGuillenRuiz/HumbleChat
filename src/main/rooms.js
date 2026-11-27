'use strict'
// Registro de salas del usuario (sin Electron: todo llega por parámetros, para poder probarlo).
//
// Cada sala tiene su llave, un nombre que solo ve quien la tiene y SU PROPIA carpeta de historial y adjuntos, de modo que
// lo de una sala nunca se mezcla ni se sincroniza con otra. La identidad (tu ID y tu nombre) es una sola para todas:
// vive en `<datos>/data/identity.json`.
//
//   <datos>/rooms.json            lista de salas y la activa (lleva las llaves: modo 0600)
//   <datos>/data/                 la sala de antes de existir las salas múltiples conserva aquí su historial (sin moverlo)
//   <datos>/rooms/<huella>/       las demás
//
// Con HUMBLECHAT_KEY (pruebas y despliegues fijos) hay una sola sala, fijada, y rooms.json ni se lee ni se escribe.
const fs = require('fs')
const path = require('path')
const { fingerprint } = require('../core/groupkey')

const LEGACY_DIR = 'data'
const NAME_MAX = 32

function cleanRoomName(s) {
  return String(s ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

class RoomStore {
  /**
   * @param {string} userDataDir carpeta de datos del usuario
   * @param {object} [o]
   * @param {string} [o.fixedKey] sala fijada por el entorno: modo de una sola sala sin persistencia
   * @param {string} [o.defaultName] nombre de la primera sala
   */
  constructor(userDataDir, { fixedKey = null, defaultName = 'HumbleChat' } = {}) {
    this.root = userDataDir
    this.file = path.join(userDataDir, 'rooms.json')
    this.defaultName = defaultName
    this.locked = !!fixedKey
    this.rooms = []
    this.activeId = null
    if (fixedKey) {
      const r = { id: fingerprint(fixedKey), key: fixedKey, name: defaultName, dir: LEGACY_DIR, addedAt: 0 }
      this.rooms = [r]
      this.activeId = r.id
    } else this._load()
  }

  _load() {
    let data = null
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch (e) {
      if (e.code !== 'ENOENT') { // un rooms.json estropeado no se pisa: se guarda aparte por si hay que recuperar llaves
        try { fs.copyFileSync(this.file, this.file + '.corrupto') } catch {}
      }
      return
    }
    if (!data || !Array.isArray(data.rooms)) return
    const seen = new Set()
    for (const r of data.rooms) {
      if (!r || typeof r.key !== 'string' || r.key.length < 16) continue
      const id = fingerprint(r.key)
      if (seen.has(id)) continue
      seen.add(id)
      this.rooms.push({
        id, key: r.key,
        name: cleanRoomName(r.name) || this.defaultName,
        dir: r.dir === LEGACY_DIR ? LEGACY_DIR : path.join('rooms', id),
        addedAt: Number(r.addedAt) || 0
      })
    }
    this.activeId = this.rooms.some((r) => r.id === data.active) ? data.active : this.rooms[0]?.id ?? null
  }

  save() {
    if (this.locked) return
    fs.mkdirSync(this.root, { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, active: this.activeId, rooms: this.rooms }, null, 1), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  list() { return this.rooms.slice() }
  get(id) { return this.rooms.find((r) => r.id === id) || null }
  get active() { return this.get(this.activeId) }
  has(key) { return this.rooms.some((r) => r.id === fingerprint(key)) }

  /** Carpeta del historial de una sala (absoluta). */
  dirOf(room) { return path.join(this.root, room.dir) }
  /** Carpeta de la identidad, compartida por todas las salas. */
  get identityDir() { return path.join(this.root, LEGACY_DIR) }

  nextName() {
    const taken = new Set(this.rooms.map((r) => r.name))
    for (let i = this.rooms.length + 1; ; i++) if (!taken.has('Sala ' + i)) return 'Sala ' + i
  }

  /**
   * Añade una sala (si esa llave ya está, no se duplica: se devuelve la que hay).
   * `adoptLegacy`: la llave de antes de las salas múltiples; su historial ya está en `data/` y se queda ahí.
   */
  add(key, { name, adoptLegacy = false } = {}) {
    if (this.locked) throw new Error('La sala está fijada por la variable HUMBLECHAT_KEY y no se puede cambiar desde aquí.')
    const id = fingerprint(key)
    const existing = this.get(id)
    if (existing) return existing
    const legacyHistory = adoptLegacy && !this.rooms.some((r) => r.dir === LEGACY_DIR) && fs.existsSync(path.join(this.root, LEGACY_DIR, 'log'))
    const room = {
      id, key,
      name: cleanRoomName(name) || (this.rooms.length ? this.nextName() : this.defaultName),
      dir: legacyHistory ? LEGACY_DIR : path.join('rooms', id),
      addedAt: Date.now()
    }
    this.rooms.push(room)
    if (!this.activeId) this.activeId = id
    this.save()
    return room
  }

  setActive(id) {
    if (!this.get(id)) throw new Error('Esa sala no existe.')
    this.activeId = id
    this.save()
  }

  rename(id, name) {
    const r = this.get(id)
    const n = cleanRoomName(name)
    if (!r || !n) throw new Error('El nombre no puede estar vacío.')
    r.name = n
    this.save()
    return n
  }

  /** Quita la sala. Con `deleteData` borra también su historial y adjuntos (nunca la identidad). */
  remove(id, { deleteData = false } = {}) {
    if (this.locked) throw new Error('La sala está fijada por la variable HUMBLECHAT_KEY y no se puede cambiar desde aquí.')
    const r = this.get(id)
    if (!r) return
    this.rooms = this.rooms.filter((x) => x.id !== id)
    if (this.activeId === id) this.activeId = this.rooms[0]?.id ?? null
    this.save()
    if (deleteData) this._deleteData(r)
  }

  _deleteData(r) {
    const dir = this.dirOf(r)
    if (r.dir === LEGACY_DIR) { // aquí también vive identity.json: solo se borra lo de la sala
      for (const f of ['log', 'blobs', 'dht-nodes.json']) fs.rmSync(path.join(dir, f), { recursive: true, force: true })
    } else fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { RoomStore, cleanRoomName, LEGACY_DIR }
