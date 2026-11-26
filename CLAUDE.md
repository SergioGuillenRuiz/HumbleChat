# HumbleChat

Chat P2P de texto, voz y vídeo para ~5 amigos. Electron + Hyperswarm + WebRTC. Sin servidor ni cuentas. Versión publicada: 0.2.0. Unas 8.000 líneas entre código y pruebas.

## Reglas de trabajo

- Responder en español, empezar por lo más útil, ser compacto y etiquetar cada afirmación como [Seguro] o [Probable]. No dar la razón por inercia; mantener la postura salvo información nueva.
- Ser honesto sobre lo que no se ha verificado. No dar nada por probado si solo se ha deducido.
- Rama de trabajo: main. Commits pequeños con mensaje en español. Nunca forzar un push ni saltarse o desactivar una prueba para ver el CI en verde; si una prueba es frágil, proponer el arreglo.
- Confirmar con el usuario antes de cambiar nada fuera del repo (etiquetas, releases, plugins, ajustes de la cuenta).
- README en español, corto, sin emojis y sin hablar de pruebas.

## Comandos

| Comando | Qué hace | Tiempo medido en Linux |
|---|---|---|
| `npm ci` | Instala dependencias | ~5 s con caché |
| `npm test` | Pruebas del núcleo y de contenido (`node --test`) | ~23 s |
| `npm run test:smoke` | Dos instancias de Electron: se encuentran, chatean y entran en voz | ~12 s |
| `npm run test:e2e` | Interfaz completa con 3 instancias | no medido |
| `npm run test:e2e2` | Contenido, audio y voz con relé | no medido |
| `npm start` | Ejecuta la app | |
| `npm run dist:all` / `dist:win` / `dist:linux` / `dist:public` | Empaquetar (`dist:public` sin `group.key`) | |

En Linux sin pantalla, las pruebas con Electron se lanzan con Xvfb:

```bash
xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:smoke
```

Lo mismo para `test:e2e` y `test:e2e2`. En Windows se ejecutan directamente; el CI solo corre `node test/e2e2.js contenido` allí. `HC_EXE=<ruta>` prueba la app ya empaquetada.

## Estructura

- `src/core/`: red y datos sin Electron. `node.js` (pares, sincronización, eventos), `sign.js` (firmas Ed25519), `store.js` (historial), `groupkey.js`, `identity.js`, `dmcrypto.js` (directos), `blobs.js` (archivos), `frames.js`, `natcheck.js`, `linkpreview.js`, `network.js`, `constants.js`.
- `src/main/`: proceso principal de Electron (`main.js`, `preload.js`, `updates.js`, `tray.js`, `ptt.js`, `settings.js`).
- `src/renderer/`: interfaz (`app.js`, `voice.js` con WebRTC, `ui/`, `styles.css`).
- `test/`: `core.test.js` y `content.test.js` (npm test), `smoke.js`, `e2e.js`, `e2e2.js`, `quality.js`, ayudas en `lib.js`.
- `scripts/`: compilación, llave de sala, nodo propio. `.github/workflows/`: `ci.yml` (Ubuntu y Windows) y `release.yml`.

## Protocolo (PROTOCOL 4)

Definido en `src/core/constants.js`. Un par con otra versión se rechaza y se avisa (`mismatch`). Cambiar el formato de un evento exige subir PROTOCOL.

- Cada evento lleva autor `a`, contador `n`, marca de tiempo `ts`, tipo `t` y firma `sig` (Ed25519 hex de 128 caracteres).
- La firma cubre una serialización canónica en array, con dominio `humblechat/event/v4` (`src/core/sign.js`). Añadir un campo a un tipo de evento sin añadirlo a `canon()` lo deja sin firmar.
- Tipos: `msg`, `del`, `edit`, `react`, `prof`, `chan`, `pin`, `emb`, `dm`.
- Los mensajes directos viajan cifrados dentro del evento `dm` (`to`, `box`).
- Conexión: ambos envían `hello` con prueba derivada de la llave de grupo y el handshake; luego `sync` con vector de versiones. Otros mensajes: `ev`, `evs`, `want`, `pres`, `sig` (señalización WebRTC), `typ`, `bw` (archivos).

## No verificado en máquina real

Solo se ha probado en CI (Ubuntu y Windows, DHT local) y en esta sesión en un contenedor Linux. Pendiente de probar con personas y equipos reales:

- NAT e Internet reales entre equipos distintos (NAT simétrico, CGNAT, relé por un tercero, TURN).
- Micrófono y cámara físicos (las pruebas usan medios falsos).
- Audio del sistema al compartir pantalla en Windows.
- Actualización automática de 0.2.0 a una versión nueva (instalador y AppImage).
- Wayland y la tecla global de pulsar para hablar.
- H.264 por hardware, RNNoise y calidad de audio con 5-6 personas.
- Aviso de SmartScreen y accesos directos del instalador de Windows; paquete `.pacman` en Arch.
