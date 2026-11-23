// AudioWorklet que aplica RNNoise (supresión de ruido con una red neuronal pequeña) a 48 kHz mono.
// RNNoise: https://gitlab.xiph.org/xiph/rnnoise (BSD) · compilado a WebAssembly por Jitsi (Apache-2.0),
// ver RNNOISE-LICENSE-Apache-2.0.txt. Aquí solo se carga el .wasm con un cargador mínimo.
const FRAME = 480 // RNNoise trabaja con bloques de 10 ms a 48 kHz

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    let memory
    const imports = { a: { a: () => 0, b: (dest, src, n) => new Uint8Array(memory.buffer).copyWithin(dest, src, src + n) } } // a = resize_heap, b = memcpy_big
    const ex = new WebAssembly.Instance(new WebAssembly.Module(options.processorOptions.wasm), imports).exports
    memory = ex.c // exportaciones minificadas: c=memoria d=ctors f=crear g=malloc h=destruir j=procesar
    ex.d()
    this.ex = ex
    this.state = ex.f(0)
    this.inPtr = ex.g(FRAME * 4)
    this.outPtr = ex.g(FRAME * 4)
    this.inBuf = new Float32Array(FRAME)
    this.inCount = 0
    this.out = new Float32Array(FRAME * 16) // anillo de salida
    this.r = 0
    this.w = 0
    this.avail = 0
    this.vad = 0
    this.frames = 0
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      this.inBuf[this.inCount++] = input[i] * 32768
      if (this.inCount === FRAME) {
        const mem = this.ex.c.buffer
        new Float32Array(mem, this.inPtr, FRAME).set(this.inBuf)
        this.vad = this.ex.j(this.state, this.outPtr, this.inPtr)
        const res = new Float32Array(mem, this.outPtr, FRAME)
        for (let k = 0; k < FRAME; k++) { this.out[this.w] = res[k] / 32768; this.w = (this.w + 1) % this.out.length }
        this.avail += FRAME
        this.inCount = 0
        if (++this.frames % 25 === 0) this.port.postMessage({ vad: this.vad }) // ~2 veces por segundo
      }
    }
    for (let i = 0; i < output.length; i++) {
      if (this.avail > 0) { output[i] = this.out[this.r]; this.r = (this.r + 1) % this.out.length; this.avail-- } else output[i] = 0
    }
    return true
  }
}

registerProcessor('rnnoise', RNNoiseProcessor)
