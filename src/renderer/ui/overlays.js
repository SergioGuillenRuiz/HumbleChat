// Ventanas flotantes: avisos, visor de imágenes, selector de pantalla, confirmaciones,
// menú de volumen por usuario y Ajustes.
import { h, $, store, avatar } from '../util.js'
import { icon } from '../icons.js'
import { state, bus } from '../state.js'

// ───────────── Avisos ─────────────
export function toast(text, kind = 'info') {
  let box = $('#toasts')
  if (!box) { box = h('div#toasts'); document.body.append(box) }
  const el = h('div.toast.' + kind, text)
  box.append(el)
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250) }, 5000)
}

function layer(cls) {
  const el = h('div.layer.' + cls)
  document.body.append(el)
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true) }
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); el.dispatchEvent(new Event('dismiss')) } }
  document.addEventListener('keydown', onKey, true)
  return { el, close }
}

// ───────────── Visor de imágenes ─────────────
export function openLightbox(att) {
  const { el, close } = layer('lightbox')
  const src = `humble://blob/${att.h}?m=${encodeURIComponent(att.mime)}`
  el.append(
    h('img', { src, alt: att.name, onclick: (e) => e.stopPropagation() }),
    h('div.lb-bar', { onclick: (e) => e.stopPropagation() },
      h('span.lb-name', att.name),
      h('button.lb-btn', { onclick: () => window.humble.saveBlob(att.h, att.name) }, icon('download', 16), 'Guardar')
    )
  )
  el.addEventListener('click', close)
}

// ───────────── Confirmación ─────────────
export function confirmModal({ title, body, confirm = 'Aceptar', danger = false }) {
  return new Promise((resolve) => {
    const { el, close } = layer('modal-bg')
    let done = false
    const finish = (v) => { if (done) return; done = true; close(); resolve(v) }
    el.addEventListener('dismiss', () => finish(false))
    el.addEventListener('mousedown', (e) => { if (e.target === el) finish(false) })
    el.append(h('div.modal',
      h('div.modal-body', h('h2', title), body),
      h('div.modal-foot',
        h('button.btn.link', { onclick: () => finish(false) }, 'Cancelar'),
        h('button.btn' + (danger ? '.danger' : '.brand'), { onclick: () => finish(true), autofocus: true }, confirm)
      )
    ))
    $('.modal-foot .btn:last-child', el).focus()
  })
}

// ───────────── Elegir qué pantalla compartir ─────────────
export async function pickScreenSource() {
  let sources = []
  toast('Buscando pantallas y ventanas…')
  try { sources = await window.humble.listScreens() } catch {}
  if (!sources.length) { toast('No se encontró ninguna pantalla para compartir.', 'warn'); return null }
  return new Promise((resolve) => {
    const { el, close } = layer('modal-bg')
    let done = false
    const finish = (v) => { if (done) return; done = true; close(); resolve(v) }
    el.addEventListener('dismiss', () => finish(null))
    el.addEventListener('mousedown', (e) => { if (e.target === el) finish(null) })
    const card = (s) => h('button.src-card', { onclick: () => finish(s.id) },
      h('img', { src: s.thumb, alt: '' }), h('span', s.name))
    el.append(h('div.modal.wide',
      h('div.modal-body', h('h2', 'Compartir pantalla'),
        h('div.src-grid', ...sources.filter((s) => s.screen).map(card)),
        sources.some((s) => !s.screen) && h('h3', 'Ventanas'),
        h('div.src-grid', ...sources.filter((s) => !s.screen).map(card))),
      h('div.modal-foot', h('button.btn.link', { onclick: () => finish(null) }, 'Cancelar'))
    ))
  })
}

// ───────────── Menú de volumen de un usuario ─────────────
export function openVolumeMenu(x, y, id, voice) {
  $('.ctx')?.remove()
  const m = state.byId.get(id)
  const cur = Math.round(voice.getVolume(id) * 100)
  const val = h('span.ctx-val', cur + '%')
  const range = h('input', {
    type: 'range', min: 0, max: 100, value: cur,
    oninput: () => { val.textContent = range.value + '%'; voice.setVolume(id, range.value / 100) }
  })
  const menu = h('div.ctx', { style: { left: Math.min(x, innerWidth - 230) + 'px', top: Math.min(y, innerHeight - 90) + 'px' } },
    h('div.ctx-title', m?.name || 'Usuario'),
    h('div.ctx-row', h('label', 'Volumen de usuario'), val),
    range)
  document.body.append(menu)
  const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); removeEventListener('mousedown', off, true) } }
  setTimeout(() => addEventListener('mousedown', off, true))
}

// ───────────── Ajustes ─────────────
export function openSettings(voice) {
  const { el, close } = layer('settings')
  let tab = 'account'
  let meterStop = null
  const closeAll = () => { close(); el.dispatchEvent(new Event('dismiss')) }
  el.addEventListener('dismiss', () => meterStop?.())

  const nav = h('nav')
  const content = h('div.st-content')
  const tabs = [['account', 'Mi cuenta'], ['voice', 'Voz'], ['about', 'Acerca de']]

  function render() {
    meterStop?.(); meterStop = null
    nav.replaceChildren(
      h('div.st-title', 'Ajustes de usuario'),
      ...tabs.map(([id, label]) => h('button.st-item' + (id === tab ? '.active' : ''), { onclick: () => { tab = id; render() } }, label))
    )
    content.replaceChildren(({ account, voice: voiceTab, about })[tab]())
  }

  function account() {
    const input = h('input.text', { value: state.me.name, maxLength: state.limits.name, spellcheck: false })
    const save = h('button.btn.brand', {
      onclick: async () => {
        const n = input.value.trim()
        if (!n) return
        state.me.name = await window.humble.setName(n)
        input.value = state.me.name
        toast('Nombre actualizado', 'ok')
      }
    }, 'Guardar')
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click() })
    return h('div',
      h('h2', 'Mi cuenta'),
      h('div.card.profile', avatar(state.me, 80), h('div', h('div.big', state.me.name), h('div.muted', 'Tu nombre es lo que ven tus amigos'))),
      h('label.field', 'Nombre de usuario', h('div.row', input, save)),
      h('p.muted', 'No hay cuentas ni contraseñas: tu identidad es una clave que se crea sola en este equipo.')
    )
  }

  function voiceTab() {
    const inSel = h('select')
    const outSel = h('select')
    const bar = h('div.meter-fill')
    const fill = (sel, devs, cur) => {
      sel.replaceChildren(h('option', { value: '' }, 'Predeterminado'), ...devs.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || 'Dispositivo ' + (i + 1))))
    }
    ;(async () => {
      let probe = null
      try { probe = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch {}
      const devs = await navigator.mediaDevices.enumerateDevices()
      probe?.getTracks().forEach((t) => t.stop())
      fill(inSel, devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'), state.prefs.input)
      fill(outSel, devs.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'), state.prefs.output)
      startMeter()
    })()

    async function startMeter() {
      let stream, ctx, timer
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: state.prefs.input ? { deviceId: { exact: state.prefs.input } } : true })
      } catch { return }
      ctx = new AudioContext()
      const an = ctx.createAnalyser()
      an.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(an.fftSize)
      timer = setInterval(() => {
        an.getByteTimeDomainData(buf)
        let s = 0
        for (const v of buf) { const x = (v - 128) / 128; s += x * x }
        bar.style.width = Math.min(100, Math.sqrt(s / buf.length) * 400) + '%'
      }, 60)
      meterStop = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); ctx.close() }
    }

    inSel.addEventListener('change', async () => {
      state.prefs.input = inSel.value; store('input', inSel.value)
      meterStop?.(); await startMeter(); await voice.applyDevices()
    })
    outSel.addEventListener('change', () => { state.prefs.output = outSel.value; store('output', outSel.value); voice.applyDevices() })

    return h('div',
      h('h2', 'Voz'),
      h('label.field', 'Dispositivo de entrada', inSel),
      h('label.field', 'Dispositivo de salida', outSel),
      h('div.field', h('div.label', 'Prueba de micrófono'), h('div.meter', bar)),
      h('p.muted', 'La cancelación de eco, la supresión de ruido y el control automático de ganancia están activados.')
    )
  }

  function about() {
    const peers = state.members.filter((m) => m.online && m.id !== state.me.id)
    const label = { online: 'Conectado a la red', connecting: 'Buscando a tus amigos…', offline: 'Sin conexión a Internet' }[state.status.state]
    return h('div',
      h('h2', 'Acerca de'),
      h('div.card',
        h('div.kv', h('span', 'Red'), h('b', label)),
        h('div.kv', h('span', 'Amigos conectados'), h('b', String(peers.length))),
        h('div.kv', h('span', 'Tu ID'), h('code.inline', state.me.id.slice(0, 16)))),
      h('p.muted', 'No hay servidor: las apps se encuentran en una red P2P y se conectan directamente entre ellas. El historial se guarda en cada equipo y se sincroniza al coincidir.')
    )
  }

  el.append(
    h('div.st-side', nav),
    h('div.st-main', content, h('button.st-close', { onclick: closeAll, title: 'Cerrar (Esc)' }, h('span.circle', icon('close', 18)), h('span.esc', 'ESC')))
  )
  render()
  const off = bus.on('status', () => { if (tab === 'about' && el.isConnected) render() })
  el.addEventListener('dismiss', off)
}
