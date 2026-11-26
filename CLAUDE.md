# HumbleChat – guía para Claude

Chat P2P de texto/voz/vídeo (Electron + Hyperswarm). Sin servidor. Windows y Linux. Idioma del código, comentarios y commits: **español**.

## Flujo de trabajo (todo es "vibe coding": la persona no ejecuta nada)
1. Cambia el código. 2. `npm run verify:quick` (~15 s) tras cada cambio relevante. 3. `npm run verify` completo (~2 min) antes de dar por terminada una tarea que toque `src/`. 4. Commit y push a la rama `claude/*` de la sesión. No abras PR salvo que se pida.
- Nunca pidas a la persona que ejecute comandos ni pruebe a mano algo que puedas probar tú con Electron real bajo Xvfb.
- Si una prueba falla, arregla la causa. Nunca saltes, borres ni debilites una prueba para ponerla en verde.

## Comandos
| Comando | Qué hace |
|---|---|
| `npm run verify` | Todo: núcleo, humo, e2e (3 instancias), e2e2 (contenido, voz con relé, bandeja). Lo mismo que el CI |
| `npm run verify:quick` | Núcleo + humo |
| `npm test` | Pruebas unitarias del núcleo y del contenido (`test/core.test.js`, `test/content.test.js`) |
| `npm run test:smoke` / `test:e2e` / `test:e2e2` | Pruebas con Electron real (en Linux sin pantalla: `xvfb-run -a -s "-screen 0 1920x1080x24" <cmd>`; `verify` lo hace solo) |
| `node test/quality.js audio\|video` | Medidas de calidad, no es pasa/no pasa |
| `npm start` | Ejecuta la app (necesita pantalla) |

## Entorno
- El hook SessionStart (`scripts/claude-setup.sh`) instala dependencias, el binario de Electron y Xvfb. El hook Stop (`scripts/claude-stop-check.sh`) lanza `verify:quick` si hay cambios sin verificar y te devuelve el fallo.
- Las pruebas usan una DHT local (`hyperdht/testnet`), audio/vídeo falsos y perfiles temporales: no tocan la red real.

## Arquitectura
- `src/core/`: P2P, sin dependencias de Electron (node.js, store.js, dmcrypto.js, frames.js, sign.js…). Probado con `test/core.test.js`.
- `src/main/`: proceso principal Electron (main, preload, tray, updates, ptt, settings).
- `src/renderer/`: interfaz (voice.js, ui/*, app.js). WebRTC para voz/vídeo.
- `electron-builder.config.js`, `scripts/build.js`, `.github/workflows/release.yml`: empaquetado y release (etiqueta `v*`).

## Reglas
- **`group.key` es secreto**: está en `.gitignore`, no lo leas, imprimas ni subas. Las compilaciones públicas usan `HUMBLECHAT_PUBLIC=1` (sin llave).
- Cambios de protocolo entre pares: sube la versión de protocolo y mantén la compatibilidad o deja constancia en el commit.
- Archivos grandes y de más riesgo: `src/renderer/voice.js`, `src/renderer/ui/chat.js`, `src/core/node.js`. Cambia con cuidado y con prueba.
- No se puede probar aquí: Windows (lo cubre el CI de `windows-latest`), hardware real (micro, cámara, H.264 por hardware) y NAT real entre casas.
- No subas versión ni crees etiquetas salvo que se pida: la etiqueta `v*` dispara la publicación.
