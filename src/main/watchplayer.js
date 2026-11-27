'use strict';
// Motor de «Escuchar juntos» que reproduce desde la PÁGINA NORMAL de YouTube (youtube.com/watch) en una ventana oculta y aislada.
//
// Frente al reproductor incrustado: no depende de que el dueño permita incrustar (muchos vídeos musicales no lo permiten), no exige
// referer y funciona también desde IPs de centro de datos. Los anuncios se quitan en origen (watch-preload.js). El reproductor de la
// página (`#movie_player`) ofrece la misma API que el incrustado: se controla con executeJavaScript desde aquí.
//
// Mismo contrato que el otro motor: recibe órdenes saneadas (`load`, `play`, `pause`, `seek`, `volume`, `stop`) y cuenta
// eventos `{e: 'state'|'tick'|'error', n, st, pos, dur, vid, ad}`. Un error con código -3 significa «esta página no sirve»
// (YouTube pide comprobar que no eres un robot, no cargó la API…): quien lo use puede pasar al otro motor.
const path = require('path');
const { BrowserWindow } = require('electron');

const STATES = { '-1': 'loading', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'paused' };
const API_TIMEOUT_MS = 25000;
const POLL_MS = 1000;

/** Se evalúa dentro de la página: estado del reproductor, anuncio, error visible y comprobación anti-robots. */
const PROBE = `(() => {
  const p = document.getElementById('movie_player');
  if (!p || !p.getPlayerState) return JSON.stringify({ api: false, bot: /confirm you.re not a bot|confirmar que no eres un robot/i.test((document.body && document.body.innerText || '').slice(0, 3000)) });
  const e = p.querySelector('.ytp-error');
  const shown = !!e && getComputedStyle(e).display !== 'none';
  const vd = p.getVideoData ? p.getVideoData() : {};
  return JSON.stringify({
    api: true, st: p.getPlayerState(), t: p.getCurrentTime(), d: p.getDuration(), vid: vd && vd.video_id || null,
    ad: p.classList.contains('ad-showing'),
    err: shown ? ((e.querySelector('.ytp-error-content-wrap-reason') || e).innerText || '').slice(0, 160) : ''
  });
})()`;

const call = (js) => `(() => { const p = document.getElementById('movie_player'); return p && p.getPlayerState ? (${js}) : null; })()`;

/** Código de error al estilo del reproductor incrustado según el texto que enseña YouTube. */
const errorCode = (text) => (/sign in|inicia sesi|age|edad|confirm/i.test(text) ? 101 : 100);

/**
 * @param {object} o
 * @param {Electron.Session} o.session sesión aislada de la música (con las cookies de consentimiento)
 * @param {(evt: object) => void} o.onEvent
 */
function createWatchEngine({ session, onEvent }) {
  let win = null;
  let cur = { n: null, v: null };
  let err = null;
  let loadedAt = 0; // cuándo se pidió la pista actual
  let pending = null; // valor de `play` que se pidió al cargar la página (para pausar en cuanto haya reproductor)
  let timer = null;
  let polling = false;
  let last = '';
  let audio = { vol: 60, mute: false };
  let qualitySet = null;
  let staleSince = 0;
  let autonavOff = false;

  const alive = () => win && !win.isDestroyed();
  const exec = (js) => (alive() ? win.webContents.executeJavaScript(js, true).catch(() => null) : Promise.resolve(null));
  const watchUrl = (v, pos) => `https://www.youtube.com/watch?v=${v}${pos >= 1 ? `&t=${Math.floor(pos)}s` : ''}`;

  function emit(kind, extra) {
    onEvent({ e: kind, n: cur.n, st: 'none', pos: 0, dur: 0, vid: null, ...extra });
  }

  function fail(code) {
    if (err !== null) return;
    err = code;
    emit('error', { st: 'error', code });
  }

  async function sample() {
    if (polling || !alive() || !cur.n) return;
    polling = true;
    try {
      const raw = await exec(PROBE);
      if (!raw || !cur.n) return;
      const s = JSON.parse(raw);
      if (err !== null) return;
      if (!s.api) {
        if (s.bot) return fail(-3);
        if (Date.now() - loadedAt > API_TIMEOUT_MS) return fail(-3);
        return;
      }
      if (s.err) return fail(errorCode(s.err));
      // Aún suena (o carga) el vídeo anterior, o YouTube se fue solo a otro (reproducción automática del siguiente): no se cuenta
      // nada de él y, si se alarga, se vuelve a pedir el nuestro
      const stale = s.vid && cur.v && s.vid !== cur.v && !s.ad;
      if (!stale) staleSince = 0;
      else if (!staleSince) staleSince = Date.now();
      else if (Date.now() - staleSince > 12000) {
        staleSince = Date.now();
        exec(call(`p.loadVideoById({ videoId: ${JSON.stringify(cur.v)}, startSeconds: 0 })`));
      }
      if (!autonavOff) { // sin reproducción automática: la lista de la llamada manda, no las recomendaciones de YouTube
        autonavOff = true;
        exec(`(() => { const b = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]'); if (b) b.click(); return !!b; })()`);
      }
      let st = stale ? 'loading' : s.ad ? 'buffering' : STATES[s.st] || 'loading';
      if (pending !== null && !stale && (st === 'playing' || st === 'buffering') && !s.ad) { // «cargar sin reproducir»: se pausa en cuanto hay reproductor
        if (pending === false) { exec(call('p.pauseVideo()')); st = 'paused'; }
        pending = null;
        wc().setAudioMuted(audio.mute);
      }
      if (st === 'playing' && qualitySet !== cur.n) { // solo audio: la imagen más pequeña, para gastar lo mínimo
        qualitySet = cur.n;
        exec(call("p.setPlaybackQualityRange && p.setPlaybackQualityRange('tiny', 'tiny')"));
        exec(call(`p.setVolume(${audio.vol})`));
      }
      if (st === 'ended') exec(call('p.pauseVideo()')); // que no se vaya a otro vídeo mientras la aplicación decide cuál toca
      const evt = { st, pos: stale ? 0 : Number(s.t) || 0, dur: stale ? 0 : Number(s.d) || 0, vid: stale ? null : s.vid || null, ad: !!s.ad };
      const key = `${cur.n}|${st}|${evt.ad}`;
      emit(key !== last ? 'state' : 'tick', evt);
      last = key;
    } finally { polling = false; }
  }

  const wc = () => win.webContents;

  function open() {
    if (alive()) return;
    win = new BrowserWindow({
      show: false, width: 1000, height: 700, skipTaskbar: true, focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'watch-preload.js'),
        session,
        // El preload tiene que correr en el mismo mundo que los scripts de YouTube para podar sus respuestas; la ventana no tiene
        // ningún puente con la aplicación ni acceso a Node, y solo carga youtube.com.
        contextIsolation: false, sandbox: true, nodeIntegration: false, spellcheck: false,
        backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
      }
    });
    const w = win;
    w.webContents.setUserAgent(w.webContents.getUserAgent().replace(/\s(?:Electron|humblechat)\/\S+/gi, ''));
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e, url) => { if (!/^https:\/\/([\w-]+\.)?(youtube|google)\.com\//.test(url)) e.preventDefault(); });
    w.webContents.on('render-process-gone', () => { if (win === w) win = null; });
    w.on('closed', () => { if (win === w) win = null; });
    w.webContents.setAudioMuted(audio.mute);
    clearInterval(timer);
    timer = setInterval(() => sample().catch(() => {}), POLL_MS);
    timer.unref?.();
  }

  async function load(c) {
    cur = { n: c.n, v: c.v };
    err = null;
    last = '';
    qualitySet = null;
    loadedAt = Date.now();
    staleSince = 0;
    emit('state', { st: 'loading' });
    if (alive()) wc().setAudioMuted(audio.mute); // tras un «parar» la ventana quedó muda
    if (!alive()) {
      open();
      pending = c.play;
      wc().setAudioMuted(c.play ? audio.mute : true); // si va a empezar en pausa, nada se oye hasta que se pause
      win.loadURL(watchUrl(c.v, c.pos), { httpReferrer: 'https://www.youtube.com/' }).catch((e) => { if (cur.n === c.n) { console.warn('[musica] no se pudo cargar youtube.com:', e?.message || e); fail(-3); } });
      return;
    }
    const arg = `{ videoId: ${JSON.stringify(c.v)}, startSeconds: ${Math.floor(c.pos)} }`;
    const ok = await exec(call(c.play ? `(p.loadVideoById(${arg}), true)` : `(p.cueVideoById(${arg}), true)`));
    if (!ok) { // la página aún no está lista o se perdió: se vuelve a cargar entera
      win.loadURL(watchUrl(c.v, c.pos), { httpReferrer: 'https://www.youtube.com/' }).catch(() => fail(-3));
      pending = c.play;
    }
  }

  async function run(c) {
    switch (c.op) {
      case 'load': return load(c);
      case 'play': return void (await exec(call('p.playVideo()')));
      case 'pause': return void (await exec(call('p.pauseVideo()')));
      case 'seek': return void (await exec(call(`p.seekTo(${c.pos}, true)`)));
      case 'volume':
        audio = { vol: c.vol, mute: c.mute };
        if (alive() && pending === null) wc().setAudioMuted(c.mute);
        return void (await exec(call(`p.setVolume(${c.vol})`)));
      case 'stop':
        cur = { n: null, v: null };
        err = null;
        pending = null;
        await exec(call('p.stopVideo()'));
        if (alive()) wc().setAudioMuted(true); // por si YouTube intentara seguir con otro vídeo: nada se oye hasta la siguiente carga
        pending = null;
        return emit('state', { st: 'none', n: null });
    }
  }

  return {
    run,
    close() { clearInterval(timer); if (alive()) win.destroy(); win = null; cur = { n: null, v: null }; },
    window: () => (alive() ? win : null)
  };
}

module.exports = { createWatchEngine, errorCode };
