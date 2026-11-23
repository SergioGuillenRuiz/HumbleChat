'use strict'
// Registro replicado de eventos. Cada autor tiene su propia cadena numerada (n = 1, 2, 3…),
// así que dos nodos se sincronizan comparando un vector {autor: último n contiguo}.
// Da igual quién esté conectado o quién fuera el primero: la unión de los registros es el historial.
//
// Tipos de evento:  msg (mensaje, opcionalmente respuesta) · del (borrar uno propio) · edit (editar uno propio)
//                   react (poner/quitar una reacción) · prof (nombre y avatar) · chan (crear/renombrar/borrar un canal)
//                   pin (fijar/desfijar) · emb (vista previa de un enlace) · dm (mensaje directo cifrado)
const fs = require('fs')
const path = require('path')
const { CHANNELS, LIMITS } = require('./constants')
const { cleanName } = require('./identity')
const { verify, HEX128 } = require('./sign')

const HEX64 = /^[0-9a-f]{64}$/
const EVENT_ID = /^[0-9a-f]{64}:\d{1,10}$/
const CHAN_ID = /^[a-z0-9-]{1,32}$/
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const CTRL = /\p{Cc}/u

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max
const str = (v, max) => typeof v === 'string' && v.length <= max

/** Nombre de canal: los de texto en minúsculas y con guiones (como Discord); los de voz, tal cual. '' si no vale. */
function cleanChannelName(kind, s) {
  let n = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (kind === 'text') n = n.toLowerCase().replace(/\s/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  else n = n.replace(/\p{Cc}/gu, '')
  return n.slice(0, LIMITS.channelName)
}

function cleanAttachment(a) {
  if (!a || typeof a !== 'object') return null
  if (!HEX64.test(a.h) || !str(a.name, 120) || !str(a.mime, 80)) return null
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(a.mime) || CTRL.test(a.name)) return null
  if (!isInt(a.size, 1, LIMITS.blob)) return null
  const out = { h: a.h, name: a.name, mime: a.mime, size: a.size }
  if (isInt(a.w, 1, 30000) && isInt(a.ht, 1, 30000)) { out.w = a.w; out.ht = a.ht }
  return out
}

/** Valida y normaliza un evento recibido de la red o creado localmente. null = descartar. */
function cleanEvent(e) {
  if (!e || typeof e !== 'object') return null
  if (!HEX64.test(e.a) || !isInt(e.n, 1, 1e9) || !Number.isFinite(e.ts)) return null
  if (typeof e.sig !== 'string' || !HEX128.test(e.sig)) return null
  const ev = { a: e.a, n: e.n, ts: Math.floor(e.ts), t: e.t, sig: e.sig }
  if (e.t === 'msg') {
    if (typeof e.ch !== 'string' || !CHAN_ID.test(e.ch) || !str(e.text, LIMITS.text)) return null
    ev.ch = e.ch
    ev.text = e.text
    if (e.att !== undefined) {
      if (!Array.isArray(e.att) || e.att.length > LIMITS.attachments) return null
      ev.att = e.att.map(cleanAttachment)
      if (ev.att.includes(null)) return null
    }
    if (e.re !== undefined && e.re !== null) {
      if (typeof e.re !== 'string' || !EVENT_ID.test(e.re)) return null
      ev.re = e.re
    }
    if (!ev.text.trim() && !(ev.att && ev.att.length)) return null
  } else if (e.t === 'del') {
    if (!EVENT_ID.test(e.x)) return null
    ev.x = e.x
  } else if (e.t === 'edit') {
    if (!EVENT_ID.test(e.x) || !str(e.text, LIMITS.text) || !e.text.trim()) return null
    ev.x = e.x
    ev.text = e.text
  } else if (e.t === 'react') {
    if (!EVENT_ID.test(e.x) || typeof e.e !== 'string' || e.e.length < 1 || e.e.length > 24 || /[\s\p{Cc}]/u.test(e.e) || typeof e.on !== 'boolean') return null
    ev.x = e.x
    ev.e = e.e
    ev.on = e.on
  } else if (e.t === 'prof') {
    ev.name = cleanName(e.name)
    if (!ev.name) return null
    if (e.av !== undefined && e.av !== null) {
      if (!HEX64.test(e.av) || !isInt(e.avs, 1, LIMITS.avatar)) return null
      ev.av = e.av
      ev.avs = e.avs
    }
  } else if (e.t === 'chan') {
    if (typeof e.ch !== 'string' || !CHAN_ID.test(e.ch) || (e.k !== 'text' && e.k !== 'voice')) return null
    ev.ch = e.ch
    ev.k = e.k
    ev.name = cleanChannelName(e.k, e.name)
    if (!ev.name) return null
    ev.del = !!e.del
  } else if (e.t === 'pin') {
    if (!EVENT_ID.test(e.x) || typeof e.on !== 'boolean') return null
    ev.x = e.x
    ev.on = e.on
  } else if (e.t === 'emb') {
    if (!EVENT_ID.test(e.x) || !str(e.url, 500) || !str(e.title, 200) || !str(e.desc, 500) || !str(e.site, 100)) return null
    if ([e.url, e.title, e.desc, e.site].some((v) => CTRL.test(v)) || !(e.title || e.desc)) return null
    try { if (!/^https?:$/.test(new URL(e.url).protocol)) return null } catch { return null }
    Object.assign(ev, { x: e.x, url: e.url, title: e.title, desc: e.desc, site: e.site })
  } else if (e.t === 'dm') {
    if (!HEX64.test(e.to) || e.to === e.a || !str(e.box, 12000) || e.box.length < 40 || !B64.test(e.box)) return null
    ev.to = e.to
    ev.box = e.box
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
    this.chans = new Map(CHANNELS.map((c) => [c.id, { def: c, k: c.type, first: null, cur: null }])) // canales: predefinidos + creados
    this.pins = new Map() // id del mensaje -> evento pin más reciente
    this.embeds = new Map() // id del mensaje -> vista previa (la última de su autor)
    this.dms = new Map() // "a:b" (ordenado) -> mensajes directos ordenados (cifrados)
    this.deleted = new Set() // ids borrados (aunque aún no haya llegado el msg)
    this.names = new Map() // autor -> { name, n }
    this.edits = new Map() // id del mensaje -> { text, n } (la última edición de su autor)
    this.reacts = new Map() // id -> Map(emoji -> Map(autor -> { on, n }))
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

  /** @returns {'new'|'dup'|'bad'}  Rechaza lo mal formado y lo que no lleve la firma válida de su autor. */
  add(raw) {
    const ev = cleanEvent(raw)
    if (!ev) return 'bad'
    if (this.events.has(idOf(ev))) return 'dup'
    if (!verify(ev)) return 'bad'
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
      if (!this.deleted.has(id)) this._place(this.chan.get(ev.ch) || this.chan.set(ev.ch, []).get(ev.ch), ev)
    } else if (ev.t === 'dm') {
      if (!this.deleted.has(id)) this._place(this._thread(ev.a, ev.to), ev)
    } else if (ev.t === 'del') {
      if (ev.x.startsWith(ev.a + ':')) { // solo puedes borrar lo tuyo
        this.deleted.add(ev.x)
        const target = this.events.get(ev.x)
        const list = target && (target.t === 'msg' ? this.chan.get(target.ch) : target.t === 'dm' ? this._thread(target.a, target.to) : null)
        const i = list ? list.indexOf(target) : -1
        if (i >= 0) list.splice(i, 1)
      }
    } else if (ev.t === 'chan') {
      let c = this.chans.get(ev.ch)
      if (!c) c = this.chans.set(ev.ch, { def: null, k: ev.k, first: ev, cur: ev }).get(ev.ch)
      else if (c.k !== ev.k) return // el tipo de un canal no cambia nunca
      if (!c.first || cmp(ev, c.first) < 0) c.first = ev
      if (!c.cur || cmp(c.cur, ev) < 0) c.cur = ev
    } else if (ev.t === 'pin') {
      const cur = this.pins.get(ev.x)
      if (!cur || cmp(cur, ev) < 0) this.pins.set(ev.x, ev)
    } else if (ev.t === 'emb') {
      if (ev.x.startsWith(ev.a + ':')) { // solo el autor del mensaje añade su vista previa
        const cur = this.embeds.get(ev.x)
        if (!cur || ev.n > cur.n) this.embeds.set(ev.x, ev)
      }
    } else if (ev.t === 'edit') {
      if (ev.x.startsWith(ev.a + ':')) { // solo puedes editar lo tuyo
        const cur = this.edits.get(ev.x)
        if (!cur || ev.n > cur.n) this.edits.set(ev.x, { text: ev.text, n: ev.n })
      }
    } else if (ev.t === 'react') {
      const byEmoji = this.reacts.get(ev.x) || this.reacts.set(ev.x, new Map()).get(ev.x)
      const byUser = byEmoji.get(ev.e) || byEmoji.set(ev.e, new Map()).get(ev.e)
      const cur = byUser.get(ev.a)
      if (!cur || ev.n > cur.n) byUser.set(ev.a, { on: ev.on, n: ev.n })
    } else if (ev.t === 'prof') {
      const cur = this.names.get(ev.a)
      if (!cur || ev.n > cur.n) this.names.set(ev.a, { name: ev.name, av: ev.av || null, avs: ev.avs || 0, n: ev.n })
    }
  }

  _place(list, ev) {
    let i = list.length
    while (i > 0 && cmp(list[i - 1], ev) > 0) i--
    list.splice(i, 0, ev)
  }

  _thread(x, y) {
    const k = x < y ? `${x}:${y}` : `${y}:${x}`
    return this.dms.get(k) || this.dms.set(k, []).get(k)
  }

  /** Canales vigentes: los predefinidos primero y luego los creados, por antigüedad. */
  channels() {
    const out = []
    for (const [id, c] of this.chans) {
      if (c.cur?.del) continue
      const base = c.def || {}
      out.push({
        id, type: c.k, name: c.cur?.name || base.name, ...(base.topic ? { topic: base.topic } : {}),
        _o: c.def ? CHANNELS.indexOf(c.def) - 1e6 : c.first.ts
      })
    }
    return out.sort((a, b) => a._o - b._o || (a.id < b.id ? -1 : 1)).map(({ _o, ...c }) => c)
  }

  channel(id) { return this.channels().find((c) => c.id === id) || null }

  /** Mensajes directos entre dos usuarios (cifrados), ordenados. */
  dmThread(x, y) { return this.dms.get(x < y ? `${x}:${y}` : `${y}:${x}`) || [] }

  /** Con quién tiene conversaciones `me`, con el último mensaje de cada una. */
  dmPeers(me) {
    const out = new Map()
    for (const list of this.dms.values()) {
      const last = list[list.length - 1]
      if (!last || (last.a !== me && last.to !== me)) continue
      out.set(last.a === me ? last.to : last.a, last)
    }
    return out
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

  /** Mensaje con sus ediciones, reacciones y la vista previa de a quién responde. */
  decorate(ev) {
    if (ev.t !== 'msg') return ev
    const id = idOf(ev)
    const out = { ...ev }
    const ed = this.edits.get(id)
    if (ed) { out.text = ed.text; out.edited = true }
    const rs = this.reacts.get(id)
    if (rs) {
      const list = [...rs]
        .map(([e, users]) => ({ e, users: [...users].filter(([, v]) => v.on).map(([a]) => a) }))
        .filter((r) => r.users.length)
      if (list.length) out.reactions = list
    }
    const pin = this.pins.get(id)
    if (pin?.on) { out.pinned = true; out.pinnedBy = pin.a }
    const emb = this.embeds.get(id)
    if (emb) out.emb = { url: emb.url, title: emb.title, desc: emb.desc, site: emb.site }
    if (ev.re) {
      const t = this.events.get(ev.re)
      out.reply = t && t.t === 'msg' && !this.deleted.has(ev.re)
        ? { id: ev.re, a: t.a, text: (this.edits.get(ev.re)?.text ?? t.text).slice(0, 140), att: !!t.att?.length }
        : { id: ev.re, missing: true }
    }
    return out
  }

  /** Mensaje (decorado) por id, o null si no existe o está borrado. */
  message(id) {
    const ev = this.events.get(id)
    return ev && ev.t === 'msg' && !this.deleted.has(id) ? this.decorate(ev) : null
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
    return list.slice(Math.max(0, end - limit), end).map((e) => this.decorate(e))
  }

  /** Ventana de mensajes alrededor de uno (para saltar a un resultado de búsqueda o a un fijado). tail = incluye el último. */
  around(ch, id, { before = 30, after = 300 } = {}) {
    const list = this.chan.get(ch) || []
    const i = list.findIndex((e) => idOf(e) === id)
    if (i < 0) return null
    const end = Math.min(list.length, i + after + 1)
    return { msgs: list.slice(Math.max(0, i - before), end).map((e) => this.decorate(e)), tail: end === list.length }
  }

  /** Mensajes fijados de un canal, el último fijado primero. */
  pinned(ch) {
    const out = []
    for (const [id, p] of this.pins) {
      const ev = p.on && !this.deleted.has(id) ? this.events.get(id) : null
      if (ev && ev.t === 'msg' && ev.ch === ch) out.push([p, ev])
    }
    return out.sort((a, b) => cmp(b[0], a[0])).map(([, ev]) => this.decorate(ev))
  }

  /** Búsqueda de texto (sin distinguir mayúsculas ni acentos) en los canales de texto vigentes; lo más reciente primero. */
  search(query, { ch = null, limit = 40 } = {}) {
    const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    const words = fold(String(query || '')).split(/\s+/).filter(Boolean).slice(0, 8)
    if (!words.length) return []
    const live = new Set(this.channels().filter((c) => c.type === 'text').map((c) => c.id))
    const hits = []
    for (const [id, list] of this.chan) {
      if (!live.has(id) || (ch && id !== ch)) continue
      for (const ev of list) {
        const text = fold((this.edits.get(idOf(ev))?.text ?? ev.text) + ' ' + (ev.att || []).map((a) => a.name).join(' '))
        if (words.every((w) => text.includes(w))) hits.push(ev)
      }
    }
    return hits.sort((a, b) => cmp(b, a)).slice(0, limit).map((e) => this.decorate(e))
  }

  last(ch) {
    const list = this.chan.get(ch) || []
    return list.length ? list[list.length - 1] : null
  }

  /** Mensajes con adjuntos cuyos blobs podrían faltar. */
  *attachments() {
    for (const list of this.chan.values()) for (const ev of list) if (ev.att) for (const a of ev.att) yield a
    for (const v of this.names.values()) if (v.av) yield { h: v.av, size: v.avs, mime: 'image/webp', name: 'avatar' }
  }

  /** Autores conocidos con su nombre más reciente. */
  members() {
    const out = new Map()
    for (const a of this.contig.keys()) out.set(a, this.names.get(a)?.name || null)
    for (const [a, v] of this.names) out.set(a, v.name)
    return out
  }
}

module.exports = { Store, cleanEvent, idOf, cleanChannelName, CHAN_ID }
