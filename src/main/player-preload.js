'use strict'
// Puente de la ventana del reproductor de «Escuchar juntos»: solo recibe órdenes y devuelve eventos. Nada más.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('playerBridge', {
  onCmd: (cb) => ipcRenderer.on('player:cmd', (_e, c) => cb(c)),
  emit: (evt) => ipcRenderer.send('player:evt', evt)
})
