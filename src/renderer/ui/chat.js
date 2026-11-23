// Panel de chat de un canal de texto: cabecera, mensajes, redactor.
// Mensajes con respuestas, edición, reacciones, menciones, "escribiendo…" y divisor de nuevos.
import { h, $, fill, avatar, fmtStamp, fmtClock, fmtDay, fmtFull, dayKey, fmtBytes, debounce } from '../util.js'
import { icon } from '../icons.js'
import { state, bus, channel, member, markRead } from '../state.js'
import { renderMarkdown } from '../markdown.js'
import { openLightbox, confirmModal, toast, openContextMenu } from './overlays.js'
import { openEmojiPicker, quickEmoji } from '../emoji.js'
import { openProfile } from './popout.js'

export const evId = (ev) => `${ev.a}:${ev.n}`
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

let root, scroller, list, input, pendingBox, fileInput, replyBar, typingEl, jumpBtn, mentionBox, attachBtn, searchBox, searchInput, panelEl
let cur = { ch: null, msgs: [], full: false, loading: false, divider: null, atEnd: true }
let panel = null // panel lateral abierto: { kind: 'pins' | 'search', items, q }
let pendingJump = null // { ch, id }: mensaje al que saltar en cuanto se cargue el canal
let searchToken = 0
const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/
const isDm = () => cur.ch?.startsWith('dm:')
const drafts = new Map()
let pending = [] // adjuntos preparados, aún sin enviar
let replyTo = null // { id, a, text }
let editing = null // id del mensaje que se está editando
let lastTyping = 0
const mentionMap = new Map() // "@Nombre" -> id, para el borrador actual
let mention = null // { items, index } mientras el autocompletado está abierto

// ───────────────────────── montaje ─────────────────────────
export function mountChat(el) {
  root = el
  list = h('div.messages')
  scroller = h('div.scroller', list)
  jumpBtn = h('button.jump', { onclick: () => { if (!cur.atEnd) showChannel(cur.ch, true); else scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }) } }, 'Saltar al presente', icon('arrowDown', 16))
  panelEl = h('aside.side-panel.hidden')
  searchInput = h('input', { type: 'text', placeholder: 'Buscar', maxLength: 100, spellcheck: false, 'aria-label': 'Buscar en los mensajes' })
  const clearSearch = h('button.hs-clear', { tip: 'Borrar búsqueda', onclick: () => { searchInput.value = ''; searchBox.classList.remove('has'); closePanel('search'); searchInput.focus() } }, icon('close', 14))
  searchBox = h('div.h-search', icon('search', 16), searchInput, clearSearch)
  searchInput.addEventListener('input', () => { searchBox.classList.toggle('has', !!searchInput.value); runSearch(false) })
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(true) }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearSearch.click(); searchInput.blur() }
  })
  input = h('textarea', { rows: 1, placeholder: '', spellcheck: true, maxLength: state.limits.text, 'aria-label': 'Mensaje' })
  pendingBox = h('div.pending')
  replyBar = h('div.reply-bar.hidden')
  typingEl = h('div.typing')
  mentionBox = h('div.mention-box.hidden')
  fileInput = h('input', { type: 'file', multiple: true, hidden: true })
  const emojiBtn = h('button.attach.emoji', { tip: 'Emojis', onclick: () => openEmojiPicker(emojiBtn, insertAtCaret) }, icon('smile', 24))
  const composer = h('div.composer-wrap',
    mentionBox, replyBar, pendingBox,
    h('div.composer', attachBtn = h('button.attach', { tip: 'Adjuntar archivo', onclick: () => fileInput.click() }, icon('plus', 24)), input, emojiBtn, fileInput),
    typingEl)
  root.append(h('div.header', { id: 'chat-header' }), h('div.chat-body', scroller, jumpBtn, panelEl), composer)

  input.addEventListener('input', onInput)
  input.addEventListener('keydown', onKeydown)
  input.addEventListener('click', checkMention)
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])]
    if (files.length && !isDm()) { e.preventDefault(); addFiles(files) }
  })
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = '' })
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop < 120) loadOlder()
    updateJump()
  })
  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('dropping') })
  root.addEventListener('dragleave', (e) => { if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove('dropping') })
  root.addEventListener('drop', (e) => {
    e.preventDefault(); root.classList.remove('dropping')
    if (!isDm()) addFiles([...e.dataTransfer.files])
  })
  bus.on('members', () => { if (cur.ch) { renderHeader(); if (isDm()) setPlaceholder() } })
  bus.on('channels', () => { if (cur.ch) { renderHeader(); setPlaceholder() } })
  bus.on('toggleMembers', renderHeader)
  bus.on('typing', renderTyping)
  setInterval(renderTyping, 1500)
}

function renderHeader() {
  const c = channel(cur.ch)
  const dm = c?.type === 'dm'
  fill($('#chat-header', root),
    dm ? icon('at', 24) : icon('hash', 24),
    h('span.h-title', c?.name || ''),
    !dm && c?.topic && h('span.h-sep'),
    !dm && c?.topic && h('span.h-topic', c.topic),
    dm && h('span.h-sep'),
    dm && h('span.h-topic', icon('lock', 14), 'Cifrado: solo vosotros dos podéis leer estos mensajes'),
    h('div.h-tools',
      !dm && h('button.icon-btn' + (panel?.kind === 'pins' ? '.active' : ''), { tip: 'Mensajes fijados', tipPos: 'bottom', onclick: togglePins }, icon('pin', 22)),
      h('button.icon-btn' + (state.showMembers ? '.active' : ''), {
        tip: state.showMembers ? 'Ocultar lista de miembros' : 'Mostrar lista de miembros', tipPos: 'bottom',
        onclick: () => bus.emit('toggleMembersClick')
      }, icon('people', 24)),
      !dm && searchBox))
}

function setPlaceholder() {
  const c = channel(cur.ch)
  if (c) input.placeholder = c.type === 'dm' ? `Enviar mensaje a @${c.name}` : `Enviar mensaje a #${c.name}`
}

// ───────────────────────── canal ─────────────────────────
export async function showChannel(ch, reload = false) {
  if (cur.ch && !reload) drafts.set(cur.ch, input.value)
  const lastRead = state.lastRead[ch] || state.firstRun
  const hadUnread = state.unread.has(ch)
  const changed = cur.ch !== ch
  cur = { ch, msgs: [], full: false, loading: false, divider: null, atEnd: true }
  if (!reload) { editing = null; replyTo = null; mentionMap.clear(); renderReplyBar(); closeMention() }
  if (changed) { pending = []; renderPending(); if (panel?.kind === 'pins') closePanel('pins'); else if (panel?.kind === 'search' && !pendingJump) closePanel('search') }
  setPlaceholder()
  attachBtn.classList.toggle('hidden', isDm())
  if (!reload) { input.value = drafts.get(ch) || ''; autosize() }
  renderHeader()
  renderTyping()
  list.replaceChildren()
  const msgs = await window.humble.history(ch, { limit: 60 })
  if (cur.ch !== ch) return // cambió de canal mientras cargaba
  const seen = new Set(msgs.map(evId))
  cur.msgs = [...msgs, ...cur.msgs.filter((m) => !seen.has(evId(m)))]
  cur.full = msgs.length < 60
  if (hadUnread && !reload) { const f = cur.msgs.find((m) => m.ts > lastRead && m.a !== state.me.id); cur.divider = f ? evId(f) : null }
  renderAll(true)
  touchRead()
  if (pendingJump?.ch === ch) { const id = pendingJump.id; pendingJump = null; return loadAround(id) }
  pendingJump = null
  if (!searchInput.matches(':focus')) input.focus()
}

/** Muestra un mensaje: si ya está en pantalla, se resalta; si no, se carga la zona del historial donde está. */
async function loadAround(id) {
  if (!list.querySelector(`[data-id="${id}"]`)) {
    const r = await window.humble.around(cur.ch, id).catch(() => null)
    if (!r) return toast('Ese mensaje ya no está disponible.')
    cur.msgs = r.msgs
    cur.atEnd = r.tail
    cur.full = false
    cur.divider = null
    renderAll(false)
    updateJump()
  }
  const el = list.querySelector(`[data-id="${id}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1800)
}

/** Ir a un mensaje de cualquier canal (resultados de búsqueda y fijados). */
function goTo(ch, id) {
  if (ch === cur.ch) return loadAround(id)
  pendingJump = { ch, id }
  state.view.ch = ch
  bus.emit('view')
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
  if (last && cur.atEnd && document.hasFocus() && state.view.ch === cur.ch) {
    markRead(cur.ch, last.ts)
    const a = state.unread.delete(cur.ch)
    const b = state.mentions.delete(cur.ch)
    if (a || b) bus.emit('unread')
  }
}

// ───────────────────────── eventos en vivo ─────────────────────────
/** Lote de eventos nuevos. Si es enorme (sincronización inicial) se recarga el canal en vez de insertar uno a uno. */
export function onEvents(evs, updates = []) {
  if (!cur.ch) return
  const mine = evs.filter((e) => e.t === 'del' || e.ch === cur.ch)
  if (mine.length > 100) return showChannel(cur.ch, true)
  for (const ev of mine) onEvent(ev)
  for (const u of updates) updateMessage(u)
  if (updates.length && panel?.kind === 'pins') refreshPins()
  if (evs.some((e) => e.t === 'del') && panel) refreshPanel()
}

function onEvent(ev) {
  if (ev.t === 'del') {
    const i = cur.msgs.findIndex((m) => evId(m) === ev.x)
    if (i >= 0) cur.msgs.splice(i, 1)
    for (const m of cur.msgs) if (m.reply?.id === ev.x) m.reply = { id: ev.x, missing: true }
    if (editing === ev.x) editing = null
    if (replyTo?.id === ev.x) { replyTo = null; renderReplyBar() }
    renderAll(false, true)
    return
  }
  if (ev.t !== 'msg' || ev.ch !== cur.ch) return
  if (cur.msgs.some((m) => evId(m) === evId(ev))) return
  if (!cur.atEnd) return updateJump(true) // estás leyendo historial antiguo: no se mezcla lo nuevo; "Saltar al presente" lo carga
  const last = cur.msgs[cur.msgs.length - 1]
  cur.msgs.push(ev)
  const inOrder = !last || last.ts < ev.ts || (last.ts === ev.ts && evId(last) < evId(ev))
  if (!inOrder) { cur.msgs.sort((a, b) => a.ts - b.ts || (evId(a) < evId(b) ? -1 : 1)); return renderAll(false, true) }
  const stick = nearBottom() || ev.a === state.me.id
  list.append(...buildOne(ev, last))
  if (stick) { scroller.scrollTop = scroller.scrollHeight; updateJump() }
  else updateJump(true)
  touchRead()
  // un mensaje propio deja de mostrar "escribiendo…" de ese usuario
  state.typing.get(cur.ch)?.delete(ev.a)
  renderTyping()
}

/** Edición o reacciones nuevas: se sustituye solo ese mensaje. */
function updateMessage(msg) {
  const i = cur.msgs.findIndex((m) => evId(m) === evId(msg))
  if (i < 0) return
  cur.msgs[i] = msg
  for (const m of cur.msgs) if (m.reply?.id === evId(msg)) m.reply = { ...m.reply, text: msg.text.slice(0, 140) }
  const el = list.querySelector(`[data-id="${evId(msg)}"]`)
  if (!el) return
  const stick = nearBottom()
  el.replaceWith(message(msg, el.classList.contains('grouped')))
  if (stick) scroller.scrollTop = scroller.scrollHeight
  updateJump()
}

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160

function updateJump(newOne) {
  const far = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 500
  jumpBtn.classList.toggle('show', !!(!cur.atEnd || far || (newOne && !nearBottom())))
}

function renderAll(toBottom, keep) {
  const stick = toBottom || (keep && nearBottom())
  const prevTop = scroller.scrollTop
  const frag = document.createDocumentFragment()
  if (cur.full) frag.append(welcome())
  cur.msgs.forEach((ev, i) => frag.append(...buildOne(ev, cur.msgs[i - 1])))
  list.replaceChildren(frag)
  if (stick) scroller.scrollTop = scroller.scrollHeight
  else if (keep) scroller.scrollTop = prevTop
  updateJump()
}

function welcome() {
  const c = channel(cur.ch)
  if (c.type === 'dm') {
    return h('div.welcome',
      h('div.w-avatar', avatar(member(c.peer), 80)),
      h('h1', c.name),
      h('p', `Este es el principio de tu conversación directa con ${c.name}. Va cifrada: solo vosotros dos podéis leerla.`))
  }
  return h('div.welcome',
    h('div.w-icon', icon('hash', 44)),
    h('h1', `¡Te damos la bienvenida a #${c.name}!`),
    h('p', `Este es el principio del canal #${c.name}.`))
}

/** Devuelve [divisores?, mensaje]. `prev` decide si va agrupado con el anterior. */
function buildOne(ev, prev) {
  const out = []
  const newDay = !prev || dayKey(prev.ts) !== dayKey(ev.ts)
  if (newDay) out.push(h('div.day', h('span', fmtDay(ev.ts))))
  if (cur.divider && cur.divider === evId(ev)) out.push(h('div.newline', h('span', 'NUEVO')))
  const grouped = !newDay && prev.a === ev.a && ev.ts - prev.ts < 7 * 60 * 1000 && !ev.reply && !(cur.divider && cur.divider === evId(ev))
  out.push(message(ev, grouped))
  return out
}

// ───────────────────────── un mensaje ─────────────────────────
const nameOf = (id) => member(id).name

function message(ev, grouped) {
  const id = evId(ev)
  const m = member(ev.a)
  const mine = ev.a === state.me.id
  const mentioned = !mine && ev.text.includes(`<@${state.me.id}>`)
  const profile = (e) => openProfile(e.currentTarget, ev.a)

  let body
  if (editing === id) body = editor(ev)
  else {
    body = h('div.m-body',
      !grouped && h('div.m-head', h('span.m-author', { onclick: profile }, m.name), h('time', { tip: fmtFull(ev.ts) }, fmtStamp(ev.ts)),
        ev.pinned && h('span.pinmark', { tip: 'Mensaje fijado' }, icon('pin', 14))),
      ev.text && h('div.m-text', renderMarkdown(ev.text), ev.edited && h('span.edited', { tip: 'Mensaje editado' }, '(editado)')),
      ev.emb && embedCard(ev.emb),
      ev.att?.length > 0 && h('div.atts', ev.att.map(attachment)),
      ev.reactions?.length > 0 && reactionsBar(ev))
  }
  return h('div.msg' + (grouped ? '.grouped' : '') + (ev.pinned ? '.pinned' : '') + (mentioned ? '.mentioned' : '') + (ev.reply ? '.has-reply' : '') + (editing === id ? '.editing' : ''), {
    dataset: { id, uid: ev.a },
    oncontextmenu: (e) => { if (e.target.closest('textarea,a')) return; e.preventDefault(); messageMenu(e, ev) }
  },
    ev.reply && replyPreview(ev.reply),
    h('div.m-gutter', grouped ? h('time', { tip: fmtFull(ev.ts) }, fmtClock(ev.ts)) : h('div.m-avatar', { onclick: profile }, avatar(m, 40))),
    body,
    editing !== id && toolbar(ev, mine))
}

function replyPreview(r) {
  if (r.missing) return h('div.reply', h('span.spine'), h('span.reply-missing', icon('reply', 14), 'No se puede cargar el mensaje original (puede haberse eliminado).'))
  const m = member(r.a)
  const text = r.text ? r.text.replace(/<@([0-9a-f]{64})>/g, (_s, id) => '@' + nameOf(id)).replace(/\s+/g, ' ') : ''
  return h('div.reply', { onclick: () => jumpTo(r.id) },
    h('span.spine'), avatar(m, 16),
    h('span.reply-name', '@' + m.name),
    h('span.reply-text', text || (r.att ? 'Haz clic para ver el adjunto' : '')))
}

function toolbar(ev, mine) {
  const id = evId(ev)
  if (ev.dm) return mine ? h('div.m-actions', h('button.icon-btn.danger', { tip: 'Eliminar', onclick: () => askDelete(ev) }, icon('trash', 20))) : null
  const react = h('button.icon-btn', { tip: 'Añadir reacción', onclick: () => openEmojiPicker(react, (e) => window.humble.react(id, e, true), { above: false }) }, icon('addReaction', 20))
  return h('div.m-actions',
    ...quickEmoji().slice(0, 2).map((e) => h('button.icon-btn.quick', { tip: e + ' reaccionar', onclick: () => window.humble.react(id, e, true) }, e)),
    react,
    h('button.icon-btn', { tip: 'Responder', onclick: () => startReply(ev) }, icon('reply', 20)),
    h('button.icon-btn' + (ev.pinned ? '.active' : ''), { tip: ev.pinned ? 'Quitar de fijados' : 'Fijar mensaje', onclick: () => window.humble.pin(id, !ev.pinned) }, icon('pin', 20)),
    mine && h('button.icon-btn', { tip: 'Editar', onclick: () => startEdit(ev) }, icon('pencil', 20)),
    mine && h('button.icon-btn.danger', { tip: 'Eliminar', onclick: () => askDelete(ev) }, icon('trash', 20)))
}

function messageMenu(e, ev) {
  const mine = ev.a === state.me.id
  const id = evId(ev)
  const copy = ev.text && { label: 'Copiar texto', icon: 'file', onclick: () => navigator.clipboard.writeText(plainText(ev.text)).then(() => toast('Texto copiado', 'ok')) }
  if (ev.dm) return openContextMenu(e.clientX, e.clientY, [copy, mine && 'sep', mine && { label: 'Eliminar mensaje', icon: 'trash', danger: true, onclick: () => askDelete(ev) }])
  openContextMenu(e.clientX, e.clientY, [
    { label: 'Añadir reacción', icon: 'addReaction', onclick: () => openEmojiPicker(list.querySelector(`[data-id="${id}"]`) || input, (em) => window.humble.react(id, em, true), { above: false }) },
    { label: 'Responder', icon: 'reply', onclick: () => startReply(ev) },
    { label: ev.pinned ? 'Quitar de fijados' : 'Fijar mensaje', icon: 'pin', onclick: () => window.humble.pin(id, !ev.pinned) },
    mine && { label: 'Editar mensaje', icon: 'pencil', onclick: () => startEdit(ev) },
    copy,
    mine && 'sep',
    mine && { label: 'Eliminar mensaje', icon: 'trash', danger: true, onclick: () => askDelete(ev) }
  ])
}

const plainText = (t) => t.replace(/<@([0-9a-f]{64})>/g, (_s, id) => '@' + nameOf(id))

function reactionsBar(ev) {
  const id = evId(ev)
  return h('div.reactions',
    ev.reactions.map((r) => {
      const mineR = r.users.includes(state.me.id)
      const names = r.users.map(nameOf)
      const who = names.length <= 3 ? names.join(', ').replace(/, ([^,]*)$/, ' y $1') : `${names.slice(0, 3).join(', ')} y ${names.length - 3} más`
      return h('button.react' + (mineR ? '.mine' : ''), { tip: `${who} reaccionó con ${r.e}`, onclick: () => window.humble.react(id, r.e, !mineR) },
        h('span.re-emoji', r.e), h('span.re-count', String(r.users.length)))
    }),
    h('button.react.add', { tip: 'Añadir reacción', onclick: (e) => openEmojiPicker(e.currentTarget, (em) => window.humble.react(id, em, true), { above: false }) }, icon('addReaction', 16)))
}

function attachment(a) {
  return IMAGE.test(a.mime) && a.size <= state.limits.autoBlob ? imageAtt(a) : fileCard(a)
}

function imageAtt(a) {
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

/** Archivo cualquiera: no se descarga solo; "Descargar" lo pide a quien lo tenga y luego se guarda donde quieras. */
function fileCard(a) {
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(a.name)?.[1] || 'archivo').toUpperCase()
  const action = h('div.f-action')
  const info = h('small', `${ext} · ${fmtBytes(a.size)}`)
  const card = h('div.file', h('div.f-icon', icon('file', 30)), h('div.f-info', h('div.f-name', { tip: a.name }, a.name), info), action)
  const save = () => window.humble.saveBlob(a.h, a.name).catch(() => toast('No se pudo guardar el archivo.', 'warn'))
  const showSave = () => { info.textContent = `${ext} · ${fmtBytes(a.size)} · en tu equipo`; fill(action, h('button.btn.secondary.small', { onclick: save }, icon('download', 16), 'Guardar como…')) }
  const showGet = (msg) => {
    if (msg) info.textContent = msg
    fill(action, h('button.btn.brand.small', { onclick: get }, icon('download', 16), msg ? 'Reintentar' : 'Descargar'))
  }
  async function get() {
    const bar = h('div.f-bar', h('i'))
    fill(action, bar)
    const tick = setInterval(async () => {
      const p = await window.humble.blobProgress(a.h).catch(() => null)
      if (p && !p.done && p.total) { bar.firstChild.style.width = Math.round((p.got / p.total) * 100) + '%'; info.textContent = `${ext} · ${fmtBytes(p.got)} de ${fmtBytes(p.total)}` }
      else if (!p || !p.done) info.textContent = `${ext} · buscando quién lo tiene…`
    }, 300)
    try { await window.humble.blobFetch(a.h); showSave() } catch { showGet('Nadie que lo tenga está conectado ahora mismo.') } finally { clearInterval(tick) }
  }
  window.humble.blobProgress(a.h).then((p) => (p.done ? showSave() : showGet())).catch(() => showGet())
  return card
}

function embedCard(e) {
  return h('a.embed', { href: e.url, onclick: (ev) => { ev.preventDefault(); window.humble.openExternal(e.url) }, tip: e.url },
    h('div.e-site', e.site), h('div.e-title', e.title), e.desc && h('div.e-desc', e.desc))
}

async function askDelete(ev) {
  const ok = await confirmModal({
    title: 'Eliminar mensaje',
    body: h('div.del-preview', h('p', '¿Seguro que quieres eliminar este mensaje?'),
      h('div.msg.preview', h('div.m-gutter', avatar(state.me, 40)),
        h('div.m-body', h('div.m-head', h('span.m-author', state.me.name), h('time', fmtStamp(ev.ts))),
          ev.text ? renderMarkdown(ev.text) : h('span.muted', `${ev.att.length} archivo(s)`)))),
    confirm: 'Eliminar', danger: true
  })
  if (ok) window.humble.remove(evId(ev)).catch(() => toast('No se pudo eliminar el mensaje.', 'warn'))
}

function jumpTo(id) {
  const el = list.querySelector(`[data-id="${id}"]`)
  if (!el) return loadAround(id)
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1800)
}

// ───────────────────────── responder y editar ─────────────────────────
export function startReply(ev) {
  replyTo = { id: evId(ev), a: ev.a, text: ev.text }
  renderReplyBar()
  input.focus()
}

function renderReplyBar() {
  replyBar.classList.toggle('hidden', !replyTo)
  if (!replyTo) return replyBar.replaceChildren()
  fill(replyBar,
    h('span', 'Respondiendo a ', h('b', nameOf(replyTo.a))),
    h('button.icon-btn', { tip: 'Cancelar respuesta', onclick: () => { replyTo = null; renderReplyBar(); input.focus() } }, icon('close', 16)))
}

/** `<@id>` -> "@Nombre" (para editar) y el mapa inverso para volver a convertir al guardar. */
function toDisplay(text) {
  const map = new Map()
  return { text: text.replace(/<@([0-9a-f]{64})>/g, (_s, id) => { const t = '@' + nameOf(id); map.set(t, id); return t }), map }
}

function fromDisplay(text, map) {
  for (const [token, id] of [...map].sort((a, b) => b[0].length - a[0].length)) {
    text = text.replace(new RegExp(escapeRe(token) + '(?![\\p{L}\\p{N}_])', 'gu'), `<@${id}>`)
  }
  return text
}

function startEdit(ev) {
  const prev = editing
  editing = evId(ev)
  for (const id of [prev, editing]) {
    const old = list.querySelector(`[data-id="${id}"]`)
    const msg = cur.msgs.find((m) => evId(m) === id)
    if (old && msg) old.replaceWith(message(msg, old.classList.contains('grouped')))
  }
  list.querySelector(`[data-id="${editing}"] textarea`)?.focus()
}

function stopEdit() {
  const id = editing
  editing = null
  const old = list.querySelector(`[data-id="${id}"]`)
  const msg = cur.msgs.find((m) => evId(m) === id)
  if (old && msg) old.replaceWith(message(msg, old.classList.contains('grouped')))
  input.focus()
}

function editor(ev) {
  const { text, map } = toDisplay(ev.text)
  const ta = h('textarea.edit-input', { rows: 1, maxLength: state.limits.text, spellcheck: true })
  ta.value = text
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 300) + 'px' }
  const save = async () => {
    const t = fromDisplay(ta.value, map).trim()
    if (!t) return askDelete(ev)
    if (t === ev.text) return stopEdit()
    editing = null
    try { await window.humble.edit(evId(ev), t) } catch { toast('No se pudo editar el mensaje.', 'warn') }
    const old = list.querySelector(`[data-id="${evId(ev)}"]`)
    const msg = cur.msgs.find((m) => evId(m) === evId(ev))
    if (old && msg) old.replaceWith(message(msg, old.classList.contains('grouped')))
    input.focus()
  }
  ta.addEventListener('input', fit)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopEdit() }
  })
  setTimeout(() => { fit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) })
  return h('div.m-body',
    h('div.m-head', h('span.m-author', member(ev.a).name)),
    h('div.editor', ta),
    h('div.editor-hint', 'escape para ', h('a', { onclick: stopEdit }, 'cancelar'), ' • intro para ', h('a', { onclick: save }, 'guardar')))
}

// ───────────────────────── "escribiendo…" ─────────────────────────
function renderTyping() {
  if (!typingEl) return
  const now = Date.now()
  const map = state.typing.get(cur.ch)
  const names = []
  if (map) for (const [id, until] of map) { if (until < now) map.delete(id); else if (id !== state.me.id) names.push(nameOf(id)) }
  if (!names.length) return typingEl.replaceChildren()
  const text = names.length === 1 ? `${names[0]} está escribiendo…` : names.length === 2 ? `${names[0]} y ${names[1]} están escribiendo…` : 'Varias personas están escribiendo…'
  fill(typingEl, h('span.dots', h('i'), h('i'), h('i')), h('span', h('b', text)))
}

// ───────────────────────── redactor ─────────────────────────
function autosize() {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 300) + 'px'
}

function insertAtCaret(text) {
  const a = input.selectionStart
  const b = input.selectionEnd
  input.setRangeText(text, a, b, 'end')
  input.focus()
  onInput()
}

function onInput() {
  autosize()
  checkMention()
  if (input.value.trim() && Date.now() - lastTyping > 3000 && cur.ch) {
    lastTyping = Date.now()
    window.humble.typing(cur.ch).catch(() => {})
  }
}

function onKeydown(e) {
  if (mention && !mentionBox.classList.contains('hidden')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : mention.items.length - 1)) % mention.items.length
      return drawMention()
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(mention.items[mention.index]) }
    if (e.key === 'Escape') { e.preventDefault(); return closeMention() }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); return }
  if (e.key === 'Escape' && replyTo) { replyTo = null; renderReplyBar(); return }
  if (e.key === 'ArrowUp' && !input.value && !isDm()) { // como en Discord: ↑ edita tu último mensaje
    const mine = [...cur.msgs].reverse().find((m) => m.a === state.me.id && m.text)
    if (mine) { e.preventDefault(); startEdit(mine) }
  }
}

// autocompletado de @menciones
function checkMention() {
  if (isDm()) return closeMention()
  const before = input.value.slice(0, input.selectionStart)
  const m = /(^|\s)@([^\s@]{0,24})$/.exec(before)
  if (!m) return closeMention()
  const q = norm(m[2])
  const items = state.members
    .filter((x) => norm(x.name).includes(q))
    .sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || (b.online - a.online) || a.name.localeCompare(b.name))
    .slice(0, 8)
  if (!items.length) return closeMention()
  mention = { items, index: 0, start: input.selectionStart - m[2].length - 1 }
  drawMention()
}

function drawMention() {
  mentionBox.classList.remove('hidden')
  fill(mentionBox, h('div.mb-title', 'Miembros'), ...mention.items.map((m, i) =>
    h('button.mb-item' + (i === mention.index ? '.active' : ''), { onmousedown: (e) => { e.preventDefault(); pickMention(m) } },
      avatar(m, 24), h('span.mb-name', m.name), !m.online && h('span.mb-off', 'sin conexión'))))
}

function closeMention() { mention = null; mentionBox?.classList.add('hidden') }

function pickMention(m) {
  const token = '@' + m.name
  mentionMap.set(token, m.id)
  input.setRangeText(token + ' ', mention.start, input.selectionStart, 'end')
  closeMention()
  input.focus()
  autosize()
}

async function submit() {
  let text = input.value.trim()
  if (!text && !pending.length) return
  text = fromDisplay(text, mentionMap)
  const ch = cur.ch
  const files = pending
  const re = replyTo?.id
  pending = []
  replyTo = null
  renderReplyBar()
  renderPending()
  input.value = ''
  mentionMap.clear()
  drafts.delete(ch)
  autosize()
  closeMention()
  try {
    if (ch.startsWith('dm:')) await window.humble.dmSend(ch.slice(3), text)
    else {
      const att = []
      for (const p of files) att.push(await window.humble.addBlob({ data: p.bytes, name: p.name, mime: p.mime, w: p.w, ht: p.ht }))
      await window.humble.send({ ch, text, att, re })
    }
    if (!cur.atEnd) await showChannel(cur.ch, true) // escribías desde un punto antiguo del historial: vuelve al presente
    scroller.scrollTop = scroller.scrollHeight
  } catch (e) {
    toast('No se pudo enviar: ' + String(e.message || e).replace(/^Error invoking remote method '\w+': (Error: )?/, ''), 'warn')
    input.value = text
    autosize()
  }
}

async function addFiles(files) {
  for (const f of files) {
    if (pending.length >= state.limits.attachments) { toast(`Máximo ${state.limits.attachments} archivos por mensaje.`, 'warn'); break }
    try { pending.push(f.type.startsWith('image/') ? await prepareImage(f) : await prepareFile(f)) } catch (e) { toast(e.message || 'No se pudo leer el archivo.', 'warn') }
  }
  renderPending()
  input.focus()
}

function renderPending() {
  pendingBox.replaceChildren(...pending.map((p, i) => h('div.pend',
    p.url ? h('img', { src: p.url, alt: '' }) : h('div.pend-file', icon('file', 44)),
    h('div.pend-name', p.name, h('small', fmtBytes(p.bytes.byteLength))),
    h('button.pend-x', { tip: 'Quitar', onclick: () => { if (p.url) URL.revokeObjectURL(p.url); pending.splice(i, 1); renderPending() } }, icon('close', 14)))))
  pendingBox.classList.toggle('has', pending.length > 0)
}

async function prepareFile(file) {
  if (file.size > state.limits.blob) throw new Error(`«${file.name}» pesa demasiado (máx. ${fmtBytes(state.limits.blob)}).`)
  if (!file.size) throw new Error(`«${file.name}» está vacío.`)
  return { bytes: await file.arrayBuffer(), mime: file.type || 'application/octet-stream', name: file.name || 'archivo' }
}

/** Lee la imagen; si es muy grande la reduce (WebP) para que viaje rápido entre amigos. */
async function prepareImage(file) {
  const bmp = await createImageBitmap(file).catch(() => null)
  if (!bmp) return prepareFile(file) // una imagen que el visor no entiende (p. ej. TIFF) viaja como archivo
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

// ───────────────────────── panel lateral: fijados y búsqueda ─────────────────────────
function closePanel(kind) {
  if (kind && panel?.kind !== kind) return
  panel = null
  renderPanel()
  renderHeader()
}

function togglePins() {
  if (panel?.kind === 'pins') return closePanel()
  panel = { kind: 'pins', items: [] }
  renderPanel()
  renderHeader()
  refreshPins()
}

async function refreshPins() {
  const ch = cur.ch
  const items = await window.humble.pinned(ch).catch(() => [])
  if (panel?.kind === 'pins' && cur.ch === ch) { panel.items = items; renderPanel() }
}

function refreshPanel() { if (panel?.kind === 'pins') refreshPins(); else if (panel?.kind === 'search') runSearch(true) }

const runSearchDebounced = debounce((now) => runSearch(now), 280)
function runSearch(now) {
  const q = searchInput.value.trim()
  if (q.length < 2) { if (panel?.kind === 'search') closePanel(); return }
  if (!now) return runSearchDebounced(true)
  const token = ++searchToken
  window.humble.search(q).then((items) => {
    if (token !== searchToken || searchInput.value.trim() !== q) return
    panel = { kind: 'search', items, q }
    renderPanel()
    renderHeader()
  }).catch(() => {})
}

/** Resalta las palabras buscadas sin distinguir mayúsculas ni acentos (el texto mostrado conserva los suyos). */
function highlight(text, q) {
  const words = [...new Set(norm(q).split(/\s+/).filter(Boolean))]
  let folded = ''
  const map = []
  for (let i = 0; i < text.length; i++) {
    const f = norm(text[i])
    folded += f
    for (let k = 0; k < f.length; k++) map.push(i)
  }
  const spans = []
  for (const w of words) for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) spans.push([map[at], map[at + w.length - 1] + 1])
  spans.sort((a, b) => a[0] - b[0])
  const out = []
  let pos = 0
  for (const [from, to] of spans) {
    if (to <= pos) continue
    const start = Math.max(from, pos)
    if (start > pos) out.push(text.slice(pos, start))
    out.push(h('mark', text.slice(start, to)))
    pos = to
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out.length ? out : text
}

function renderPanel() {
  panelEl.classList.toggle('hidden', !panel)
  if (!panel) return panelEl.replaceChildren()
  const pins = panel.kind === 'pins'
  const title = pins ? 'Mensajes fijados' : panel.items.length ? `${panel.items.length}${panel.items.length >= 40 ? '+' : ''} resultado${panel.items.length === 1 ? '' : 's'}` : 'Sin resultados'
  const empty = pins ? ['Aquí aparecerán los mensajes fijados', 'Pasa el ratón por un mensaje y pulsa el icono de la chincheta para fijarlo.'] : ['No se ha encontrado nada', 'Prueba con otras palabras. La búsqueda ignora mayúsculas y acentos.']
  fill(panelEl,
    h('div.sp-head', h('b', title), h('button.icon-btn', { tip: 'Cerrar', onclick: () => { if (!pins) { searchInput.value = ''; searchBox.classList.remove('has') } closePanel() } }, icon('close', 18))),
    h('div.sp-list',
      !panel.items.length && h('div.sp-empty', h('b', empty[0]), h('span', empty[1])),
      ...panel.items.map((m) => {
        const id = evId(m)
        const who = member(m.a)
        return h('div.sr', { onclick: () => goTo(m.ch, id) },
          !pins && h('div.sr-ch', icon('hash', 14), channel(m.ch)?.name || m.ch),
          h('div.sr-msg', avatar(who, 32),
            h('div.sr-body', h('div.sr-head', h('b', who.name), h('time', fmtStamp(m.ts))),
              h('div.sr-text', pins ? plainText(m.text || '📎 Archivo') : highlight(plainText(m.text || (m.att?.length ? m.att.map((a) => a.name).join(', ') : '')), panel.q))),
            pins && h('button.icon-btn', { tip: 'Quitar de fijados', onclick: (e) => { e.stopPropagation(); window.humble.pin(id, false) } }, icon('close', 16))))
      })))
}

export const focusInput = () => input?.focus()
