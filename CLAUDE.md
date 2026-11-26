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
| `npm run test:netsim [filtro]` | Red simulada (solo Linux con root; `apt install iproute2 nftables coturn xvfb`): cada cliente en su espacio de red tras NAT cono/simétrico/CGNAT, con coturn y DHT propios. En CI es el trabajo «Red simulada» |
| `npm run test:gate` | Bloqueo por versión obsoleta con Electron real (servidor local que hace de «GitHub»). También se ejecuta sobre la app empaquetada en CI |
| `npm run test:autoupdate` | Autoactualización REAL (solo Linux): construye dos AppImage, la vieja se actualiza sola a la nueva y se reinicia. Tarda ~2 min. Job «Autoactualización real» del CI |
| `node scripts/flaky.js <nombre> <n> -- <cmd>` | Repite una prueba n veces y cuenta fallos (lo usa el nocturno) |
| `node test/publicnet.js ana\|beto <llave>` | Prueba con la DHT pública entre dos máquinas (la lanza el nocturno, no se usa en local) |
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

## Diagnóstico de fallos de CI
- Si una prueba falla en CI, se suben como artefacto `test-results/` (registros de cada paso, capturas de cada ventana y el informe de Diagnóstico de cada instancia) y `test/shots/`. Léelos antes de adivinar la causa.
- El flujo **Nocturno** (`nightly.yml`) repite las pruebas decenas de veces, ejecuta la red simulada 3 veces y prueba la DHT pública entre un runner Linux y uno Windows. Su resumen da la tasa de fallos de cada prueba.
- Limitaciones conocidas que `test:netsim` documenta (si se arreglan, la prueba lo anuncia): la voz no atraviesa NAT simétrico↔cono ni CGNAT sin TURN, y con dos NAT simétricos no hay llamada ni con amigo con IP pública ni con TURN, porque la presencia de voz y la señalización solo viajan por conexiones directas.

## Versión obligatoria (OJO al publicar)
- La aplicación solo funciona si es la última versión publicada en GitHub (`releases/latest`): al arrancar consulta antes de levantar la red; abierta, cada 30 min (plazo de 30 s y después bloqueo). Instalador de Windows y AppImage se actualizan solos; portable y `.pacman` muestran el enlace de descarga. Sin conexión no se bloquea, salvo que ya se hubiera visto una versión más nueva. Código en `src/main/versiongate.js`, `updatecontroller.js` y `updates.js`.
- **Cada versión que se publica deja inservibles todas las anteriores que ya llevan el bloqueo (desde la 0.2.1).** Antes de publicar, `npm run verify` completo y el CI en verde. Si una versión publicada resultara rota, **borra su release en GitHub**: la anterior vuelve a ser la última y nadie queda atrapado.
- Las versiones anteriores a la que incluye este bloqueo (0.2.0) conservan el aviso antiguo no obligatorio.
- Solo para pruebas: `HUMBLECHAT_NO_UPDATE_GATE=1` lo desactiva (`test/lib.js` lo pone siempre), `HUMBLECHAT_UPDATE_URL` apunta a otro servidor de «última versión», `HUMBLECHAT_UPDATE_AUTO=1` permite la instalación automática con él, y `HUMBLECHAT_UPDATE_GRACE_MS` / `HUMBLECHAT_UPDATE_INTERVAL_MS` ajustan los tiempos.

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
- Autorización de la persona: Claude puede abrir PRs propios y mergearlos a `main` sin preguntar si el CI está en verde en Linux y Windows; Dependabot igual. Solo escribe a la persona si necesita su intervención. Publicar versiones (`version.yml` sin `dry_run`) sigue requiriendo que la persona lo pida.
