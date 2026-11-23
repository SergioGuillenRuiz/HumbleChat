# HumbleChat

Chat de **texto, voz y vídeo** para un grupo pequeño de amigos, con el aspecto y el manejo de Discord y **sin servidor, sin cuentas y sin configuración**.
Funciona en **Windows** y **Linux (CachyOS / Arch)**. Pensado para ~6 personas; código abierto (MIT), nunca comercial.

---

## 🚀 Guía rápida (para tontos)

### Si eres quien lo monta (una sola vez)

1. Instala [Node.js](https://nodejs.org) (versión 20 o más) y [Git](https://git-scm.com).
2. Abre una terminal y escribe, línea por línea:
   ```bash
   git clone https://github.com/SergioGuillenRuiz/HumbleChat.git
   cd HumbleChat
   npm install
   ```
3. Genera la aplicación:
   - **Estás en CachyOS/Linux** → `npm run dist:all` (crea la de Linux **y** la de Windows).
   - **Estás en Windows** → `npm run dist:win`.
4. Mira la carpeta **`dist/`** y **pásales a tus amigos** el archivo que les corresponda (por Discord, WhatsApp, Drive… lo que sea):

   | Tu amigo usa… | Pásale este archivo |
   |---|---|
   | Windows | `HumbleChat-…-portable.exe` (se abre con doble clic, sin instalar) |
   | CachyOS / Arch | `HumbleChat-….pacman` (se instala con `sudo pacman -U archivo.pacman`) o `HumbleChat-…AppImage` (doble clic) |

   ⚠️ **Todos tenéis que usar archivos de la misma compilación.** Si compilas en dos ordenadores distintos, copia antes el archivo **`group.key`** del primero al segundo; si no, no os veréis. No subas estos archivos a sitios públicos: llevan dentro la «llave» de vuestra sala.

### Si eres un amigo

1. **Abre el archivo** que te han pasado.
   - *Windows*: si sale «Windows protegió su PC» → pulsa **Más información → Ejecutar de todas formas** (es normal: el programa no está firmado). Si pregunta por el cortafuegos, pulsa **Permitir**.
   - *CachyOS*: `sudo pacman -U el-archivo.pacman` y búscalo en el menú de aplicaciones, o doble clic al AppImage.
2. **Ya estás dentro.** No hay que crear cuenta ni escribir nada. En unos segundos verás a tus amigos en la lista de la derecha («En línea»).
3. **Escribir**: pulsa un canal con `#` (por ejemplo `# general`) y escribe abajo. Intro para enviar.
4. **Hablar**: pulsa un canal con el altavoz 🔊 (por ejemplo `General`). Ya estás en la llamada. El micrófono 🎤 y los auriculares 🎧 de abajo a la izquierda sirven para silenciarte o ensordecerte; el botón rojo del teléfono cuelga.
5. **Compartir pantalla o cámara**: estando en una llamada, pulsa los botones de abajo del todo (monitor = pantalla, cámara = tu cámara).
6. **Tu nombre** sale solo (el de tu usuario del ordenador). Si quieres otro: engranaje ⚙ abajo a la izquierda → *Mi cuenta*.

### Si algo no va

| Problema | Qué hacer |
|---|---|
| No veo a nadie | Esperad ~20 segundos. Comprobad que todos tenéis **Internet** y **la misma versión** (la barra de la izquierda avisa si no). |
| No me oyen | Pulsa el micrófono: ¿está tachado en rojo? Mira **⚙ → Voz y vídeo**. En Windows: *Configuración → Privacidad → Micrófono → permitir apps de escritorio*. |
| Hay eco | Usad auriculares. |
| Otra cosa | **⚙ → Diagnóstico → Copiar informe** y mándaselo a quien lo montó. No lleva IPs ni mensajes. |

---

## Qué incluye

- **Texto** (`#general`, `#fotos`): Markdown (`**negrita**`, `*cursiva*`, `` `código` ``, ``` bloques ```, `> citas`, enlaces), imágenes (pegar, arrastrar o `+`), **emojis** con buscador, **responder**, **editar**, **reaccionar**, **@menciones** con autocompletado, «está escribiendo…», línea roja de mensajes nuevos, insignia roja de menciones, «saltar al presente», borrar mensajes propios, menú con clic derecho y avisos de escritorio.
- **Voz** (`General`, `Juegos`): indicador de quién habla, silenciar/ensordecer (Ctrl+Mayús+M / Ctrl+Mayús+D), volumen por usuario (clic derecho), sonidos de entrada/salida, ping.
- **Cámara** y **pantalla compartida** con dos calidades (Fluidez 1080p60 / Nitidez 1080p30); la pantalla solo se envía a quien pulsa «Ver pantalla».
- Lista de miembros, tarjetas de perfil, categorías plegables y un menú del servidor (*Invitar a amigos*, *Marcar todo como leído*…).
- Ajustes mínimos: nombre, dispositivos, notificaciones y **Diagnóstico**.

## Dispositivos

Está pensado para funcionar sin tocar nada con lo que tengas enchufado:

- **Micrófonos y auriculares** USB, jack o Bluetooth: se usa el predeterminado del sistema. Si **conectas o desconectas** unos auriculares durante una llamada, la app cambia sola (y te avisa). Si entras sin micrófono, entras a escuchar y, al conectarlo, ya puedes hablar.
- **Cámaras web**: se detecta la predeterminada, con vista previa en Ajustes; si se desconecta se apaga sola.
- **Varios monitores / ventanas**: al compartir eliges cuál con miniaturas. En Wayland pregunta el portal del sistema.
- **Errores con instrucciones**: si el sistema bloquea el micro (Windows: Privacidad) o está en uso por otro programa, la app lo dice y explica qué hacer.
- Windows (x64) y Linux (x64): X11 y Wayland.

## Cómo se aloja solo

Nadie instala ni configura nada: **el primero que abre la app crea la sala y los demás se unen**.

1. Todas las instancias comparten una **llave de grupo** (`group.key`) que viaja dentro de la aplicación. De ella salen un *tema* de la DHT de [Hyperswarm](https://github.com/holepunchto/hyperswarm) y una prueba de pertenencia: quien no tenga la llave ni encuentra la sala ni puede entrar.
2. Al abrir la app te anuncias en ese tema y buscas a los demás. El primero en llegar queda anunciado; el siguiente lo encuentra y abre una **conexión directa y cifrada** (atravesando NAT/routers, sin abrir puertos).
3. **No hay un host único que pueda caerse**: cada app guarda su copia del historial y, al conectarse, intercambian lo que les falta. Si el primero se va, los demás siguen sin notarlo; cuando vuelve, se pone al día solo.
4. Si dos amigos no pueden conectarse directamente, el texto y las imágenes llegan retransmitidos por un tercero. La voz es WebRTC en malla; su señalización viaja por esas mismas conexiones P2P.

### Servicios externos (y plan B)

Por defecto dependen de dos servicios públicos y gratuitos, **sin cuenta, clave ni cuota** (no pueden cobrarte ni limitarte; solo podrían dejar de existir). Ninguno ve mensajes, audio ni vídeo; solo IPs y el hash del tema:

| Servicio | Para qué |
|---|---|
| Nodos de arranque de la DHT de Hyperswarm | que las apps se encuentren |
| STUN de Google / Cloudflare / Twilio | que cada app sepa su IP pública para la voz |

La app **guarda en disco los nodos de la DHT que conoce** y arranca con ellos aunque los de arranque no respondan. Todo está en un único sitio (`src/core/network.js`). Si algún día desaparecen, ejecuta `node scripts/own-node.js --host <IP pública>` en cualquier equipo con IP pública (VPS, Raspberry con los UDP abiertos): levanta tu propio nodo de arranque + STUN e imprime el `network.json` que debes dejar en la raíz del repo antes de recompilar. Bórralo para volver a los públicos.

## Seguridad

- Transporte cifrado y autenticado (Noise) y pertenencia al grupo demostrada con HMAC de la llave sobre el handshake.
- **Cada mensaje, edición, reacción y borrado va firmado con Ed25519 por su autor.** Nadie —ni quien tenga la llave, ni quien retransmita— puede suplantar a otro, alterar lo que dijo o borrar mensajes ajenos (comprobado con tests).
- Límites que debes conocer: la llave va dentro de la aplicación y no se puede revocar sin recompilar para todos; el historial se guarda en claro en el disco de cada uno; los participantes ven las IPs de los demás (inherente a P2P/WebRTC). El modelo de confianza es «los amigos son de fiar».

## Calidad de audio y vídeo

Medido en pruebas con captura real (no en redes reales):

- **Voz**: Opus mono a **64 kbps** con corrección de errores (FEC), cancelación de eco, supresión de ruido y control de ganancia.
- **Pantalla**: arranque a alto bitrate (sin esto salía a 360p durante minutos). *Fluidez*: VP8 1080p60 ≈ 6 Mbps. *Nitidez*: VP9 (VP8 de reserva) 1080p30 ≈ 4 Mbps, mejor para texto y código. Con 3 o más espectadores baja a 720p, porque en malla el emisor codifica una vez por espectador.
- **Cámara**: VP8 720p30 ≈ 1,2 Mbps (baja a 480p con 5 o más personas en la llamada).
- Sin audio del sistema al compartir pantalla (capturaría las voces de los demás).

## Compilarlo (detalle)

Requisitos: Node.js 20+ y npm. `npm start` ejecuta la app en desarrollo.

La primera vez se genera `group.key` (ignorada por git). **Esa llave es vuestra sala.**

```bash
npm run dist:win     # en Windows: instalador .exe (NSIS), .exe portable y .zip
npm run dist:linux   # en CachyOS/Arch: .pacman y AppImage
npm run dist:all     # desde Linux: .pacman + AppImage + .exe portable + .zip de Windows (misma llave para todos)
```

El instalador NSIS solo se puede generar compilando en Windows (en Linux haría falta wine); el `.exe` portable y el zip sí salen desde Linux.
Si el AppImage no abre en Arch: `sudo pacman -S fuse2` (o ejecuta `dist/linux-unpacked/humblechat`). Si Electron se queja del sandbox con `npm start`: `npx electron . --no-sandbox`. Si ves recuadros vacíos en vez de emojis: `sudo pacman -S noto-fonts-emoji`.

## Probarlo con tus amigos (guía)

1. Todos usan **el mismo build** (misma `group.key`). Abridlo a la vez o por turnos: debéis veros en «En línea» en pocos segundos.
2. Si no os veis: **⚙ → Diagnóstico → Copiar informe**. Dice si la red P2P está conectada, a quién ve, y por llamada: conexión directa/NAT/relé, ping, bitrate, pérdidas, jitter, y resolución/fps del vídeo.
3. Probad por este orden: texto → imágenes → responder/reaccionar/@menciones → voz entre dos → voz entre todos → cámara → compartir pantalla → cerrar al primero y comprobar que el resto sigue → cerrar mal una app (matar el proceso): debe desaparecer de la llamada en ~12 s → enchufar/desenchufar unos auriculares en plena llamada.
4. Usad **auriculares** la primera vez; si hay eco con altavoces, avisad (la cancelación de eco es la de Chromium; no la he podido probar con altavoces reales).

## Límites conocidos

- Voz con **STUN pero sin TURN** (un TURN sería un servidor): dos amigos detrás de NAT simétrico/CGNAT estricto podrían no oírse entre sí (el diagnóstico lo mostrará). El texto no tiene ese problema.
- Los adjuntos son solo imágenes (≤16 MB, se reducen solas); una imagen no se ve si su autor nunca estuvo conectado con nadie que la tenga.
- Malla completa: pensado para unas 6 personas en llamada.
- Sin probar: internet real, altavoces/micros/cámaras físicos reales, captura de pantalla vía PipeWire (Wayland) y **el `.exe` de Windows** (no se pudo ejecutar en el entorno de desarrollo; sí se comprobó que sus módulos nativos no dependen del runtime de Visual C++). Verificado en Linux: X11 y Wayland, AppImage y paquete pacman.
- Si un amigo tiene otra versión de la app, la barra lateral lo avisa: todos deben usar el mismo build. No hay actualización automática.

## Desarrollo

```bash
npm test                          # núcleo P2P sobre una DHT local (17 pruebas)
xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e   # varias instancias reales de Electron (29 comprobaciones)
node test/quality.js audio|video  # banco de medidas de calidad (xvfb-run igual que arriba)
```

```
src/core/       red y datos, sin Electron: node.js (Hyperswarm), store.js (registro por autor), sign.js (firmas), network.js, blobs.js
src/main/       proceso principal de Electron: ventana, IPC, protocolo humble://, captura de pantalla
src/renderer/   interfaz (JS/CSS sin frameworks): chat, voz WebRTC (voice.js), emojis, ajustes
scripts/        ensure-key.js, make-icon.js, own-node.js (plan B: nodo propio DHT+STUN)
```

Variables solo para pruebas: `HUMBLECHAT_PROFILE` (carpeta de datos), `HUMBLECHAT_BOOTSTRAP=host:puerto` (DHT local), `HUMBLECHAT_KEY`, `HUMBLECHAT_FAKE_MEDIA=1`, `HUMBLECHAT_FAKE_AUDIO_FILE`.

Licencia MIT. Tipografía Noto Sans (SIL OFL).
