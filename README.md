# HumbleChat

Chat de **texto y voz** para un grupo pequeño de amigos, con el aspecto de Discord y **sin servidor, sin cuentas y sin configuración**.
Funciona en **Windows** y **Linux (CachyOS / Arch)**. Pensado para ~6 personas; código abierto (MIT), nunca comercial.

- Canales de texto (`#general`, `#fotos`) con Markdown (`**negrita**`, `*cursiva*`, `` `código` ``, ``` bloques ```, `> citas`, enlaces), imágenes (pegar, arrastrar o `+`), borrar mensajes propios, indicador de no leídos y avisos de escritorio.
- Canales de voz (`General`, `Juegos`) con indicador de quién habla, silenciar/ensordecer, volumen por usuario y sonidos de entrada/salida.
- Compartir pantalla con dos calidades (Fluidez 1080p60 / Nitidez 1080p30); solo se envía a quien pulsa «Ver pantalla».
- Lista de miembros y Ajustes mínimos: nombre, dispositivos de audio y un panel de **Diagnóstico**.

## Cómo se aloja solo

Nadie instala ni configura nada: **el primero que abre la app crea la sala y los demás se unen**.

1. Todas las instancias comparten una **llave de grupo** (`group.key`) que viaja dentro del instalador. De ella salen un *tema* de la DHT de [Hyperswarm](https://github.com/holepunchto/hyperswarm) y una prueba de pertenencia: quien no tenga la llave ni encuentra la sala ni puede entrar.
2. Al abrir la app te anuncias en ese tema y buscas a los demás. El primero en llegar queda anunciado; el siguiente lo encuentra y abre una **conexión directa y cifrada** (atravesando NAT/routers, sin abrir puertos).
3. **No hay un host único que pueda caerse**: cada app guarda su copia del historial y, al conectarse, intercambian lo que les falta. Si el primero se va, los demás siguen sin notarlo; cuando vuelve, se pone al día solo.
4. Si dos amigos no pueden conectarse directamente, el texto y las imágenes llegan retransmitidos por un tercero. La voz es WebRTC en malla; su señalización viaja por esas mismas conexiones P2P.

### Servicios externos (y plan B)

Por defecto dependen de dos servicios públicos y gratuitos, **sin cuenta, clave ni cuota** (no pueden cobrarte ni limitarte; solo podrían dejar de existir). Ninguno ve mensajes, audio ni vídeo; solo IPs y el hash del tema:

| Servicio | Para qué |
|---|---|
| Nodos de arranque de la DHT de Hyperswarm | que las apps se encuentren |
| STUN de Google / Cloudflare / Twilio | que cada app sepa su IP pública para la voz |

Para que no haya ni siquiera ese riesgo de disponibilidad:
- La app **guarda en disco los nodos de la DHT que conoce** y arranca con ellos aunque los de arranque no respondan.
- Todo está en un único sitio (`src/core/network.js`). Si algún día desaparecen, ejecuta `node scripts/own-node.js --host <IP pública>` en cualquier equipo con IP pública (VPS, Raspberry con los UDP abiertos): levanta tu propio nodo de arranque + STUN e imprime el `network.json` que debes dejar en la raíz del repo antes de recompilar. Borra el archivo para volver a los públicos.

## Seguridad

- Transporte cifrado y autenticado (Noise) y pertenencia al grupo demostrada con HMAC de la llave sobre el handshake.
- **Cada mensaje va firmado con Ed25519 por su autor.** Nadie —ni quien tenga la llave, ni quien retransmita— puede suplantar a otro, alterar lo que dijo o borrar mensajes ajenos (comprobado con tests).
- Límites que debes conocer: la llave va dentro del instalador y no se puede revocar sin recompilar para todos (no subas los instaladores a sitios públicos); el historial se guarda en claro en el disco de cada uno; los participantes ven las IPs de los demás (inherente a P2P/WebRTC). El modelo de confianza es «los 6 amigos son de fiar».

## Calidad de audio y vídeo

Medido en pruebas con captura real y 2–4 instancias (no en redes reales):

- **Voz**: Opus mono a **64 kbps** con corrección de errores (FEC), cancelación de eco, supresión de ruido y control de ganancia (el valor por defecto de Chromium era 32 kbps).
- **Pantalla**: arranque a alto bitrate (sin esto salía a 360p durante minutos). *Fluidez*: VP8 1080p60 ≈ 6 Mbps. *Nitidez*: VP9 (VP8 de reserva) 1080p30 ≈ 4 Mbps, mejor para texto y código. Con 3 o más espectadores baja a 720p, porque en malla el emisor codifica una vez por espectador.
- Sin audio del sistema al compartir pantalla (capturaría las voces de los demás).

## Usarlo (tus amigos)

Pásales el instalador/zip que compiles tú. Lo abren y ya están dentro; su nombre por defecto es el de su usuario del sistema y pueden cambiarlo en Ajustes (engranaje abajo a la izquierda).

- **Windows**: el instalador no está firmado, así que SmartScreen mostrará «Windows protegió su PC» → *Más información → Ejecutar de todas formas*. Si salta el cortafuegos, permitir en redes privadas y públicas.
- **CachyOS**: ver abajo; con el `.pacman` queda instalado como cualquier app.

## Compilarlo (tú)

Requisitos: Node.js 20+ y npm.

```bash
npm install
npm start            # ejecutar en desarrollo
```

La primera vez se genera `group.key` (ignorada por git). **Esa llave es vuestra sala**: guárdala y, si compilas en dos sistemas operativos, **copia el mismo `group.key` a ambos** o no os veréis.

```bash
# En Windows  -> dist/HumbleChat-Setup-<v>.exe  y  dist/HumbleChat-<v>-win.zip (portable)
npm run dist:win

# En CachyOS/Arch -> dist/HumbleChat-<v>.pacman  y  dist/HumbleChat-<v>-x86_64.AppImage
npm run dist:linux
sudo pacman -U dist/HumbleChat-*.pacman        # instalación nativa recomendada
```

Si el AppImage no abre en Arch: `sudo pacman -S fuse2` (o ejecuta `dist/linux-unpacked/humblechat`, que no necesita FUSE).
Si Electron se queja del sandbox con `npm start`: `npx electron . --no-sandbox`.
Wayland: la app usa Wayland nativo si lo hay; al compartir pantalla el portal del sistema pregunta qué compartir (necesita `xdg-desktop-portal` con PipeWire, como cualquier app).

## Probarlo con tus amigos (guía)

1. Todos instalan **el mismo build** (misma `group.key`). Abrid la app a la vez o por turnos: debéis veros en «En línea» en pocos segundos.
2. Si no os veis: Ajustes → **Diagnóstico** → *Copiar informe* y pégalo al que lo investigue. Dice si la red P2P está conectada, a quién ve, y por cada llamada: si la conexión es directa/por NAT/por relé, el ping, bitrate, pérdida y jitter de audio, y resolución/fps/bitrate del vídeo. No contiene IPs ni mensajes.
3. Probad, por este orden: texto → imágenes → voz entre dos → voz entre todos → compartir pantalla (con y sin «Nitidez») → cerrar al primero y comprobar que el resto sigue → cerrar mal una app (matar el proceso): debe desaparecer de la llamada en ~12 s.
4. Para la voz usad **auriculares** la primera vez; si hay eco con altavoces, avisad (la cancelación de eco es la de Chromium, no la he podido probar con altavoces reales).

## Límites conocidos

- Voz con **STUN pero sin TURN** (un TURN sería un servidor): dos amigos detrás de NAT simétrico/CGNAT estricto podrían no oírse entre sí (el diagnóstico lo mostrará). El texto no tiene ese problema.
- Los adjuntos son solo imágenes (≤16 MB, se reducen solas); una imagen no se ve si su autor nunca estuvo conectado con nadie que la tenga.
- Malla completa: pensado para unas 6 personas en llamada.
- Sin probar: internet real, altavoces/micros reales, captura de pantalla vía PipeWire (Wayland) y **el `.exe` de Windows** (no se pudo ejecutar en el entorno de desarrollo; sí se comprobó que sus módulos nativos no dependen del runtime de Visual C++). Verificado en Linux: X11 y Wayland, AppImage y paquete pacman.
- Si ves recuadros vacíos en vez de emojis en Linux: `sudo pacman -S noto-fonts-emoji`.
- Si un amigo tiene otra versión de la app, la barra lateral lo avisa («instalad todos la misma»): todos deben usar el mismo build.

## Desarrollo

```bash
npm test                          # núcleo P2P sobre una DHT local (15 pruebas)
xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e   # 3 instancias reales de Electron (19 comprobaciones)
node test/quality.js audio|video  # banco de medidas de calidad (xvfb-run igual que arriba)
```

```
src/core/       red y datos, sin Electron: node.js (Hyperswarm), store.js (registro por autor), sign.js (firmas), network.js, blobs.js
src/main/       proceso principal de Electron: ventana, IPC, protocolo humble://, captura de pantalla
src/renderer/   interfaz (JS/CSS sin frameworks): chat, voz WebRTC (voice.js), ajustes
scripts/        ensure-key.js, make-icon.js, own-node.js (plan B: nodo propio DHT+STUN)
```

Variables solo para pruebas: `HUMBLECHAT_PROFILE` (carpeta de datos), `HUMBLECHAT_BOOTSTRAP=host:puerto` (DHT local), `HUMBLECHAT_KEY`, `HUMBLECHAT_FAKE_MEDIA=1`, `HUMBLECHAT_FAKE_AUDIO_FILE`.

Licencia MIT. Tipografía Noto Sans (SIL OFL).
