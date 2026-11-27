'use strict';
// Reproductor de «Escuchar juntos». Vive en una ventana oculta y aislada (ver musicplayer.js): solo habla con la aplicación
// por `playerBridge` (órdenes: cargar, reproducir, pausar, buscar, volumen, parar; eventos: estado y posición).
(() => {
  const bridge = window.playerBridge
  const fake = new URLSearchParams(location.search).has('fake') // pruebas: un YT simulado en vez del de YouTube
  const STATES = { '-1': 'loading', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'paused' }
  const API_TIMEOUT_MS = 20000

  let player = null
  let ready = false
  let cur = { n: null, v: null } // pista cargada
  let err = null // código del último error de la pista cargada
  let audio = { vol: 60, mute: false }
  // Entre mandar cargar una pista y el primer cambio de estado del reproductor, éste aún cuenta lo de la pista anterior: se oculta.
  let loading = false
  let loadSeq = 0

  const apiReady = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tiempo agotado')), API_TIMEOUT_MS)
    window.onYouTubeIframeAPIReady = () => { clearTimeout(t); resolve() }
    const s = document.createElement('script')
    s.src = fake ? 'fake-yt.js' : 'https://www.youtube.com/iframe_api'
    s.onerror = () => { clearTimeout(t); reject(new Error('no se pudo cargar')) }
    document.head.append(s)
  })
  apiReady.catch(() => {})

  function snapshot() {
    let st = 'none'
    let pos = 0
    let dur = 0
    if (cur.n) {
      st = err !== null ? 'error' : 'loading'
      if (ready && err === null && !loading) {
        try { st = STATES[player.getPlayerState()] || 'loading' } catch {}
      }
      if (ready && !loading) {
        try { pos = Number(player.getCurrentTime()) || 0; dur = Number(player.getDuration()) || 0 } catch {}
      }
    }
    return { n: cur.n, st, pos, dur }
  }

  const emit = (e, extra = {}) => bridge.emit({ e, ...snapshot(), ...extra })

  function applyAudio() {
    if (!ready) return
    try {
      player.setVolume(audio.vol)
      if (audio.mute) player.mute(); else player.unMute()
    } catch {}
  }

  function fail(code) {
    err = code
    emit('error', { code })
  }

  async function create(c) {
    await apiReady
    await new Promise((resolve) => {
      player = new window.YT.Player('p', {
        host: 'https://www.youtube-nocookie.com',
        width: 320,
        height: 180,
        videoId: c.v,
        playerVars: {
          autoplay: c.play ? 1 : 0, start: Math.floor(c.pos), controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, rel: 0,
          playsinline: 1, enablejsapi: 1, origin: location.origin
        },
        events: {
          onReady: () => { ready = true; applyAudio(); resolve(); emit('state') },
          onStateChange: () => { loading = false; emit('state') },
          onError: (ev) => { loading = false; fail(Number(ev.data)) }
        }
      })
    })
  }

  async function load(c) {
    cur = { n: c.n, v: c.v }
    err = null
    loading = true
    const seq = ++loadSeq
    setTimeout(() => { if (loading && seq === loadSeq) loading = false }, 5000) // por si el reproductor no cambia de estado
    emit('state') // ya con la pista nueva y «cargando»: la aplicación no tiene que adivinarlo
    try {
      if (!player) await create(c)
      else if (c.play) player.loadVideoById({ videoId: c.v, startSeconds: c.pos })
      else player.cueVideoById({ videoId: c.v, startSeconds: c.pos })
    } catch { fail(-2) } // el reproductor de YouTube no llegó a cargarse (sin conexión, bloqueado…)
  }

  async function handle(c) {
    switch (c.op) {
      case 'load': return load(c)
      case 'play': return ready && player.playVideo()
      case 'pause': return ready && player.pauseVideo()
      case 'seek': return ready && player.seekTo(c.pos, true)
      case 'volume': audio = { vol: c.vol, mute: c.mute }; return applyAudio()
      case 'stop':
        cur = { n: null, v: null }
        err = null
        loading = false
        if (ready) player.stopVideo()
        return emit('state')
    }
  }

  // Las órdenes se ejecutan de una en una y en el orden en que llegan (cargar puede tardar).
  let chain = Promise.resolve()
  bridge.onCmd((c) => { chain = chain.then(() => handle(c)).catch((e) => console.warn('reproductor', c?.op, e)) })

  setInterval(() => { if (cur.n) emit('tick') }, 1000)

  if (fake) window.__player = { snapshot: () => ({ ...snapshot(), ...audio }), nudge: (s) => window.YT.__nudge(s) }
})()
