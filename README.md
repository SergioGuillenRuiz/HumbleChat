# HumbleChat

Chat de **texto y voz** para un grupo pequeño de amigos, con el aspecto de Discord y **sin servidor, sin cuentas y sin configuración**.
Funciona en **Windows** y **Linux (CachyOS / Arch)**. Pensado para ~6 personas; código abierto (MIT), nunca comercial.

- Canales de texto (`#general`, `#fotos`) con Markdown (`**negrita**`, `*cursiva*`, `` `código` ``, ``` bloques ```, `> citas`, enlaces), imágenes (pegar, arrastrar o `+`), borrar mensajes propios, indicador de no leídos y avisos de escritorio.
- Canales de voz (`General`, `Juegos`) con indicador de quién habla, silenciar/ensordecer, volumen por usuario y sonidos de entrada/salida.
- Compartir pantalla (el que quiere, pulsa «Ver pantalla»; solo se envía a quien mira).
- Lista de miembros (en línea / sin conexión) y Ajustes mínimos: nombre y dispositivos de audio. Nada más.

## Cómo se aloja solo (lo importante)

Nadie instala ni configura nada: **el primero que abre la app crea la sala y los demás se unen**.

1. Todas las instancias comparten una **llave de grupo** (`group.key`) que viaja dentro del instalador. De ella salen un *tema* de la DHT pública de [Hyperswarm](https://github.com/holepunchto/hyperswarm) y una prueba de pertenencia: quien no tenga la llave ni encuentra la sala ni puede entrar.
2. Al abrir la app te anuncias en ese tema y buscas a los demás. El primero en llegar queda anunciado; el siguiente lo encuentra y abre una **conexión directa y cifrada** (atravesando NAT/routers, sin abrir puertos).
3. **No hay un host único que pueda caerse**: cada app guarda su copia del historial y, al conectarse, intercambian lo que les falta. Si el primero se va, los demás siguen chateando y hablando sin notarlo; cuando vuelve, se pone al día solo. (Probado: `npm run test:e2e`.)
4. La voz es WebRTC en malla entre los que están en la llamada; la señalización viaja por esas mismas conexiones P2P.

Dependencias externas (gratuitas, públicas, sin registro): los nodos de arranque de la DHT de Hyperswarm y servidores STUN de Google/Cloudflare/Twilio para la voz. Hace falta Internet.

## Usarlo (tus amigos)

Pásales el instalador/zip que compiles tú (ver abajo). Lo abren y ya están dentro; su nombre por defecto es el de su usuario del sistema y pueden cambiarlo en Ajustes (engranaje abajo a la izquierda).

## Compilarlo (tú)

Requisitos: Node.js 20+ y npm.

```bash
npm install
npm start            # ejecutar en desarrollo
```

La primera vez se genera `group.key` (ignorada por git). **Esa llave es vuestra sala**: guárdala y, si compilas en dos sistemas operativos, **copia el mismo `group.key` a ambos** o no os veréis. No subas los instaladores a ningún sitio público (llevan la llave dentro).

```bash
# En Windows  -> dist/HumbleChat-Setup-<v>.exe  y  dist/HumbleChat-<v>-win.zip (portable)
npm run dist:win

# En CachyOS/Arch -> dist/HumbleChat-<v>-x86_64.AppImage  y  dist/HumbleChat-<v>.pacman
npm run dist:linux
sudo pacman -U dist/HumbleChat-*.pacman        # instalación nativa recomendada
```

Si el AppImage no abre en Arch: `sudo pacman -S fuse2` (o ejecuta `dist/linux-unpacked/humblechat`, que no necesita FUSE).
Si Electron se queja del sandbox al usar `npm start` en Linux: `npx electron . --no-sandbox`.

Wayland: la app usa Wayland nativo si lo hay; al compartir pantalla el portal del sistema te pregunta qué compartir.

## Límites conocidos

- Voz con **STUN pero sin TURN** (un TURN sería un servidor): dos amigos detrás de NAT simétrico/CGNAT estricto podrían no oírse entre sí. El chat de texto no tiene ese problema (los mensajes se retransmiten por la malla).
- Los adjuntos son solo imágenes (≤16 MB, se reducen solas); una imagen no se ve si su autor nunca estuvo conectado con nadie que la tenga.
- Compartir pantalla va sin audio del sistema.
- Malla completa: pensado para unas 6 personas en llamada.

## Desarrollo

```bash
npm test             # núcleo P2P sobre una DHT local (9 pruebas, incluye retransmisión y expulsión de intrusos)
xvfb-run -a npm run test:e2e   # 3 instancias reales de Electron: chat, imágenes, voz, pantalla, caída del primero
```

```
src/core/       red y datos, sin Electron: node.js (Hyperswarm), store.js (registro por autor), blobs.js, frames.js
src/main/       proceso principal de Electron: ventana, IPC, protocolo humble://, captura de pantalla
src/renderer/   interfaz (JS/CSS sin frameworks): chat, voz WebRTC (voice.js), ajustes
```

Variables solo para pruebas: `HUMBLECHAT_PROFILE` (carpeta de datos), `HUMBLECHAT_BOOTSTRAP=host:puerto` (DHT local), `HUMBLECHAT_KEY`, `HUMBLECHAT_FAKE_MEDIA=1`.

Licencia MIT. Tipografía Noto Sans (SIL OFL).
