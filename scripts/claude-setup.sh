#!/usr/bin/env bash
# Hook SessionStart: deja el entorno listo para probar (dependencias, binario de Electron, Xvfb). Idempotente.
cd "$(dirname "$0")/.." || exit 0
[ -d node_modules/playwright ] && [ -d node_modules/electron ] || npm ci --no-audit --no-fund >&2 || { echo "npm ci falló" >&2; exit 0; }
[ -f node_modules/electron/path.txt ] && [ -d node_modules/electron/dist ] || node node_modules/electron/install.js >&2 || true
if [ "$(uname)" = Linux ] && ! command -v xvfb-run >/dev/null 2>&1; then
  (apt-get update -qq && apt-get install -y -qq xvfb) >&2 || echo "No se pudo instalar xvfb: las pruebas con interfaz fallarán" >&2
fi
exit 0
