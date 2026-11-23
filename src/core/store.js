'use strict'
// Registro replicado de eventos. Cada autor tiene su propia cadena numerada (n = 1, 2, 3…),
// así que dos nodos se sincronizan comparando un vector {autor: último n contiguo}.
// Da igual quién esté conectado o quién fuera el primero: la unión de los registros es el historial.
//
// Tipos de evento:  msg (mensaje) · del (borrar uno propio) · prof (nombre de usuario)
const fs = require('fs')
const path = require('path')
const { CHANNELS, LIMITS } = require('./constants')
const { cleanName } = require('./identity')

const HEX64 = /^[0-9a-f]{64}$/
const TEXT_CHANNELS = new Set(CHANNELS.filter((c) => c.type === 'text').map((c) => c.id))

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max
const str = (v, max) => typeof v === 'string' && v.length <= max

function cleanAttachment(a) {
  if (!a || typeof a !== 'object') return null
  if (!HEX64.test(a.h) || !str(a.name, 120) || !str(a.mime, 80)) return null
  if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(a.mime)) return null
  if (!isInt(a.size, 1, LIMITS.blob)) return null
  const out = { h: a.h, name: a.name, mime: a.mime, size: a.size }
  if (isInt(a.w, 1, 30000) && isInt(a.ht, 1, 30000)) { out.w = a.w; out.ht = a.ht }
  return out
}

/** Valida y normaliza un evento recibido de la red o creado localmente. null = descartar. */
function cleanEvent(e) {
  if (!e || typeof e !== 'object') return null
  if (!HEX64.test(e.a) || !isInt(e.n, 1, 1e9) || !Number.isFinite(e.ts)) return null
  const ev = { a: e.a, n: e.n, ts: Math.floor(e.ts), t: e.t }
  if (e.t === 'msg') {
    if (!TEXT_CHANNELS.has(e.ch) || !str(e.text, LIMITS.text)) return null
    ev.ch = e.ch
    ev.text = e.text
    if (e.att !== undefined) {
      if (!Array.isArray(e.att) || e.att.length > LIMITS.attachments) return null
      ev.att = e.att.map(cleanAttachment)
      if (ev.att.includes(null)) return null
    }
    if (!ev.text.trim() && !(ev.att && ev.att.length)) return null
  } else if (e.t === 'del') {
    if (!/^[0-9a-f]{64}:\d{1,10}$/.test(e.x)) return null
    ev.x = e.x
  } else if (e.t === 'prof') {
    ev.name = cleanName(e.name)
    if (!ev.name) return null
  } else return null
  return ev
}

const idOf = (ev) => `${ev.a}:${ev.n}`
const cmp = (x, y) => x.ts - y.ts || (idOf(x) < idOf(y) ? -1 : idOf(x) > idOf(y) ? 1 : 0)

class Store {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'events.jsonl')
    this.events = new Map() // id -> evento (todos)
    this.contig = new Map() // autor -> mayor n sin huecos
    this.maxN = new Map() // autor -> mayor n visto
    this.chan = new Map(CHANNELS.filter((c) => c.type === 'text').map((c) => [c.id, []])) // msgs ordenados
    this.deleted = new Set() // ids borrados (aunque aún no haya llegado el msg)
    this.names = new Map() // autor -> { name, n }
    this.out = null
    this.pendingWrite = []
    this.flushTimer = null
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true })
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const ev = cleanEvent(JSON.parse(line))
          if (ev) this._insert(ev)
        } catch {}
      }
    } catch {}
    this.out = fs.createWriteStream(this.file, { flags: 'a' })
    this.out.on('error', () => {})
  }

  close() {
    return new Promise((resolve) => {
      clearTimeout(this.flushTimer)
      this._flush()
      if (!this.out) return resolve()
      this.out.end(resolve)
      this.out = null
    })
  }

  _flush() {
    if (!this.pendingWrite.length || !this.out) return
    this.out.write(this.pendingWrite.join(''))
    this.pendingWrite = []
  }

  /** @returns {'new'|'dup'} */
  add(raw) {
    const ev = cleanEvent(raw)
    if (!ev) return 'bad'
    if (this.events.has(idOf(ev))) return 'dup'
    this._insert(ev)
    this.pendingWrite.push(JSON.stringify(ev) + '\n')
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this._flush() }, 50)
      this.flushTimer.unref?.()
    }
    return 'new'
  }

  _insert(ev) {
    const id = idOf(ev)
    this.events.set(id, ev)
    if (ev.n > (this.maxN.get(ev.a) || 0)) this.maxN.set(ev.a, ev.n)
    let c = this.contig.get(ev.a) || 0
    while (this.events.has(`${ev.a}:${c + 1}`)) c++
    if (c) this.contig.set(ev.a, c)

    if (ev.t === 'msg') {
      if (!this.deleted.has(id)) {
        const list = this.chan.get(ev.ch)
        let i = list.length
        while (i > 0 && cmp(list[i - 1], ev) > 0) i--
        list.splice(i, 0, ev)
      }
    } else if (ev.t === 'del') {
      if (ev.x.startsWith(ev.a + ':')) { // solo puedes borrar lo tuyo
        this.deleted.add(ev.x)
        const target = this.events.get(ev.x)
        if (target) {
          const list = this.chan.get(target.ch)
          const i = list.indexOf(target)
          if (i >= 0) list.splice(i, 1)
        }
      }
    } else if (ev.t === 'prof') {
      const cur = this.names.get(ev.a)
      if (!cur || ev.n > cur.n) this.names.set(ev.a, { name: ev.name, n: ev.n })
    }
  }

  vector() {
    return Object.fromEntries(this.contig)
  }

  nextN(author) {
    return (this.maxN.get(author) || 0) + 1
  }

  /** Eventos que le faltan a quien tiene `vec`, en lotes. */
  *missingFor(vec, batch = 200) {
    let list = []
    for (const [a, c] of this.contig) {
      const from = Number.isInteger(vec?.[a]) ? vec[a] : 0
      for (let n = from + 1; n <= c; n++) {
        list.push(this.events.get(`${a}:${n}`))
        if (list.length >= batch) { yield list; list = [] }
      }
    }
    if (list.length) yield list
  }

  /** Eventos concretos de un autor desde n (para rellenar huecos). */
  range(author, from, batch = 200) {
    const out = []
    const max = this.maxN.get(author) || 0
    for (let n = from; n <= max && out.length < batch; n++) {
      const ev = this.events.get(`${author}:${n}`)
      if (ev) out.push(ev)
    }
    return out
  }

  history(ch, { beforeTs = null, beforeId = null, limit = 60 } = {}) {
    const list = this.chan.get(ch) || []
    let end = list.length
    if (beforeTs !== null) {
      const probe = { ts: beforeTs, a: beforeId ? beforeId.split(':')[0] : '', n: Number((beforeId || ':0').split(':')[1]) }
      let lo = 0
      let hi = list.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cmp(list[mid], probe) < 0) lo = mid + 1
        else hi = mid
      }
      end = lo
    }
    return list.slice(Math.max(0, end - limit), end)
  }

  last(ch) {
    const list = this.chan.get(ch) || []
    return list.length ? list[list.length - 1] : null
  }

  /** Mensajes con adjuntos cuyos blobs podrían faltar. */
  *attachments() {
    for (const list of this.chan.values()) for (const ev of list) if (ev.att) for (const a of ev.att) yield a
  }

  /** Autores conocidos con su nombre más reciente. */
  members() {
    const out = new Map()
    for (const a of this.contig.keys()) out.set(a, this.names.get(a)?.name || null)
    for (const [a, v] of this.names) out.set(a, v.name)
    return out
  }
}

module.exports = { Store, cleanEvent, idOf }
