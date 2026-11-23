'use strict'
// Puente mínimo y explícito entre la interfaz y el proceso principal.
const { contextBridge, ipcRenderer } = require('electron')

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args)

contextBridge.exposeInMainWorld('humble', {
  init: call('init'),
  history: call('history'),
  send: call('send'),
  remove: call('remove'),
  setName: call('setName'),
  setVoice: call('setVoice'),
  signal: call('signal'),
  addBlob: call('addBlob'),
  saveBlob: call('saveBlob'),
  listScreens: call('listScreens'),
  chooseScreen: call('chooseScreen'),
  notify: call('notify'),
  diag: call('diag'),
  openExternal: call('openExternal'),
  onMessage: (cb) => ipcRenderer.on('hc', (_e, msg) => cb(msg))
})
