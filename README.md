# HumbleChat

Aplicación de escritorio de chat de texto, voz y vídeo para grupos pequeños de amigos. No necesita servidor, ni cuentas, ni configuración: las aplicaciones se encuentran y se conectan directamente entre sí. Funciona en Windows y Linux. Código abierto (MIT).

## Funcionalidades

- Canales de texto con Markdown, imágenes, emojis, respuestas, ediciones, reacciones y menciones.
- Canales de voz con indicador de quién habla, silenciar, ensordecer y volumen por usuario.
- Cámara y pantalla compartida en alta calidad.
- Historial guardado en cada equipo: la sala sigue funcionando aunque el primero en conectarse se vaya.
- Conexiones cifradas y mensajes firmados por su autor.
- Sin host fijo: el primero que abre la aplicación crea la sala y los demás se unen.
- Cambio automático de micrófono, auriculares y cámara al conectarlos o desconectarlos.

## Servicios externos

Solo se usan dos servicios públicos y gratuitos, sin cuenta, clave ni cuota. Ninguno ve mensajes, audio ni vídeo. Hace falta conexión a Internet.

| Servicio | Para qué |
|---|---|
| Nodos de arranque de la DHT de Hyperswarm | Que las aplicaciones se encuentren |
| Servidores STUN de Google, Cloudflare y Twilio | Averiguar la IP pública para la voz |

Se pueden sustituir por un nodo propio con `node scripts/own-node.js --host <IP pública>`, que genera el `network.json` a colocar en la raíz del proyecto antes de compilar.

## Problemas conocidos y mejoras pendientes

- La voz no usa servidor TURN: con NAT simétrico o CGNAT estricto, dos usuarios pueden no oírse.
- Pensado para unas 6 personas en llamada (conexión en malla).
- No hay actualización automática: todos deben usar la misma compilación.
- La llave del grupo va dentro de la aplicación y no se puede revocar sin recompilar. No publiques los archivos compilados.
- En Windows el programa no está firmado y SmartScreen mostrará un aviso.
- La pantalla compartida no incluye el audio del sistema.
- Solo se pueden adjuntar imágenes (hasta 16 MB).
- El historial se guarda sin cifrar en el disco.
- Los canales son fijos y no hay mensajes directos.
- Al cerrar la ventana se sale de la aplicación y de la llamada.

## Instalación y uso

### Compilar

Requisitos: Node.js 20 o superior y Git.

```bash
git clone https://github.com/SergioGuillenRuiz/HumbleChat.git
cd HumbleChat
npm install
npm run dist:all     # desde Linux: Linux y Windows
npm run dist:win     # desde Windows
```

Los archivos resultantes quedan en `dist/`. Todos los usuarios deben usar archivos de la misma compilación; si compilas en dos equipos, copia antes `group.key` del primero al segundo.

### Instalar

| Sistema | Archivo | Cómo abrirlo |
|---|---|---|
| Windows | `HumbleChat-<versión>-portable.exe` | Doble clic. Si aparece el aviso de SmartScreen: Más información, Ejecutar de todas formas |
| Arch / CachyOS | `HumbleChat-<versión>.pacman` | `sudo pacman -U archivo.pacman` |
| Otras distribuciones Linux | `HumbleChat-<versión>-x86_64.AppImage` | Doble clic |

### Usar

1. Abre la aplicación. En unos segundos aparecerán tus amigos en la lista de la derecha.
2. Para escribir, elige un canal de texto (con `#`).
3. Para hablar, elige un canal de voz. Los botones de la parte inferior izquierda silencian el micrófono, los auriculares o abren los ajustes.
4. Durante una llamada, los botones inferiores activan la cámara, comparten la pantalla o cuelgan.
5. El nombre de usuario es el del sistema; se cambia en Ajustes, Mi cuenta.
6. Si algo falla, Ajustes, Diagnóstico muestra el estado de la red y de la llamada.

Para ejecutar sin compilar: `npm start`.
