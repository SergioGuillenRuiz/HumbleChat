#!/usr/bin/env bash
# Hook Stop: si hay cambios en código o pruebas sin verificar, ejecuta la verificación rápida.
# Si falla, devuelve el error a Claude (código 2) para que lo corrija antes de dar la tarea por terminada.
cd "$(dirname "$0")/.." || exit 0
input=$(cat)
echo "$input" | grep -q '"stop_hook_active": *true' && { echo "[stop-check] omitido: reintento tras un aviso previo"; exit 0; }   # evita bucles: solo un reintento
changed=$(git status --porcelain -- src test scripts package.json electron-builder.config.js | grep -v -E 'claude-(setup|stop-check)' )
[ -z "$changed" ] && { echo "[stop-check] sin cambios en código ni pruebas: nada que verificar"; exit 0; }
stamp=$(echo "$changed" | git hash-object --stdin; git diff HEAD -- src test scripts package.json 2>/dev/null | git hash-object --stdin)
[ -f .claude/.last-verified ] && [ "$(cat .claude/.last-verified)" = "$stamp" ] && { echo "[stop-check] estos cambios ya estaban verificados"; exit 0; }
if out=$(node scripts/verify.js --quick 2>&1); then
  echo "$stamp" > .claude/.last-verified
  echo "[stop-check] verify:quick OK"
  exit 0
fi
echo "La verificación rápida (npm run verify:quick) ha fallado. Corrígelo antes de terminar:" >&2
echo "$out" | tail -40 >&2
exit 2
