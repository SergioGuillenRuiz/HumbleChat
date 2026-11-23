# HumbleChat

Chat de texto, voz y vídeo para un grupo pequeño de amigos. Sin servidor, sin cuentas y sin configurar nada: las aplicaciones se encuentran y se conectan entre sí. Windows y Linux. Código abierto (MIT).

## Funcionalidades

- Canales de texto y de voz que se crean, renombran y borran. Markdown, respuestas, ediciones, reacciones, menciones, mensajes fijados, búsqueda y vistas previas de enlaces.
- Mensajes directos cifrados, archivos de cualquier tipo (hasta 64 MB) y avatares.
- Voz, cámara y pantalla compartida en alta calidad, con supresión de ruido, umbral de sensibilidad y pulsar para hablar con tecla global.
- Sin host fijo: el primero que abre la aplicación crea la sala y los demás se unen. El historial se guarda en cada equipo.
- Conexiones cifradas, mensajes firmados por su autor y acceso solo con el código de sala.
- Bandeja del sistema, inicio automático, aviso de mensajes sin leer y actualizaciones.

## Servicios externos

Gratuitos, sin cuenta ni clave. Ninguno ve mensajes, audio ni vídeo. Hace falta conexión a Internet.

| Servicio | Para qué |
|---|---|
| Nodos de arranque de la DHT de Hyperswarm | Que las aplicaciones se encuentren |
| Servidores STUN de Google, Cloudflare y Twilio | Averiguar la IP pública para la voz |
| GitHub | Avisar de versiones nuevas y descargarlas |
| Las páginas que enlazas | Solo quien envía el enlace visita la página, una vez, para la vista previa |

Para no depender de los públicos: `node scripts/own-node.js --host <IP pública>` en un equipo con IP pública genera un `network.json` (admite también un servidor TURN) que se coloca en la carpeta de datos de la aplicación o en la raíz del proyecto antes de compilar.

## Problemas conocidos y mejoras pendientes

- Con NAT simétrico o CGNAT estricto, la voz se retransmite a través de otro amigo; si no hay ninguno conectado (o para vídeo y pantalla) hace falta un servidor TURN en `network.json`.
- Pensado para unas 6 personas en llamada (conexión en malla).
- Los mensajes directos ocultan el contenido, no su existencia: el grupo puede ver quién escribe a quién y cuándo.
- El historial se guarda sin cifrar en el disco.
- Quien tiene el código de sala lee todo el historial. Para echar a alguien hay que crear una sala nueva (Ajustes, Sala) y repartir el código nuevo; el historial no se traslada.
- El audio del sistema al compartir pantalla solo existe en Windows y puede incluir las voces de la llamada.
- En Wayland la tecla global de pulsar para hablar puede no funcionar.
- En Windows el programa no está firmado: SmartScreen mostrará un aviso. La actualización automática solo funciona con el instalador y el AppImage; en el resto se avisa de la versión nueva.

## Instalación y uso

### Instalar

Descarga el archivo de la última versión en la página de Releases del repositorio.

| Sistema | Archivo | Cómo abrirlo |
|---|---|---|
| Windows | `HumbleChat-Setup-<versión>.exe` | Instalar. Si aparece SmartScreen: Más información, Ejecutar de todas formas. Hay también una versión `portable` sin instalación |
| Arch / CachyOS | `HumbleChat-<versión>.pacman` | `sudo pacman -U archivo.pacman`. También `makepkg -si` en `packaging/aur` |
| Otras distribuciones | `HumbleChat-<versión>-x86_64.AppImage` | Doble clic |

### Usar

1. Una persona abre la aplicación, elige "Crear una sala nueva" y copia el código de sala.
2. Los demás abren la aplicación, pegan el código y entran. Solo hace falta la primera vez; el código se vuelve a ver en el menú del servidor, Invitar a amigos.
3. Elige un canal de texto (`#`) para escribir o uno de voz para hablar. Abajo a la izquierda están el micrófono, los auriculares y los ajustes; durante una llamada, la cámara, la pantalla y colgar.
4. Para escribir en privado, pulsa el nombre de un amigo y Enviar mensaje.
5. Si algo falla, Ajustes, Diagnóstico muestra el estado de la red y de la llamada.

### Compilar

Requisitos: Node.js 20 o superior y Git.

```bash
git clone https://github.com/SergioGuillenRuiz/HumbleChat.git
cd HumbleChat
npm install
npm start            # ejecutar sin compilar
npm run dist:all     # Linux y Windows desde Linux (dist:win desde Windows)
```

Una compilación normal lleva dentro la llave de la sala (`group.key`): no la publiques. Con `npm run dist:public` se compila sin ella y cada usuario introduce el código.
