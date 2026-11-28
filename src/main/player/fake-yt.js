'use strict';
// Solo para pruebas (HUMBLECHAT_FAKE_MUSIC): imita la parte de la API del reproductor de YouTube que usa la aplicación, con un
// reloj propio. La primera letra del identificador del vídeo decide cómo se porta:
//   S… dura 6 s   ·   M… dura 20 s   ·   cualquier otra, 240 s   ·   E… da el error 150 (su dueño no permite reproducirlo)
(() => {
  const DURATION = (v) => (v[0] === 'S' ? 6 : v[0] === 'M' ? 20 : 240)
  const players = new Set()

  class Player {
    constructor(_el, o) {
      this.o = o
      this.vol = 100
      this.muted = false
      this.state = -1
      this.base = 0 // posición en el instante `since`
      this.since = Date.now()
      this.v = null
      players.add(this)
      setTimeout(() => {
        this.o.events?.onReady?.({ target: this })
        this._load(o.videoId, o.playerVars?.start || 0, !!o.playerVars?.autoplay)
      }, 50)
      this.timer = setInterval(() => { if (this.state === 1 && this.getCurrentTime() >= this.getDuration()) { this.base = this.getDuration(); this._set(0) } }, 100)
    }

    _set(st) {
      if (st === this.state) return
      this.state = st
      this.o.events?.onStateChange?.({ data: st, target: this })
    }

    _load(v, start, play) {
      this.v = v
      this.base = start
      this.since = Date.now()
      if (v[0] === 'E') { this._set(-1); setTimeout(() => this.o.events?.onError?.({ data: 150, target: this }), 100); return }
      this._set(3)
      setTimeout(() => {
        if (this.v !== v) return
        this.since = Date.now()
        this._set(play ? 1 : 5)
      }, 150)
    }

    loadVideoById(a) { this._load(a.videoId, a.startSeconds || 0, true) }
    cueVideoById(a) { this._load(a.videoId, a.startSeconds || 0, false) }
    playVideo() { if (this.state === 2 || this.state === 5) { this.since = Date.now(); this._set(1) } }
    pauseVideo() { if (this.state === 1 || this.state === 3) { this.base = this.getCurrentTime(); this.since = Date.now(); this._set(2) } }
    seekTo(s) { this.base = Math.min(s, this.getDuration()); this.since = Date.now() }
    stopVideo() { this.v = null; this.base = 0; this._set(-1) }
    getCurrentTime() { return this.state === 1 ? Math.min(this.base + (Date.now() - this.since) / 1000, this.getDuration()) : this.base }
    getDuration() { return this.v ? DURATION(this.v) : 0 }
    getPlayerState() { return this.state }
    getVideoData() { return { video_id: this.v } }
    setVolume(v) { this.vol = v }
    getVolume() { return this.vol }
    mute() { this.muted = true }
    unMute() { this.muted = false }
    isMuted() { return this.muted }
    destroy() { clearInterval(this.timer); players.delete(this) }
  }

  window.YT = {
    Player,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    __nudge: (s) => { for (const p of players) p.base += s } // desvía la posición, para probar la corrección de desfase
  }
  window.onYouTubeIframeAPIReady?.()
})()
