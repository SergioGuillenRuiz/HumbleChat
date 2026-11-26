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
| `npm run verify:quick` | Lint + núcleo + humo |
| `npm run lint` | ESLint (0 errores exigidos; los avisos no bloquean) |
| `npm run report` | Diagnóstico de un clic (NAT, audio, cámaras). Útil para pegar o ejecutar en el PC real |
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

## Releases (sin pasos manuales)
Disparar el flujo **Nueva versión** (`.github/workflows/version.yml`, `workflow_dispatch`, input `bump`: patch|minor|major) sobre `main` con `mcp__github__actions_run_trigger`. Verifica, sube versión, etiqueta y lanza `release.yml`. Solo cuando la persona lo pida. Dependabot abre PRs semanales de dependencias.

## PC real de la persona (Remote Desktop Commander, CachyOS, Wayland, PipeWire)
- Dispositivo `yahusmachine`. `sudo` está bloqueado ahí y no hay Xvfb ni webcam: **no ejecutes los tests con ventana en ese PC** (abrirían ventanas en su escritorio). Úsalo solo para medidas reales y no intrusivas: `git pull` en `~/.cache/humblechat-ci/repo` y `node scripts/report.js` (NAT real, audio real). Cada comando remoto espera como máximo 3 s: lanza y lee con `read_process_output`.
- Fuera de ese directorio no toques nada de su PC.

## Reglas
- **`group.key` es secreto**: está en `.gitignore`, no lo leas, imprimas ni subas. Las compilaciones públicas usan `HUMBLECHAT_PUBLIC=1` (sin llave).
- Cambios de protocolo entre pares: sube la versión de protocolo y mantén la compatibilidad o deja constancia en el commit.
- Archivos grandes y de más riesgo: `src/renderer/voice.js`, `src/renderer/ui/chat.js`, `src/core/node.js`. Cambia con cuidado y con prueba.
- No se puede probar aquí: Windows (lo cubre el CI de `windows-latest`), hardware real (micro, cámara, H.264 por hardware) y NAT real entre casas.
- No subas versión ni crees etiquetas salvo que se pida: la etiqueta `v*` dispara la publicación.
