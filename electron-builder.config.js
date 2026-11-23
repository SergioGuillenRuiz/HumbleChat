// Configuración de empaquetado (electron-builder).
//   npm run dist:win     -> instalador .exe (NSIS) y .zip portable
//   npm run dist:linux   -> AppImage y paquete .pacman (CachyOS/Arch)
// El icono y los metadatos del .exe solo se incrustan al compilar EN Windows (en Linux haría falta wine).
module.exports = {
  "appId": "com.humblechat.app",
  "productName": "HumbleChat",
  "executableName": "humblechat",
  "npmRebuild": false,
  "nodeGypRebuild": false,
  "directories": {
    "output": "dist",
    "buildResources": "build"
  },
  "files": [
    "src/**/*",
    "package.json",
    "!src/**/*.map",
    "!**/node_modules/*/prebuilds/{android-*,darwin-*,ios-*,*arm*,*ia32*,*musl*}/**"
  ],
  "extraResources": [
    {
      "from": "group.key",
      "to": "group.key"
    },
    {
      "from": ".",
      "to": ".",
      "filter": ["network.json"]
    }
  ],
  "win": {
    "target": [
      {
        "target": "nsis",
        "arch": [
          "x64"
        ]
      },
      {
        "target": "portable",
        "arch": [
          "x64"
        ]
      },
      {
        "target": "zip",
        "arch": [
          "x64"
        ]
      }
    ],
    "icon": "build/icon.png",
    signAndEditExecutable: process.platform === 'win32',
    "artifactName": "HumbleChat-${version}-win.${ext}"
  },
  "portable": {
    "artifactName": "HumbleChat-${version}-portable.${ext}"
  },
  "nsis": {
    "oneClick": true,
    "perMachine": false,
    "runAfterFinish": true,
    "deleteAppDataOnUninstall": false,
    "artifactName": "HumbleChat-Setup-${version}.${ext}"
  },
  "linux": {
    "target": [
      {
        "target": "AppImage",
        "arch": [
          "x64"
        ]
      },
      {
        "target": "pacman",
        "arch": [
          "x64"
        ]
      }
    ],
    "icon": "build/icon.png",
    "category": "Network;Chat;AudioVideo;",
    "synopsis": "Chat privado de texto y voz",
    "desktop": { "entry": { "StartupWMClass": "humblechat" } },
    "artifactName": "HumbleChat-${version}.${ext}",
    "maintainer": "HumbleChat <noreply@users.noreply.github.com>"
  },
  "appImage": {
    "artifactName": "HumbleChat-${version}-x86_64.${ext}"
  },
  "asarUnpack": [
    "**/*.node"
  ]
}

// ── Ajustes que dependen del modo de compilación ──
const cfg = module.exports
// Compilación pública (HUMBLECHAT_PUBLIC=1): sin llave de sala dentro. Es la que se publica en GitHub; al abrirla
// por primera vez la app pide el código de sala. Las actualizaciones nunca llevan llave (se conserva la del usuario).
if (process.env.HUMBLECHAT_PUBLIC) cfg.extraResources = cfg.extraResources.filter((r) => r.from !== 'group.key')
cfg.publish = [{ provider: 'github', owner: 'SergioGuillenRuiz', repo: 'HumbleChat', releaseType: 'release' }]
