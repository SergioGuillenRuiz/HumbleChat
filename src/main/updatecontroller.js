'use strict'
// Máquina de estados del bloqueo por versión (sin Electron: todo lo externo llega por parámetros, para probarla).
//
//   ok ──(hay una versión más nueva)──▶ grace (plazo para terminar lo que se hace) ──▶ forced
//   Al arrancar no hay plazo: si ya es obsoleta, va directa a forced y la red ni se arranca.
//   forced = la aplicación no sigue: red parada y pantalla de actualización obligatoria.
//     · auto (instalador de Windows, AppImage): descarga la actualización y se reinicia sola; si falla, reintenta.
//     · manual (portable, .pacman, otros): enlace de descarga, "volver a comprobar" y salir.
const { decide, fetchLatest } = require('./versiongate')

class UpdateController {
  /**
   * current        versión instalada
   * active()       ¿está activo el bloqueo? (aplicación empaquetada o URL de pruebas)
   * lookup()       → { version, url } | null (última publicación)
   * store          { get(): string, set(v) } para recordar la última versión vista
   * canAutoUpdate() ¿puede esta instalación actualizarse sola?
   * createUpdater() → actualizador tipo electron-updater (EventEmitter con checkForUpdates y quitAndInstall) | null
   * stopNetwork()  detiene la red P2P (async)
   * relaunch()     reinicia la aplicación
   * send(type,msg) mensaje hacia la interfaz
   * onForced()     aviso al proceso principal de que ya no hay vuelta atrás (cerrar = salir)
   */
  constructor(o) {
    Object.assign(this, { graceMs: 30000, retryMs: 60000, installDelayMs: 1500, onForced() {} }, o)
    this.phase = 'ok'
    this.msg = null
    this.updater = null
    this.downloaded = false
    this.timers = new Set()
    this.last = null // resultado de la última comprobación, para el Diagnóstico
  }

  _later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn() }, ms)
    t.unref?.()
    this.timers.add(t)
    return t
  }

  _emit(msg) {
    this.msg = { ...msg, current: this.current }
    this.send('update', this.msg)
  }

  state() { return this.msg }

  /** { at, ok, latest } de la última comprobación (null si aún no hubo ninguna o el bloqueo está inactivo). */
  lastCheck() { return this.last ? { ...this.last, current: this.current } : null }

  async _evaluate() {
    const info = await this.lookup()
    this.last = { at: Date.now(), ok: !!info, latest: info?.version ?? null }
    if (info) this.store.set(info.version) // lo publicado manda: si se retira una versión, se olvida
    const d = decide({ current: this.current, latest: info?.version ?? null, latestSeen: this.store.get() })
    return { ...d, url: info?.url ?? null }
  }

  /** Al arrancar, antes de levantar la red. Devuelve { block, ... }. */
  async gateAtStartup() {
    if (!this.active()) return { block: false, reason: 'inactive' }
    const r = await this._evaluate()
    if (r.block) await this._forced(r)
    return r
  }

  /** Comprobación periódica o pedida a mano. */
  async check() {
    if (!this.active() || this.phase !== 'ok') return
    const r = await this._evaluate()
    if (r.block) this._grace(r)
  }

  start(intervalMs) {
    const t = setInterval(() => this.check().catch(() => {}), intervalMs)
    t.unref?.()
    this.interval = t
  }

  stop() {
    clearInterval(this.interval)
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  _grace(r) {
    this.phase = 'grace'
    this._emit({ state: 'grace', version: r.latest, url: r.url, deadline: Date.now() + this.graceMs })
    this._later(() => this._forced(r), this.graceMs)
  }

  async _forced(r) {
    if (this.phase === 'forced') return
    this.phase = 'forced'
    this.info = r
    this.onForced()
    await Promise.resolve(this.stopNetwork()).catch(() => {})
    const auto = this.canAutoUpdate() && (this.updater ||= this._setupUpdater())
    this._emit({ state: 'forced', mode: auto ? 'auto' : 'manual', stage: auto ? 'checking' : 'manual', version: r.latest, url: r.url, reason: r.reason })
    if (auto) this._download()
  }

  _setupUpdater() {
    let u = null
    try { u = this.createUpdater() } catch { u = null }
    if (!u) return null
    u.on('download-progress', (p) => this._emit({ ...this._forcedBase(), stage: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))) }))
    u.on('update-downloaded', () => {
      this.downloaded = true
      this._emit({ ...this._forcedBase(), stage: 'installing' })
      this._later(() => this.install(), this.installDelayMs)
    })
    u.on('update-not-available', () => this._failed(new Error('El actualizador todavía no encuentra los archivos de la versión nueva')))
    u.on('error', (e) => this._failed(e))
    return u
  }

  _forcedBase() { return { state: 'forced', mode: 'auto', version: this.info?.latest, url: this.info?.url, reason: this.info?.reason } }

  _download() {
    if (this.phase !== 'forced' || this.downloaded) return
    this._emit({ ...this._forcedBase(), stage: 'checking' })
    Promise.resolve(this.updater.checkForUpdates()).catch((e) => this._failed(e))
  }

  _failed(e) {
    if (this.phase !== 'forced' || this.downloaded) return
    this._emit({ ...this._forcedBase(), stage: 'error', message: String(e?.message || e).slice(0, 200) })
    this._later(() => this._download(), this.retryMs)
  }

  /** Instala lo descargado y reinicia. */
  install() {
    if (this.updater && this.downloaded) this.updater.quitAndInstall(true, true)
  }

  /** "Volver a comprobar" desde la pantalla de bloqueo: si ya no hace falta, se reinicia la aplicación. */
  async recheck() {
    if (this.phase !== 'forced') return { block: false }
    const r = await this._evaluate()
    if (!r.block) this.relaunch()
    return r
  }
}

module.exports = { UpdateController, fetchLatest }
