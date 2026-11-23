// Selector de emojis (como el de Discord): búsqueda en español, categorías y "usados recientemente".
import { h, store } from './util.js'
import { icon } from './icons.js'

// Cada entrada: "emoji palabras clave". Lista corta y curada; el sistema pone el dibujo.
const CATEGORIES = [
  ['Caras', '😀', `😀 sonrisa feliz|😃 alegre contento|😄 risa feliz|😁 sonrisa dientes|😆 risa carcajada|😅 sudor risa nervios|🤣 reir llorar suelo jajaja|😂 llorar risa jaja|🙂 sonrisa leve|🙃 al reves|😉 guiño|😊 sonrojo feliz|😇 angel|🥰 enamorado amor corazones|😍 ojos corazon enamorado|🤩 estrellas wow|😘 beso|😋 rico sabroso|😛 lengua|😜 guiño lengua loco|🤪 loco|😝 lengua ojos|🤗 abrazo|🤭 uy mano boca|🤔 pensar duda|🤨 ceja sospecha|😐 neutral|😑 inexpresivo|😶 sin boca|🙄 ojos en blanco|😏 picaro|😒 aburrido molesto|😬 mueca|😌 aliviado|😔 triste pensativo|😴 dormir sueño|🤤 baba|😷 mascarilla enfermo|🤒 fiebre|🤕 herido|🤢 asco nauseas|🤮 vomitar|🥵 calor|🥶 frio|😵 mareado|🤯 mente explotar|🤠 vaquero|😎 gafas cool guay|🤓 friki empollon|🧐 monóculo|😕 confuso|😟 preocupado|🙁 triste|😮 sorpresa|😯 sorprendido|😲 asombro|😳 vergüenza sonrojado|🥺 suplicar ojitos|😦 horror|😨 miedo|😰 ansiedad|😢 llorar triste|😭 llorando mucho|😱 grito terror|😖 agobio|😞 decepcion|😓 sudor frio|😩 cansado harto|😫 agotado|🥱 bostezo|😤 resoplido enfado|😡 enfadado rabia|😠 enojado|🤬 insultos|😈 diablillo|💀 calavera muerto|💩 caca|🤡 payaso|👻 fantasma|👽 alien|🤖 robot`],
  ['Gestos', '👍', `👍 pulgar arriba bien vale ok|👎 pulgar abajo mal|👌 perfecto ok|✌️ paz victoria|🤞 dedos cruzados suerte|🤟 te quiero|🤘 rock|🤙 llamame|👈 izquierda|👉 derecha|👆 arriba|👇 abajo|☝️ uno atencion|✋ mano alto|🖐️ mano abierta|👋 hola adios saludo|🤚 mano|🖖 vulcano spock|👏 aplauso|🙌 manos arriba celebrar|👐 manos abiertas|🤲 manos juntas|🙏 gracias rezar por favor|🤝 acuerdo trato|✍️ escribir|💪 fuerza musculo|🦾 brazo robot|🧠 cerebro|👀 ojos mirar|👁️ ojo|👅 lengua|👄 boca|🫶 corazon manos|🫡 saludo militar|🤷 ni idea|🤦 facepalm vergüenza ajena|🙋 levantar mano|🙇 reverencia|💁 informacion|🙅 no|🙆 ok|🕺 bailar|💃 bailar|🏃 correr|🚶 caminar`],
  ['Amor', '❤️', `❤️ corazon rojo amor|🧡 corazon naranja|💛 corazon amarillo|💚 corazon verde|💙 corazon azul|💜 corazon morado|🖤 corazon negro|🤍 corazon blanco|🤎 corazon marron|💔 corazon roto|❣️ exclamacion corazon|💕 dos corazones|💞 corazones girando|💓 corazon latiendo|💗 corazon creciendo|💖 corazon brillante|💘 flecha corazon|💝 corazon regalo|💋 beso labios|💯 cien perfecto|✨ brillos magia|⭐ estrella|🌟 estrella brillante|💫 mareo estrellas|🔥 fuego caliente lit|💥 explosion|💢 enfado|💦 gotas agua sudor|💨 viento prisa|🎉 fiesta celebracion confeti|🎊 confeti|🎈 globo|🎁 regalo|🏆 trofeo campeon|🥇 oro primero|🥈 plata|🥉 bronce|🎯 diana objetivo|🚀 cohete|⚡ rayo energia|✅ correcto hecho|❌ error cruz|❗ exclamacion|❓ pregunta|⚠️ aviso peligro`],
  ['Animales', '🐶', `🐶 perro|🐱 gato|🐭 raton|🐹 hamster|🐰 conejo|🦊 zorro|🐻 oso|🐼 panda|🐨 koala|🐯 tigre|🦁 leon|🐮 vaca|🐷 cerdo|🐸 rana sapo|🐵 mono|🙈 mono no ver|🙉 mono no oir|🙊 mono no hablar|🐔 gallina pollo|🐧 pinguino|🐦 pajaro|🦆 pato|🦅 aguila|🦉 buho|🦇 murcielago|🐺 lobo|🐴 caballo|🦄 unicornio|🐝 abeja|🐛 bicho gusano|🦋 mariposa|🐌 caracol|🐞 mariquita|🐢 tortuga|🐍 serpiente|🦖 dinosaurio|🐙 pulpo|🦀 cangrejo|🐟 pez|🐬 delfin|🐳 ballena|🦈 tiburon|🐘 elefante|🦒 jirafa|🐑 oveja|🐐 cabra|🌵 cactus|🌲 arbol pino|🌳 arbol|🌴 palmera|🌷 tulipan flor|🌹 rosa|🌻 girasol|🍀 trebol suerte|🍄 seta|🌈 arcoiris|☀️ sol|🌙 luna|⛅ nube sol|🌧️ lluvia|❄️ nieve copo|🌊 ola mar`],
  ['Comida', '🍕', `🍎 manzana|🍌 platano|🍇 uvas|🍉 sandia|🍓 fresa|🍑 melocoton|🍒 cerezas|🍍 piña|🥑 aguacate|🍅 tomate|🥕 zanahoria|🌽 maiz|🥔 patata|🍞 pan|🥐 croissant|🧀 queso|🥚 huevo|🥓 bacon|🍔 hamburguesa|🍟 patatas fritas|🍕 pizza|🌭 perrito caliente|🥪 sandwich bocadillo|🌮 taco|🌯 burrito|🥗 ensalada|🍝 pasta espaguetis|🍜 fideos ramen|🍣 sushi|🍤 gamba|🍙 onigiri|🍦 helado|🍩 donut|🍪 galleta|🎂 tarta cumpleaños|🍰 pastel|🍫 chocolate|🍬 caramelo|🍿 palomitas|☕ cafe|🍵 te|🍺 cerveza|🍻 brindis cervezas|🍷 vino|🥂 brindis copas|🍸 cocktel|🧃 zumo|🥤 refresco|🍾 champan|🥄 cuchara|🍴 cubiertos`],
  ['Juegos', '🎮', `🎮 mando videojuegos|🕹️ joystick|🎲 dado|♟️ ajedrez|🧩 puzzle|🎯 diana|🎰 tragaperras|🎳 bolos|⚽ futbol|🏀 baloncesto|🏈 rugby|⚾ beisbol|🎾 tenis|🏐 voleibol|🏓 ping pong|🥊 boxeo|🏆 trofeo|🎸 guitarra|🎹 piano|🥁 bateria|🎤 microfono|🎧 auriculares|🎬 cine claqueta|📺 tele|📷 camara foto|💻 portatil ordenador|🖥️ pantalla pc|⌨️ teclado|🖱️ raton|💾 disquete|📱 movil|📞 telefono|🔋 bateria|🔌 enchufe|💡 bombilla idea|🔦 linterna|📚 libros|📖 libro|✏️ lapiz|📝 nota|📌 chincheta|📎 clip|🔒 candado|🔑 llave|🛠️ herramientas|⚙️ engranaje|💰 dinero|💸 dinero volando|💎 diamante|🚗 coche|🚕 taxi|🚌 autobus|🚂 tren|✈️ avion|🚲 bici|🏠 casa|🏖️ playa|⛺ tienda campaña|🗺️ mapa|⏰ despertador|⌛ reloj arena|📅 calendario|🔔 campana|🔕 silencio|📢 altavoz|🔊 volumen`]
]

const ALL = []
for (const [name, ic, raw] of CATEGORIES) {
  const list = raw.split('|').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)] })
  ALL.push({ name, ic, list })
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const recents = () => store('recentEmoji') || []
export function useEmoji(e) {
  store('recentEmoji', [e, ...recents().filter((x) => x !== e)].slice(0, 24))
}
export const quickEmoji = () => [...recents(), '👍', '😂', '❤️', '🎉', '😮', '🙏'].filter((e, i, a) => a.indexOf(e) === i).slice(0, 4)

/** Abre el selector junto a `anchor`. `onPick(emoji)` se llama al elegir; con `keepOpen` no se cierra. */
export function openEmojiPicker(anchor, onPick, { keepOpen = false, above = true } = {}) {
  document.querySelector('.emoji-picker')?.remove()
  const search = h('input.ep-search', { placeholder: 'Busca un emoji', spellcheck: false })
  const grid = h('div.ep-grid')
  const label = h('div.ep-label', 'Elige un emoji')
  const tabs = h('div.ep-tabs')
  let query = ''

  const cell = ([e, kw]) => h('button.ep-emoji', {
    onmouseenter: () => { label.textContent = e + '  ' + kw.split(' ').slice(0, 3).join(' ') },
    onclick: () => { useEmoji(e); onPick(e); if (!keepOpen) close() }
  }, e)

  function draw() {
    grid.replaceChildren()
    if (query) {
      const q = norm(query)
      const found = ALL.flatMap((c) => c.list).filter(([e, kw]) => norm(kw).includes(q) || e === query)
      grid.append(h('div.ep-cat', 'Resultados'), found.length ? h('div.ep-row', found.map(cell)) : h('div.ep-none', 'No hay emojis con ese nombre'))
      return
    }
    const rec = recents()
    if (rec.length) grid.append(h('div.ep-cat', 'Usados recientemente'), h('div.ep-row', rec.map((e) => cell([e, '']))))
    for (const c of ALL) grid.append(h('div.ep-cat', { id: 'ep-' + c.name }, c.name), h('div.ep-row', c.list.map(cell)))
  }
  tabs.append(...ALL.map((c) => h('button.ep-tab', { tip: c.name, tipPos: 'bottom', onclick: () => { search.value = ''; query = ''; draw(); grid.querySelector('#ep-' + c.name)?.scrollIntoView({ block: 'start' }) } }, c.ic)))
  search.addEventListener('input', () => { query = search.value.trim(); draw() })
  draw()

  const picker = h('div.emoji-picker', h('div.ep-head', h('div.ep-searchbox', search, icon('search', 18)), tabs), grid, h('div.ep-foot', label))
  document.body.append(picker)
  const r = anchor.getBoundingClientRect()
  const w = picker.offsetWidth
  const hgt = picker.offsetHeight
  picker.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px'
  picker.style.top = Math.max(8, above ? r.top - hgt - 8 : Math.min(r.bottom + 8, innerHeight - hgt - 8)) + 'px'
  search.focus()

  const close = () => { picker.remove(); removeEventListener('mousedown', off, true); removeEventListener('keydown', onKey, true) }
  const off = (e) => { if (!picker.contains(e.target) && !anchor.contains(e.target)) close() }
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  setTimeout(() => { addEventListener('mousedown', off, true); addEventListener('keydown', onKey, true) })
  return close
}
