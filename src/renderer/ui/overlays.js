// Ventanas flotantes: avisos, visor de imágenes, selector de pantalla, confirmaciones,
// menú de volumen por usuario y Ajustes.
import { h, $, store, avatar } from '../util.js'
import { icon } from '../icons.js'
import { state, bus } from '../state.js'

// ───────────── Avisos ─────────────
export function toast(text, kind = 'info', ms = 5000) {
  let box = $('#toasts')
  if (!box) { box = h('div#toasts'); document.body.append(box) }
  const el = h('div.toast.' + kind, text)
  box.append(el)
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250) }, ms)
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

// ───────────── Compartir pantalla: qué y con qué calidad ─────────────
const SHARE_PRESETS = [['fluid', 'Fluidez', '1080p · 60 fps · para juegos y vídeo'], ['sharp', 'Nitidez', '1080p · 30 fps · para texto y código']]

/** @returns {Promise<{id: string|null, preset: string}|null>}  id null = elegirá el portal del sistema (Wayland). */
export async function openShareDialog({ needSource }) {
  let sources = []
  if (needSource) {
    toast('Buscando pantallas y ventanas…')
    try { sources = await window.humble.listScreens() } catch {}
    if (!sources.length) { toast('No se encontró ninguna pantalla para compartir.', 'warn'); return null }
  }
  return new Promise((resolve) => {
    const { el, close } = layer('modal-bg')
    let done = false
    let preset = store('preset') || 'fluid'
    const finish = (v) => { if (done) return; done = true; close(); resolve(v) }
    el.addEventListener('dismiss', () => finish(null))
    el.addEventListener('mousedown', (e) => { if (e.target === el) finish(null) })

    const seg = h('div.seg')
    const drawSeg = () => seg.replaceChildren(...SHARE_PRESETS.map(([id, label, detail]) =>
      h('button.seg-item' + (id === preset ? '.active' : ''), { onclick: () => { preset = id; store('preset', id); drawSeg() } },
        h('b', label), h('small', detail))))
    drawSeg()

    const nice = (n) => n.replace(/^Entire screen$/i, 'Pantalla completa').replace(/^Screen (\d+)$/i, 'Pantalla $1')
    let audio = false
    const audioRow = state.platform === 'win32'
      ? h('label.chk', h('input', { type: 'checkbox', onchange: (e) => { audio = e.target.checked } }), h('span', 'Compartir también el audio del sistema ', h('small', '(experimental: usa auriculares para evitar eco)')))
      : null
    const card = (s) => h('button.src-card', { onclick: () => finish({ id: s.id, preset, audio }) }, h('img', { src: s.thumb, alt: '' }), h('span', nice(s.name)))
    el.append(h('div.modal.wide',
      h('div.modal-body',
        h('h2', 'Compartir pantalla'),
        h('h3', 'Calidad'), seg, audioRow,
        needSource
          ? [h('h3', 'Pantallas'), h('div.src-grid', ...sources.filter((s) => s.screen).map(card)),
             sources.some((s) => !s.screen) && h('h3', 'Ventanas'),
             h('div.src-grid', ...sources.filter((s) => !s.screen).map(card))]
          : h('p.muted', 'Después, el sistema te preguntará qué pantalla o ventana quieres compartir.')),
      h('div.modal-foot',
        h('button.btn.link', { onclick: () => finish(null) }, 'Cancelar'),
        !needSource && h('button.btn.brand', { onclick: () => finish({ id: null, preset, audio: false }) }, 'Continuar'))))
  })
}

// ───────────── Menú contextual (clic derecho) ─────────────
/** items: [{ label, icon?, danger?, onclick }] o 'sep' */
export function openContextMenu(x, y, items) {
  document.querySelector('.ctxmenu')?.remove()
  const menu = h('div.ctxmenu')
  for (const it of items.filter(Boolean)) {
    if (it === 'sep') { menu.append(h('div.ctx-sep')); continue }
    menu.append(h('button.ctx-item' + (it.danger ? '.danger' : ''), { onclick: () => { close(); it.onclick() } }, h('span', it.label), it.icon && icon(it.icon, 18)))
  }
  document.body.append(menu)
  menu.style.left = Math.max(6, Math.min(x, innerWidth - menu.offsetWidth - 6)) + 'px'
  menu.style.top = Math.max(6, Math.min(y, innerHeight - menu.offsetHeight - 6)) + 'px'
  const close = () => { menu.remove(); removeEventListener('mousedown', off, true); removeEventListener('keydown', onKey, true); removeEventListener('blur', close) }
  const off = (e) => { if (!menu.contains(e.target)) close() }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  setTimeout(() => { addEventListener('mousedown', off, true); addEventListener('keydown', onKey, true); addEventListener('blur', close) })
  return close
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

// ───────────── Invitar a un amigo ─────────────
export async function openInvite() {
  const { el, close } = layer('modal-bg')
  const d = await window.humble.diag().catch(() => ({ version: '' }))
  const info = await window.humble.roomInfo().catch(() => ({ code: '' }))
  el.addEventListener('mousedown', (e) => { if (e.target === el) close() })
  const step = (n, title, text) => h('div.step', h('div.step-n', String(n)), h('div', h('b', title), h('p', text)))
  el.append(h('div.modal',
    h('div.modal-body', h('h2', 'Invitar a un amigo'),
      h('p.muted', 'No hay cuentas ni enlaces: tu amigo solo necesita la misma aplicación que tú.'),
      step(1, 'Pásale la aplicación', 'El instalador o archivo que compilaste (ya trae la sala), o el de la página de descargas del proyecto.'),
      step(2, 'Si no trae la sala, pásale el código', 'Al abrirla por primera vez te pide el código de sala: que lo pegue y listo.'),
      h('div.code-box', h('code', info.code || '—'), h('button.btn.secondary.small', { onclick: () => navigator.clipboard.writeText(info.code).then(() => toast('Código de sala copiado', 'ok')) }, 'Copiar')),
      step(3, 'Misma versión para todos', `Estás usando la ${d.version ? 'versión ' + d.version : 'versión actual'}. Si alguien no te ve, mira la barra lateral: avisa si es una versión distinta.`)),
    h('div.modal-foot', h('button.btn.brand', { onclick: close }, 'Entendido'))))
}

// ───────────── Ajustes ─────────────
async function buildReport(voice) {
  const line = (k, v) => `${k.padEnd(22)} ${v}`
  const d = await window.humble.diag()
  const out = [
    'HumbleChat ' + d.version + ' · ' + d.platform + ' ' + d.arch + ' · Electron ' + d.electron,
    line('Red P2P', { online: 'conectada', connecting: 'buscando…', offline: 'sin Internet' }[d.status.state] || d.status.state),
    line('Servicios de red', d.network),
    ...(state.nat ? [line('Tipo de red (NAT)', { cone: 'cono (bueno)', symmetric: 'simétrico (problemático)', unknown: 'desconocido', blocked: 'UDP bloqueado' }[state.nat.type]), '                       ' + state.nat.text] : []),
    ...(d.status.mismatch ? [line('¡Atención!', 'un amigo tiene OTRA VERSIÓN de la app y no puede conectarse')] : []),
    line('Amigos conectados', d.peers.length + (d.peers.length ? '  (' + d.peers.map((p) => p.name + ' ' + p.link).join(', ') + ')' : '')),
    ''
  ]
  const calls = state.voice ? await voice.diagnostics() : []
  out.push(line('Llamada', state.voice ? state.channels.find((c) => c.id === state.voice.ch)?.name : 'no estás en una llamada'))
  const f = (x) => (x === null || x === undefined ? '—' : x)
  for (const c of calls) {
    const name = state.byId.get(c.id)?.name || c.id.slice(0, 6)
    const st = { connected: 'conectado', connecting: 'conectando', new: 'iniciando', disconnected: 'desconectado', failed: 'FALLIDO', closed: 'cerrado' }[c.state] || c.state
    out.push('', `· ${name}: ${st}, ${c.path}, ping ${f(c.rtt)} ms`)
    if (c.audioOut) out.push(`    audio ↑ ${f(c.audioOut.codec)} ${f(c.audioOut.kbps)} kbps`)
    if (c.audioIn) out.push(`    audio ↓ ${f(c.audioIn.kbps)} kbps · jitter ${f(c.audioIn.jitter)} ms · pérdida ${f(c.audioIn.lostPct)} %`)
    for (const [k, arrow] of [['videoOut', '↑'], ['videoIn', '↓']]) {
      const v = c[k]
      if (v) out.push(`    vídeo ${arrow} ${f(v.codec)} ${v.w ? v.w + 'x' + v.h : ''} ${f(v.fps)} fps ${f(v.kbps)} kbps${v.limit ? ' · limitado por ' + v.limit : ''}`)
    }
  }
  return out.join('\n')
}

export function openSettings(voice, startTab = 'account') {
  const { el, close } = layer('settings')
  let tab = startTab
  let meterStop = null
  const closeAll = () => { close(); el.dispatchEvent(new Event('dismiss')) }
  el.addEventListener('dismiss', () => meterStop?.())

  const nav = h('nav')
  const content = h('div.st-content')
  const tabs = [['account', 'Mi cuenta'], ['room', 'Sala'], ['voice', 'Voz y vídeo'], ['notif', 'Notificaciones'], ['app', 'Aplicación'], ['diag', 'Diagnóstico'], ['about', 'Acerca de']]

  function render() {
    meterStop?.(); meterStop = null
    nav.replaceChildren(
      h('div.st-title', 'Ajustes de usuario'),
      ...tabs.map(([id, label]) => h('button.st-item' + (id === tab ? '.active' : ''), { onclick: () => { tab = id; render() } }, label))
    )
    content.replaceChildren(({ account, room, voice: voiceTab, notif, app: appTab, diag, about })[tab]())
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
    const camSel = h('select')
    const bar = h('div.meter-fill')
    const preview = h('video.cam-preview', { autoplay: true, muted: true, playsinline: true })
    const none = h('div.cam-none', icon('cameraOff', 32), h('span', 'Sin cámara'))
    const camBox = h('div.cam-box', preview, none)
    let alive = true
    let camStream = null
    let meterOff = null

    const fill = (sel, devs, cur, label) => {
      sel.replaceChildren(h('option', { value: '' }, label), ...devs.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || 'Dispositivo ' + (i + 1))))
    }
    const real = (d) => d.deviceId !== 'default' && d.deviceId !== 'communications'

    async function refresh() {
      let probe = null
      try { probe = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch {}
      const devs = await navigator.mediaDevices.enumerateDevices()
      probe?.getTracks().forEach((t) => t.stop())
      if (!alive) return
      const ins = devs.filter((d) => d.kind === 'audioinput' && real(d))
      const outs = devs.filter((d) => d.kind === 'audiooutput' && real(d))
      const cams = devs.filter((d) => d.kind === 'videoinput')
      fill(inSel, ins, state.prefs.input, ins.length ? 'Predeterminado del sistema' : 'No se detecta ningún micrófono')
      fill(outSel, outs, state.prefs.output, 'Predeterminado del sistema')
      fill(camSel, cams, state.prefs.camera, cams.length ? 'Predeterminada del sistema' : 'No se detecta ninguna cámara')
    }

    async function startMeter() {
      let stream, ctx, timer
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: state.prefs.input ? { deviceId: { exact: state.prefs.input } } : true })
      } catch { return }
      if (!alive) return stream.getTracks().forEach((t) => t.stop())
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
      meterOff = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); ctx.close(); meterOff = null }
    }

    async function startPreview() {
      camStream?.getTracks().forEach((t) => t.stop())
      camStream = null
      preview.srcObject = null
      camBox.classList.remove('on')
      try {
        camStream = await navigator.mediaDevices.getUserMedia({ video: state.prefs.camera ? { deviceId: { exact: state.prefs.camera } } : true })
        if (!alive) return camStream.getTracks().forEach((t) => t.stop())
        preview.srcObject = camStream
        camBox.classList.add('on')
      } catch { /* sin cámara o sin permiso: se queda "Sin cámara" */ }
    }

    const prevStop = meterStop
    meterStop = () => { alive = false; meterOff?.(); camStream?.getTracks().forEach((t) => t.stop()); navigator.mediaDevices.removeEventListener('devicechange', onChange); prevStop?.() }
    const onChange = async () => { await refresh(); startPreview() }
    navigator.mediaDevices.addEventListener('devicechange', onChange)

    inSel.addEventListener('change', async () => {
      state.prefs.input = inSel.value; store('input', inSel.value)
      meterOff?.(); await startMeter(); await voice.applyDevices()
    })
    outSel.addEventListener('change', () => { state.prefs.output = outSel.value; store('output', outSel.value); voice.applyDevices() })
    camSel.addEventListener('change', async () => { state.prefs.camera = camSel.value; store('camera', camSel.value); await startPreview(); voice.applyCamera() })

    refresh().then(() => { startMeter(); startPreview() })

    // Supresión de ruido, umbral de sensibilidad y pulsar para hablar
    const denoiseSel = h('select',
      h('option', { value: 'standard', selected: state.prefs.denoise === 'standard' }, 'Estándar (recomendada)'),
      h('option', { value: 'advanced', selected: state.prefs.denoise === 'advanced' }, 'Avanzada: estándar + RNNoise (ventiladores, teclados)'),
      h('option', { value: 'off', selected: state.prefs.denoise === 'off' }, 'Ninguna'))
    denoiseSel.addEventListener('change', async () => {
      state.prefs.denoise = denoiseSel.value; store('denoise', denoiseSel.value)
      meterOff?.(); await voice.applyDevices(); startMeter()
    })

    const mark = h('div.meter-mark')
    const hint = h('div.level-hint')
    const place = () => { mark.style.display = state.prefs.gate.on ? 'block' : 'none'; mark.style.left = Math.min(100, state.prefs.gate.level * 400) + '%' }
    const slider = h('input.slider', { type: 'range', min: 5, max: 100, value: Math.round(state.prefs.gate.level * 500), oninput: () => {
      state.prefs.gate.level = slider.value / 500; store('gate', state.prefs.gate); place()
    } })
    const gateSw = h('button.switch' + (state.prefs.gate.on ? '.on' : ''), { role: 'switch', onclick: () => {
      state.prefs.gate.on = !state.prefs.gate.on; store('gate', state.prefs.gate)
      gateSw.classList.toggle('on', state.prefs.gate.on); place()
    } }, h('span.knob'))
    place()

    const pttBtn = h('button.btn.secondary.small.ptt-key')
    const showPtt = () => { const k = state.prefs.ptt.key; pttBtn.textContent = k ? k.label : 'Elegir tecla'; pttBtn.classList.remove('rec') }
    const pttSw = h('button.switch' + (state.prefs.ptt.on ? '.on' : ''), { role: 'switch', onclick: () => {
      if (!state.prefs.ptt.on && !state.prefs.ptt.key) return toast('Elige primero una tecla.')
      state.prefs.ptt.on = !state.prefs.ptt.on; store('ptt', state.prefs.ptt)
      pttSw.classList.toggle('on', state.prefs.ptt.on)
      window.humble.pttConfigure({ on: state.prefs.ptt.on, hook: state.prefs.ptt.key?.hook }).then((ok) => {
        if (state.prefs.ptt.on && !ok) toast('Sin captura global del teclado (p. ej. Wayland): la tecla solo funciona con la ventana enfocada.', 'warn', 9000)
      })
    } }, h('span.knob'))
    pttBtn.addEventListener('click', async () => {
      pttBtn.textContent = 'Pulsa una tecla…'; pttBtn.classList.add('rec')
      let done = false
      const onKey = (e) => { // con la ventana enfocada también se puede asignar la tecla directamente
        if (done) return
        e.preventDefault(); e.stopPropagation(); done = true
        removeEventListener('keydown', onKey, true)
        const prev = state.prefs.ptt.key
        state.prefs.ptt.key = { code: e.code, hook: prev?.hook ?? null, label: e.code.replace(/^Key/, '').replace(/^Digit/, '') }
        store('ptt', state.prefs.ptt); showPtt()
      }
      addEventListener('keydown', onKey, true)
      const r = await window.humble.pttRecord().catch(() => null) // la tecla global (funciona fuera de la ventana)
      removeEventListener('keydown', onKey, true)
      if (r) state.prefs.ptt.key = { code: state.prefs.ptt.key?.code || null, hook: r.hook, label: r.label }
      store('ptt', state.prefs.ptt); showPtt()
      if (state.prefs.ptt.on) window.humble.pttConfigure({ on: true, hook: state.prefs.ptt.key?.hook })
    })
    showPtt()

    // Aviso de nivel del micrófono (bajo, correcto, saturado) a partir de los picos de los últimos segundos
    let peak = 0
    let hintAt = 0
    const levelLoop = setInterval(() => {
      const l = voice.micLevel()
      peak = Math.max(peak * 0.995, l)
      if (performance.now() - hintAt < 700) return
      hintAt = performance.now()
      if (!meterOff) return hint.replaceChildren()
      const [msg, warn] = peak < 0.015 ? ['No se oye nada: habla un poco o comprueba que el micrófono no esté silenciado.', true]
        : peak < 0.06 ? ['Se oye muy bajo: acércate al micrófono o sube su volumen en el sistema.', true]
        : peak > 0.6 ? ['Está saturando: baja el volumen del micrófono en el sistema.', true]
        : ['Nivel correcto.', false]
      hint.textContent = msg
      hint.classList.toggle('warn', warn)
    }, 100)
    const prevStop2 = meterStop
    meterStop = () => { clearInterval(levelLoop); prevStop2?.() }

    return h('div',
      h('h2', 'Voz y vídeo'),
      h('p.muted', 'Todo viene configurado: se usan los dispositivos predeterminados del sistema y, si conectas o desconectas unos auriculares, la app se adapta sola.'),
      h('label.field', 'Dispositivo de entrada (micrófono)', inSel),
      h('label.field', 'Dispositivo de salida (altavoces o auriculares)', outSel),
      h('div.field', h('div.label', 'Prueba de micrófono'), h('div.meter', bar, mark), hint),
      h('label.field', 'Supresión de ruido', denoiseSel),
      h('div.sw-row', h('div', h('div.sw-label', 'Umbral de sensibilidad'), h('div.muted', 'Solo se transmite cuando hablas por encima de la marca blanca. Útil si tu micrófono capta ruido de fondo.'), slider), gateSw),
      h('div.sw-row', h('div', h('div.sw-label', 'Pulsar para hablar'), h('div.muted', 'El micrófono solo transmite mientras mantienes la tecla elegida, aunque la app esté en segundo plano (no en Wayland).')),
        h('div.row', pttBtn, pttSw)),
      h('label.field', 'Cámara', camSel),
      camBox,
      h('p.muted', 'Cancelación de eco y control automático de ganancia: activados.'))
  }

  function notif() {
    const sw = (label, help, key, storeKey) => {
      const btn = h('button.switch' + (state.notify[key] ? '.on' : ''), { role: 'switch', 'aria-checked': String(state.notify[key]), onclick: () => {
        state.notify[key] = !state.notify[key]
        store(storeKey, state.notify[key])
        btn.classList.toggle('on', state.notify[key])
        btn.setAttribute('aria-checked', String(state.notify[key]))
      } }, h('span.knob'))
      return h('div.sw-row', h('div', h('div.sw-label', label), h('div.muted', help)), btn)
    }
    return h('div', h('h2', 'Notificaciones'),
      sw('Avisos de escritorio', 'Un aviso del sistema cuando alguien escribe y no estás mirando la app.', 'desktop', 'notifyDesktop'),
      sw('Sonidos de mensajes', 'Un sonido suave al recibir menciones o mensajes con la app en segundo plano.', 'sounds', 'notifySounds'),
      h('p.muted', 'Las menciones (@tu nombre) siempre te marcan el canal en rojo.'))
  }

  function diag() {
    const box = h('pre.diag', 'Recopilando…')
    const copy = h('button.btn.brand', {
      onclick: () => navigator.clipboard.writeText(box.textContent).then(() => toast('Informe copiado', 'ok'), () => toast('No se pudo copiar', 'warn'))
    }, 'Copiar informe')
    const nat = h('button.btn.secondary', { onclick: async () => { nat.disabled = true; nat.textContent = 'Comprobando…'; state.nat = await window.humble.natCheck().catch(() => null); nat.disabled = false; nat.textContent = 'Comprobar mi red' } }, 'Comprobar mi red')
    let timer = null
    const refresh = async () => {
      if (!box.isConnected) return clearInterval(timer)
      try { box.textContent = await buildReport(voice) } catch (e) { box.textContent = 'No se pudo generar el informe: ' + e.message }
    }
    timer = setInterval(refresh, 2000)
    const prevStop = meterStop
    meterStop = () => { clearInterval(timer); prevStop?.() }
    setTimeout(refresh, 50) // tras insertar el panel en el DOM
    return h('div', h('h2', 'Diagnóstico'),
      h('p.muted', 'Estado de la red y de las llamadas, útil para saber por qué algo no va bien. No incluye IPs ni mensajes.'),
      box, h('div.row', copy, nat))
  }

  // ── Sala: huella, código, cambiar de sala ──
  function room() {
    const box = h('div')
    ;(async () => {
      const info = await window.humble.roomInfo()
      let shown = false
      const code = h('code', '•'.repeat(32))
      const toggle = h('button.btn.secondary.small', { onclick: () => { shown = !shown; code.textContent = shown ? info.code : '•'.repeat(32); toggle.textContent = shown ? 'Ocultar' : 'Mostrar' } }, 'Mostrar')
      const copy = h('button.btn.brand.small', { onclick: () => navigator.clipboard.writeText(info.code).then(() => toast('Código de sala copiado', 'ok')) }, 'Copiar')
      const input = h('input.text', { placeholder: 'Pega aquí otro código de sala', spellcheck: false })
      const join = h('button.btn.brand', { onclick: () => changeRoom(input.value) }, 'Cambiar')
      const locked = info.envKey ? h('p.muted', 'La sala está fijada por la variable HUMBLECHAT_KEY y no se puede cambiar desde aquí.') : null
      box.replaceChildren(
        h('h2', 'Sala'),
        h('p.muted', 'La sala es el grupo de amigos al que te conectas. Quien tenga el código puede entrar.'),
        h('div.field', h('div.label', 'Huella de la sala'), h('div.fp', info.fingerprint), h('p.muted', 'Si tus amigos ven la misma huella, estáis en la misma sala.')),
        h('div.field', h('div.label', 'Código de sala'), h('div.code-box', code, toggle, copy), h('p.muted', 'Pásaselo solo a quien quieras que entre.')),
        locked,
        !info.envKey && h('label.field', 'Cambiar de sala', h('div.row', input, join)),
        !info.envKey && h('div.field', h('button.btn.secondary', { onclick: createRoom }, 'Crear una sala nueva'),
          h('p.muted', 'Útil si un amigo ya no debe entrar: con una sala nueva solo entran quienes reciban el código nuevo. Tu historial se conserva en este equipo.')))
    })()
    async function changeRoom(text) {
      if (!text.trim()) return
      const ok = await confirmModal({ title: 'Cambiar de sala', body: h('p', 'Dejarás de ver esta sala hasta que vuelvas a introducir su código. Tu historial se conserva en este equipo.'), confirm: 'Cambiar' })
      if (!ok) return
      try { await window.humble.roomJoin(text) } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'warn', 8000) }
    }
    async function createRoom() {
      const ok = await confirmModal({ title: 'Crear una sala nueva', body: h('p', 'Se genera un código nuevo. Tus amigos tendrán que introducirlo para entrar; quien tenga el código antiguo se quedará fuera.'), confirm: 'Crear' })
      if (!ok) return
      const code = await window.humble.roomCreate()
      const { el, close } = layer('modal-bg')
      el.append(h('div.modal',
        h('div.modal-body', h('h2', 'Tu sala nueva'), h('p.muted', 'Copia este código y pásaselo a tus amigos. Después pulsa «Entrar a la sala nueva».'),
          h('div.code-box', h('code', code), h('button.btn.secondary.small', { onclick: () => navigator.clipboard.writeText(code).then(() => toast('Código copiado', 'ok')) }, 'Copiar'))),
        h('div.modal-foot', h('button.btn.link', { onclick: close }, 'Cancelar'),
          h('button.btn.green', { onclick: () => window.humble.roomJoin(code).catch(() => toast('No se pudo cambiar de sala.', 'warn')) }, 'Entrar a la sala nueva'))))
    }
    return box
  }

  // ── Aplicación: bandeja, inicio, actualizaciones ──
  function appTab() {
    const sw = (label, help, key) => {
      const on = () => state.settings[key]
      const btn = h('button.switch' + (on() ? '.on' : ''), { role: 'switch', 'aria-checked': String(on()), onclick: async () => {
        state.settings = await window.humble.setSettings({ [key]: !on() })
        btn.classList.toggle('on', !!on())
        btn.setAttribute('aria-checked', String(on()))
      } }, h('span.knob'))
      return h('div.sw-row', h('div', h('div.sw-label', label), h('div.muted', help)), btn)
    }
    return h('div', h('h2', 'Aplicación'),
      sw('Seguir en la bandeja al cerrar la ventana', 'La aplicación (y tu llamada) sigue abierta; se sale desde el icono de la bandeja. Solo si tu escritorio tiene bandeja.', 'tray'),
      sw('Iniciar con el sistema', 'Se abre sola al encender el ordenador, en segundo plano.', 'autostart'),
      sw('Buscar actualizaciones', 'Avisa o instala las versiones nuevas. Solo consulta las publicaciones públicas del proyecto.', 'updates'),
      sw('Vistas previas de enlaces', 'Al enviar un enlace, se añade su título e imagen para todos. Tu equipo visita la página una vez.', 'linkPreviews'),
      h('div.sw-row', h('div', h('div.sw-label', 'Versión ' + state.version), h('div.muted', 'Comprueba si hay una versión nueva ahora mismo.')),
        h('button.btn.secondary.small', { onclick: () => { window.humble.updateCheck(); toast('Buscando actualizaciones…') } }, 'Buscar ahora')))
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
