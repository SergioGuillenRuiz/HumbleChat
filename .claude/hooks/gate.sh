#!/usr/bin/env bash
# Hook PreToolUse (Bash): npm test antes de git commit; prueba de humo antes de git push.
# Salida 2 = bloquea la acción y devuelve el motivo a Claude.
cmd=$(jq -r '.tool_input.command // ""')
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if echo "$cmd" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+commit([[:space:]]|$)'; then
  if ! out=$(npm test 2>&1); then echo "npm test falla; commit bloqueado:" >&2; echo "$out" | tail -40 >&2; exit 2; fi
elif echo "$cmd" | grep -Eq '(^|[;&|[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
  if command -v xvfb-run >/dev/null && [ -z "$DISPLAY" ]; then run=(xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:smoke); else run=(npm run test:smoke); fi
  if ! out=$("${run[@]}" 2>&1); then echo "La prueba de humo falla; push bloqueado:" >&2; echo "$out" | tail -40 >&2; exit 2; fi
fi
exit 0
