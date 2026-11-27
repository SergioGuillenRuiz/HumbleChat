// EXPERIMENTO TEMPORAL: ¿acepta WebRTC un candidato de bucle local / de la IP LAN propia como destino de un proxy UDP?
const { app, BrowserWindow, ipcMain } = require('electron')
const dgram = require('dgram')
const os = require('os')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
const variant = process.env.VARIANT || 'loop'
const addr = variant === 'lan' ? lan[0] || '127.0.0.1' : '127.0.0.1'
function mk() {
  const s = dgram.createSocket('udp4'); const o = { s, addr: null, q: [], peer: null, n: 0 }
  s.on('message', (m, r) => { o.addr = r; o.n++; o.peer.deliver(m); if (o.q.length) { for (const x of o.q.splice(0)) s.send(x, r.port, r.address) } })
  o.deliver = (m) => { if (o.addr) s.send(m, o.addr.port, o.addr.address); else o.q.push(m) }
  return o
}
app.whenReady().then(async () => {
  const A = mk(), B = mk(); A.peer = B; B.peer = A
  await Promise.all([A, B].map((o) => new Promise((r) => o.s.bind(0, addr, r))))
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: true } })
  win.loadFile(__dirname + '/page.html')
  win.webContents.on('console-message', (_e, _l, msg) => console.log('[' + variant + ']', msg))
  ipcMain.handle('ports', () => ({ qa: A.s.address().port, qb: B.s.address().port, addr, lan }))
  ipcMain.on('done', (_e, r) => { console.log('RESULT ' + variant, JSON.stringify(r), 'proxyA', A.n, 'proxyB', B.n); app.exit(0) })
  setTimeout(() => { console.log('TIMEOUT ' + variant); app.exit(0) }, 45000)
})
