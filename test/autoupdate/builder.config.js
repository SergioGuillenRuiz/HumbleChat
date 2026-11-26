'use strict'
// Configuración de electron-builder SOLO para la prueba de autoactualización: una AppImage con la versión y el
// servidor de actualizaciones (genérico, local) que indiquen las variables de entorno. No publica nada.
const base = require('../../electron-builder.config.js')
module.exports = {
  ...base,
  directories: { ...base.directories, output: process.env.AU_OUT },
  extraMetadata: { version: process.env.AU_VERSION },
  linux: { ...base.linux, target: [{ target: 'AppImage', arch: ['x64'] }] },
  publish: [{ provider: 'generic', url: process.env.AU_FEED }]
}
