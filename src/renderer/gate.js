// Ventana de arranque cuando la versión instalada es obsoleta: sin red ni chat, solo la actualización.
import { renderGate } from './ui/updategate.js'

const root = document.getElementById('gate')
window.humble.onMessage((m) => { if (m.type === 'update') renderGate(root, m) })
window.humble.updateState().then((m) => renderGate(root, m))
