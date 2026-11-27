'use strict';
// Experimento (no es una prueba): ¿se puede reproducir y controlar un vídeo desde la PÁGINA NORMAL de YouTube (youtube.com/watch)
// en una ventana oculta y muda? A diferencia del reproductor incrustado, no depende de que el dueño permita incrustar, no exige
// referer y se pueden saltar los anuncios. Cuenta qué pasa segundo a segundo.
//
//   npx electron test/ytwatch.js <idVídeo> [segundos]
const { app, BrowserWindow, session } = require('electron');

if (process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ID = process.argv.find((a) => /^[\w-]{11}$/.test(a)) || 'dQw4w9WgXcQ';
const SECS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 40;
const t0 = Date.now();
const say = (...a) => console.log(String(Date.now() - t0).padStart(6), ...a);

const PROBE = `(() => {
  const p = document.getElementById('movie_player');
  const v = document.querySelector('video');
  const q = (s) => document.querySelector(s);
  return JSON.stringify({
    api: !!(p && p.getPlayerState), st: p && p.getPlayerState && p.getPlayerState(), t: p && p.getCurrentTime && +p.getCurrentTime().toFixed(1),
    d: p && p.getDuration && p.getDuration(), vid: p && p.getVideoData && p.getVideoData().video_id,
    ad: !!(p && p.classList.contains('ad-showing')), adState: p && p.getAdState && p.getAdState(),
    paused: v && v.paused, rs: v && v.readyState, vt: v && +v.currentTime.toFixed(1),
    skip: !!q('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button__text'),
    consent: !!q('ytd-consent-bump-v2-lightbox, tp-yt-paper-dialog[role=dialog], form[action*="consent"]'),
    err: (q('.ytp-error-content-wrap-reason') || {}).innerText || '', bot: /confirm you.re not a bot|Inicia sesión para confirmar/i.test(document.body ? document.body.innerText.slice(0, 4000) : ''),
    title: document.title.slice(0, 60), url: location.href.slice(0, 80)
  });
})()`;

app.whenReady().then(async () => {
  const ses = session.fromPartition('yt-watch-experimento');
  for (const [name, value] of [['CONSENT', 'YES+cb'], ['SOCS', 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiAo_CmBg']]) {
    await ses.cookies.set({ url: 'https://www.youtube.com', domain: '.youtube.com', name, value, secure: true, path: '/' }).catch((e) => say('cookie', name, e.message));
  }
  const win = new BrowserWindow({
    show: false, width: 1000, height: 700,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }
  });
  const wc = win.webContents;
  wc.setUserAgent(wc.getUserAgent().replace(/\s(?:Electron|humblechat)\/\S+/gi, ''));
  wc.setAudioMuted(true); // la prueba nunca suena
  wc.on('did-fail-load', (_e, code, desc, url) => say('fallo de carga', code, desc, String(url).slice(0, 100)));
  const run = (code) => wc.executeJavaScript(code, true).catch((e) => JSON.stringify({ jsError: String(e.message || e).slice(0, 120) }));
  say('cargando youtube.com/watch?v=' + ID);
  win.loadURL(`https://www.youtube.com/watch?v=${ID}`, { httpReferrer: 'https://www.youtube.com/' }).catch((e) => say('loadURL', e.message));
  let skipped = 0;
  for (let i = 0; i < SECS; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = JSON.parse(await run(PROBE));
    say(JSON.stringify(s));
    if (s.skip && skipped < 3) { skipped++; say('  → pulso «saltar anuncio»', await run(`(() => { const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'); if (b) { b.click(); return 'clic'; } return 'sin botón'; })()`)); }
    if (i === 12 && s.api) { say('  → seekTo(60)'); await run(`document.getElementById('movie_player').seekTo(60, true)`); }
    if (i === 20 && s.api) { say('  → pauseVideo'); await run(`document.getElementById('movie_player').pauseVideo()`); }
    if (i === 24 && s.api) { say('  → playVideo'); await run(`document.getElementById('movie_player').playVideo()`); }
  }
  win.destroy();
  app.exit(0);
});
setTimeout(() => app.exit(3), 5 * 60 * 1000).unref();
