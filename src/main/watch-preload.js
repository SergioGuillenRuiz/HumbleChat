'use strict';
// Se ejecuta DENTRO de la página de YouTube (ventana oculta del reproductor), antes que ninguno de sus scripts, en su mismo mundo
// de JavaScript. Quita de la respuesta del reproductor lo que describe los anuncios (huecos publicitarios), de modo que YouTube
// no llega a pedirlos: así cada uno oye la música sin anuncios y todos se mantienen sincronizados.
//
// No expone nada a la página ni habla con la aplicación (la ventana no tiene puentes): solo cambia lo que lee YouTube.
(() => {
  const KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakParams', 'adBreakHeartbeatParams'];
  const has = (o) => KEYS.some((k) => k in o);
  const prune = (o) => {
    if (!o || typeof o !== 'object') return o;
    if (has(o)) for (const k of KEYS) delete o[k];
    const pr = o.playerResponse;
    if (pr && typeof pr === 'object' && has(pr)) for (const k of KEYS) delete pr[k];
    return o;
  };

  // La respuesta que viene dentro de la propia página
  let initial;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get: () => initial, set: (v) => { initial = prune(v); } });
  } catch {}

  // Las que pide después (al cambiar de vídeo): por fetch y, si no, por JSON.parse
  const json = Response.prototype.json;
  Response.prototype.json = function () { return json.call(this).then(prune); };
  const parse = JSON.parse;
  JSON.parse = function (text, reviver) { return prune(parse.call(this, text, reviver)); };
})();
