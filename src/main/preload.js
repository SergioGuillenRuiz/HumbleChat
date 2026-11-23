'use strict'
// Puente mínimo y explícito entre la interfaz y el proceso principal.
const { contextBridge, ipcRenderer } = require('electron')

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args)

contextBridge.exposeInMainWorld('humble', {
  init: call('init'),
  history: call('history'),
  send: call('send'),
  remove: call('remove'),
  edit: call('edit'),
  react: call('react'),
  typing: call('typing'),
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
  roomInfo: call('room:info'),
  roomJoin: call('room:join'),
  roomCreate: call('room:create'),
  setSettings: call('settings:set'),
  badge: call('badge'),
  updateInstall: call('update:install'),
  updateCheck: call('update:check'),
  onMessage: (cb) => ipcRenderer.on('hc', (_e, msg) => cb(msg))
})
