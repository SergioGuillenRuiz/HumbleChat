// Panel de chat de un canal de texto: cabecera, mensajes, redactor.
import { h, $, fill, avatar, fmtStamp, fmtClock, fmtDay, fmtFull, dayKey, fmtBytes } from '../util.js'
import { icon } from '../icons.js'
import { state, bus, channel, member, markRead } from '../state.js'
import { renderMarkdown } from '../markdown.js'
import { openLightbox, confirmModal, toast } from './overlays.js'

export const evId = (ev) => `${ev.a}:${ev.n}`

let root, scroller, list, composer, input, pendingBox, fileInput
let cur = { ch: null, msgs: [], full: false, loading: false }
const drafts = new Map()
let pending = [] // adjuntos preparados, aún sin enviar

export function mountChat(el) {
  root = el
  const header = h('div.header', { id: 'chat-header' })
  list = h('div.messages')
  scroller = h('div.scroller', list)
  input = h('textarea', { rows: 1, placeholder: '', spellcheck: true, maxLength: state.limits.text, 'aria-label': 'Mensaje' })
  pendingBox = h('div.pending')
  fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true })
  composer = h('div.composer-wrap',
    pendingBox,
    h('div.composer',
      h('button.attach', { title: 'Adjuntar imagen', onclick: () => fileInput.click() }, icon('plus', 24)),
      input, fileInput))
  root.append(header, h('div.chat-body', scroller), composer)

  input.addEventListener('input', autosize)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
  })
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'))
    if (files.length) { e.preventDefault(); addFiles(files) }
  })
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = '' })
  scroller.addEventListener('scroll', () => { if (scroller.scrollTop < 120) loadOlder() })
  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('dropping') })
  root.addEventListener('dragleave', (e) => { if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove('dropping') })
  root.addEventListener('drop', (e) => {
    e.preventDefault(); root.classList.remove('dropping')
    addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')))
  })
  bus.on('members', () => { if (cur.ch) renderHeader() })
  bus.on('toggleMembers', renderHeader)
}

function renderHeader() {
  const c = channel(cur.ch)
  fill($('#chat-header', root),
    icon('hash', 24),
    h('span.h-title', c?.name || ''),
    c?.topic && h('span.h-sep'),
    c?.topic && h('span.h-topic', c.topic),
    h('div.h-tools',
      h('button.icon-btn' + (state.showMembers ? '.active' : ''), {
        title: state.showMembers ? 'Ocultar lista de miembros' : 'Mostrar lista de miembros',
        onclick: () => bus.emit('toggleMembersClick')
      }, icon('people', 24))))
}

export async function showChannel(ch, reload = false) {
  if (cur.ch && !reload) drafts.set(cur.ch, input.value)
  cur = { ch, msgs: [], full: false, loading: false }
  const c = channel(ch)
  input.placeholder = `Enviar mensaje a #${c.name}`
  if (!reload) { input.value = drafts.get(ch) || ''; autosize() }
  renderHeader()
  list.replaceChildren()
  const msgs = await window.humble.history(ch, { limit: 60 })
  if (cur.ch !== ch) return // cambió de canal mientras cargaba
  const seen = new Set(msgs.map(evId))
  cur.msgs = [...msgs, ...cur.msgs.filter((m) => !seen.has(evId(m)))]
  cur.full = msgs.length < 60
  renderAll(true)
  touchRead()
  if (!('ontouchstart' in window)) input.focus()
}

async function loadOlder() {
  if (cur.loading || cur.full || !cur.msgs.length) return
  cur.loading = true
  const ch = cur.ch
  const first = cur.msgs[0]
  const older = await window.humble.history(ch, { beforeTs: first.ts, beforeId: evId(first), limit: 50 })
  if (cur.ch !== ch) return
  cur.loading = false
  if (older.length < 50) cur.full = true
  if (!older.length) return renderAll(false)
  const before = scroller.scrollHeight - scroller.scrollTop
  cur.msgs = [...older, ...cur.msgs]
  renderAll(false)
  scroller.scrollTop = scroller.scrollHeight - before
}

export function touchRead() {
  const last = cur.msgs[cur.msgs.length - 1]
  if (last && document.hasFocus() && state.view.ch === cur.ch) {
    markRead(cur.ch, last.ts)
    if (state.unread.delete(cur.ch)) bus.emit('unread')
  }
}

/** Lote de eventos nuevos. Si es enorme (sincronización inicial) se recarga el canal en vez de insertar uno a uno. */
export function onEvents(evs) {
  if (!cur.ch) return
  const mine = evs.filter((e) => e.t === 'del' || e.ch === cur.ch)
  if (mine.length > 100) return showChannel(cur.ch, true)
  for (const ev of mine) onEvent(ev)
}

function onEvent(ev) {
  if (ev.t === 'del') {
    const i = cur.msgs.findIndex((m) => evId(m) === ev.x)
    if (i >= 0) { cur.msgs.splice(i, 1); renderAll(false, true) }
    return
  }
  if (ev.t !== 'msg' || ev.ch !== cur.ch) return
  if (cur.msgs.some((m) => evId(m) === evId(ev))) return
  const last = cur.msgs[cur.msgs.length - 1]
  cur.msgs.push(ev)
  const inOrder = !last || last.ts < ev.ts || (last.ts === ev.ts && evId(last) < evId(ev))
  if (!inOrder) { cur.msgs.sort((a, b) => a.ts - b.ts || (evId(a) < evId(b) ? -1 : 1)); return renderAll(false, true) }
  const stick = nearBottom() || ev.a === state.me.id
  list.append(...buildOne(ev, last))
  if (stick) scroller.scrollTop = scroller.scrollHeight
  touchRead()
}

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160

function renderAll(toBottom, keep) {
  const stick = toBottom || (keep && nearBottom())
  const prevTop = scroller.scrollTop
  const frag = document.createDocumentFragment()
  if (cur.full) frag.append(welcome())
  cur.msgs.forEach((ev, i) => frag.append(...buildOne(ev, cur.msgs[i - 1])))
  list.replaceChildren(frag)
  if (stick) scroller.scrollTop = scroller.scrollHeight
  else if (keep) scroller.scrollTop = prevTop
}

function welcome() {
  const c = channel(cur.ch)
  return h('div.welcome',
    h('div.w-icon', icon('hash', 44)),
    h('h1', `¡Te damos la bienvenida a #${c.name}!`),
    h('p', `Este es el principio del canal #${c.name}.`))
}

/** Devuelve [divisor de día?, mensaje]. `prev` decide si va agrupado con el anterior. */
function buildOne(ev, prev) {
  const out = []
  const newDay = !prev || dayKey(prev.ts) !== dayKey(ev.ts)
  if (newDay) out.push(h('div.day', h('span', fmtDay(ev.ts))))
  const grouped = !newDay && prev.a === ev.a && ev.ts - prev.ts < 7 * 60 * 1000
  out.push(message(ev, grouped))
  return out
}

function message(ev, grouped) {
  const m = member(ev.a)
  const mine = ev.a === state.me.id
  const body = h('div.m-body',
    !grouped && h('div.m-head', h('span.m-author', m.name), h('time', { title: fmtFull(ev.ts) }, fmtStamp(ev.ts))),
    ev.text && renderMarkdown(ev.text),
    ev.att?.length > 0 && h('div.atts', ev.att.map(attachment)))
  return h('div.msg' + (grouped ? '.grouped' : ''), { dataset: { id: evId(ev), uid: ev.a } },
    h('div.m-gutter', grouped ? h('time', { title: fmtFull(ev.ts) }, fmtClock(ev.ts)) : avatar(m, 40)),
    body,
    mine && h('div.m-actions', h('button.icon-btn', { title: 'Eliminar', onclick: () => askDelete(ev) }, icon('trash', 18))))
}

function attachment(a) {
  const src = `humble://blob/${a.h}?m=${encodeURIComponent(a.mime)}`
  let w = a.w || 400
  let hh = a.ht || 300
  const k = Math.min(1, 400 / w, 300 / hh)
  w = Math.round(w * k); hh = Math.round(hh * k)
  const img = h('img.att', { src, alt: a.name, style: a.w ? { width: w + 'px', height: hh + 'px' } : {}, loading: 'lazy', onclick: () => openLightbox(a) })
  const box = h('div.att-box', { style: a.w ? { width: w + 'px', height: hh + 'px' } : {} }, img)
  img.addEventListener('error', () => {
    box.replaceChildren(h('button.att-missing', { onclick: () => { box.replaceChildren(img); img.src = src + '&r=' + Date.now() } },
      icon('image', 28), h('span', 'Imagen no disponible'), h('small', 'Quien la envió no está conectado. Pulsa para reintentar.')))
  })
  return box
}

async function askDelete(ev) {
  const ok = await confirmModal({
    title: 'Eliminar mensaje',
    body: h('div.del-preview', h('p', '¿Seguro que quieres eliminar este mensaje?'),
      h('div.msg.preview', h('div.m-gutter', avatar(state.me, 40)),
        h('div.m-body', h('div.m-head', h('span.m-author', state.me.name), h('time', fmtStamp(ev.ts))),
          ev.text ? renderMarkdown(ev.text) : h('span.muted', `${ev.att.length} imagen(es)`)))),
    confirm: 'Eliminar', danger: true
  })
  if (ok) window.humble.remove(evId(ev)).catch(() => toast('No se pudo eliminar el mensaje.', 'warn'))
}

// ───────────── Redactor ─────────────
function autosize() {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 300) + 'px'
}

async function submit() {
  const text = input.value.trim()
  if (!text && !pending.length) return
  const ch = cur.ch
  const files = pending
  pending = []
  renderPending()
  input.value = ''
  drafts.delete(ch)
  autosize()
  try {
    const att = []
    for (const p of files) att.push(await window.humble.addBlob({ data: p.bytes, name: p.name, mime: p.mime, w: p.w, ht: p.ht }))
    await window.humble.send({ ch, text, att })
  } catch (e) {
    toast('No se pudo enviar: ' + String(e.message || e).replace(/^Error invoking remote method '\w+': (Error: )?/, ''), 'warn')
    input.value = text
    autosize()
  }
}

async function addFiles(files) {
  for (const f of files) {
    if (pending.length >= state.limits.attachments) { toast(`Máximo ${state.limits.attachments} imágenes por mensaje.`, 'warn'); break }
    try { pending.push(await prepareImage(f)) } catch (e) { toast(e.message || 'No se pudo leer la imagen.', 'warn') }
  }
  renderPending()
  input.focus()
}

function renderPending() {
  pendingBox.replaceChildren(...pending.map((p, i) => h('div.pend',
    h('img', { src: p.url, alt: '' }),
    h('div.pend-name', p.name, h('small', fmtBytes(p.bytes.byteLength))),
    h('button.pend-x', { title: 'Quitar', onclick: () => { URL.revokeObjectURL(p.url); pending.splice(i, 1); renderPending() } }, icon('close', 14)))))
  pendingBox.classList.toggle('has', pending.length > 0)
}

/** Lee la imagen; si es muy grande la reduce (WebP) para que viaje rápido entre amigos. */
async function prepareImage(file) {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('No se pudo leer esa imagen.') })
  const max = 2400
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const isGif = file.type === 'image/gif'
  let blob = file
  let w = bmp.width
  let ht = bmp.height
  if (!isGif && (k < 1 || file.size > 2.5 * 1024 * 1024)) {
    w = Math.round(bmp.width * k); ht = Math.round(bmp.height * k)
    const c = new OffscreenCanvas(w, ht)
    c.getContext('2d').drawImage(bmp, 0, 0, w, ht)
    blob = await c.convertToBlob({ type: 'image/webp', quality: 0.9 })
  }
  bmp.close?.()
  if (blob.size > state.limits.blob) throw new Error('La imagen pesa demasiado (máx. ' + fmtBytes(state.limits.blob) + ').')
  const mime = blob.type || file.type
  const base = (file.name || 'imagen').replace(/\.[a-z0-9]+$/i, '')
  const ext = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' }[mime] || 'img'
  return { bytes: await blob.arrayBuffer(), mime, w, ht, name: `${base}.${ext}`, url: URL.createObjectURL(blob) }
}

export const focusInput = () => input?.focus()
