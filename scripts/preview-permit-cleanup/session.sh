#!/usr/bin/env bash
set -euo pipefail
umask 077
session=$(mktemp -d "$RUNNER_TEMP/preview-permit-session.XXXXXXXX")
node scripts/preview-permit-cleanup/run.mjs configure "$session/worker.json" "$session/session.json"
pid=
deployed=false
cleanup() {
  if [ -n "$pid" ]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [ "$deployed" = true ]; then
    if ! pnpm --dir apps/api exec wrangler delete --config "$session/worker.json" --force >"$session/delete.log" 2>&1; then
      echo "Temporary Preview repair Worker cleanup failed" >&2
      return 1
    fi
  fi
  rm -rf "$session"
}
trap cleanup EXIT
if ! pnpm --dir apps/api exec wrangler deploy --config "$session/worker.json" >"$session/deploy.log" 2>&1; then
  echo "Temporary Preview repair Worker could not be deployed" >&2
  exit 1
fi
deployed=true
setsid pnpm --dir apps/api exec wrangler dev --remote --config "$session/session.json" \
  --ip 127.0.0.1 --port 18877 --inspector-port 0 --show-interactive-dev-session=false \
  >"$session/wrangler.log" 2>&1 &
pid=$!
node scripts/preview-permit-cleanup/run.mjs "${1:?}" "$RUNNER_TEMP/preview-permits.json" "$session/worker.json"
