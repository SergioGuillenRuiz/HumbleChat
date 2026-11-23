// Elección de códec de vídeo. Por defecto VP8/VP9 por software (funcionan en todas partes). Si el sistema dispone de
// un codificador H.264 por HARDWARE (la tarjeta gráfica lo hace casi sin gastar CPU), se prefiere ese: menos CPU y
// menos calor al compartir pantalla o cámara. Si el otro extremo no decodifica H.264, se negocia el siguiente códec.

/** @param {string[]} base códecs por defecto del preset  @param {boolean} hw ¿hay H.264 por hardware? */
export function codecOrder(base, hw) {
  return hw ? ['video/H264', ...base.filter((c) => c !== 'video/H264')] : base
}

let cached = null

/** ¿Hay codificador H.264 eficiente (hardware)? Se consulta una sola vez. */
export function hasHardwareH264() {
  cached ||= (async () => {
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: { contentType: 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', width: 1920, height: 1080, bitrate: 6_000_000, framerate: 60 }
      })
      return !!(info.supported && info.powerEfficient)
    } catch { return false }
  })()
  return cached
}
