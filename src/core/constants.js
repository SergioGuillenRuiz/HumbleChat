'use strict'
// Lo único "configurable" de la app vive aquí, en código. Sin menús, sin ficheros.

const SERVER_NAME = 'HumbleChat'

const CHANNELS = [
  { id: 'general', type: 'text', name: 'general', topic: 'Charla general' },
  { id: 'fotos', type: 'text', name: 'fotos', topic: 'Imágenes y capturas' },
  { id: 'voz-general', type: 'voice', name: 'General' },
  { id: 'voz-juegos', type: 'voice', name: 'Juegos' }
]

const LIMITS = {
  text: 4000, // caracteres por mensaje
  name: 32, // caracteres por nombre
  attachments: 6, // adjuntos por mensaje
  blob: 16 * 1024 * 1024, // bytes por imagen
  frame: 4 * 1024 * 1024, // bytes por trama de red
  blobChunk: 48 * 1024
}

const PROTOCOL = 1

// Servidores STUN públicos para WebRTC (voz). No hay TURN: necesitaría un servidor.
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' }
]

module.exports = { SERVER_NAME, CHANNELS, LIMITS, PROTOCOL, ICE_SERVERS }
