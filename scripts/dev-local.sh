#!/bin/sh

set -eu

load_environment_file() {
  if [ -f "$1" ]; then
    . "$1"
  fi
}

secrets_directory="${SAVIA_SECRETS_DIR:-infra/secrets}"
export SAVIA_FLOWS_ENABLED="${SAVIA_FLOWS_ENABLED:-1}"
export WRANGLER_REGISTRY_PATH="${WRANGLER_REGISTRY_PATH:-$PWD/.wrangler/savia-local-dev-registry}"
load_environment_file "$secrets_directory/auth.dev.env"
load_environment_file "$secrets_directory/assistant-api.dev.env"
load_environment_file "$secrets_directory/mcp.dev.env"
load_environment_file "$secrets_directory/connector-gateway.dev.env"

export SAVIA_MCP_URL="${SAVIA_MCP_URL:-http://127.0.0.1:8789/mcp}"

processes=""

start_process() {
  service="$1"
  shift
  "$@" &
  processes="$processes $!:$service"
}

stop_processes() {
  trap - EXIT HUP INT TERM
  for process in $processes; do
    kill "${process%%:*}" 2>/dev/null || true
  done
  for process in $processes; do
    wait "${process%%:*}" 2>/dev/null || true
  done
}

check_processes() {
  remaining=""
  exit_status=0
  for process in $processes; do
    pid="${process%%:*}"
    if kill -0 "$pid" 2>/dev/null; then
      remaining="$remaining $process"
    else
      if wait "$pid"; then
        printf 'Local Savia %s exited unexpectedly with status 0.\n' "${process#*:}" >&2
        status=1
      else
        status=$?
        printf 'Local Savia %s exited with status %s.\n' "${process#*:}" "$status" >&2
      fi
      if [ "$exit_status" -eq 0 ]; then
        exit_status="$status"
      fi
    fi
  done
  processes="$remaining"
  return "$exit_status"
}

wait_for_service() {
  attempts=0
  while :; do
    if service_response="$(curl --fail --silent --max-time 2 "$2")" &&
      { [ "$#" -eq 2 ] || "$3" "$service_response"; }; then
      return 0
    fi
    check_processes
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 100 ]; then
      printf 'Local Savia %s did not become ready.\n' "$1" >&2
      return 1
    fi
    sleep 0.1
  done
}

api_is_ready() {
  node -e '
    try {
      const health = JSON.parse(process.argv[1]);
      process.exitCode = health?.status === "ok" && health.database === "ok" ? 0 : 1;
    } catch {
      process.exitCode = 1;
    }
  ' -- "$1"
}

select_admin_port() {
  if [ -n "${SAVIA_ADMIN_PORT:-}" ]; then
    printf '%s\n' "$SAVIA_ADMIN_PORT"
    return
  fi

  port=5173
  while lsof -nP -sTCP:LISTEN -iTCP:"$port" >/dev/null 2>&1; do
    port=$((port + 1))
  done
  printf '%s\n' "$port"
}

require_free_port() {
  if lsof -nP -sTCP:LISTEN -iTCP:"$1" >/dev/null 2>&1; then
    printf 'Local Savia port %s is already in use. Stop the existing service before starting another stack.\n' "$1" >&2
    exit 1
  fi
}

trap stop_processes EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

admin_port="$(select_admin_port)"
admin_origin="http://127.0.0.1:$admin_port"

backend_ports="8787 8788 8797 8798 9230 9232 9233 9234"
if [ "$SAVIA_FLOWS_ENABLED" = "1" ]; then
  backend_ports="$backend_ports 8796"
fi
if [ -n "${SAVIA_MCP_SHARED_SECRET:-}" ]; then
  backend_ports="$backend_ports 8789"
fi
for backend_port in $backend_ports; do
  if [ "$admin_port" = "$backend_port" ]; then
    printf 'Admin port %s is reserved for a local Savia backend.\n' "$admin_port" >&2
    exit 1
  fi
  require_free_port "$backend_port"
done
require_free_port "$admin_port"

pnpm --filter @savia/admin run build:downloads

CI=1 pnpm --filter @savia/api exec wrangler d1 migrations apply savia-agencies \
  --local --config wrangler.jsonc

pnpm --filter @savia/request run setup:local
CI=1 pnpm --filter @savia/request run migrate:local

if [ "$SAVIA_FLOWS_ENABLED" = "1" ]; then
  pnpm flows:build
fi

set -- pnpm --filter @savia/auth exec wrangler dev --local \
  --ip 127.0.0.1 --port 8788 --inspector-port 9230 \
  --config wrangler.jsonc \
  --var "SAVIA_ADMIN_REDIRECT_URI:$admin_origin/auth/callback"

if [ -n "${BETTER_AUTH_SECRET:-}" ]; then
  set -- "$@" --var "BETTER_AUTH_SECRET:$BETTER_AUTH_SECRET"
fi

if [ -n "${SAVIA_INTERNAL_BRIDGE_KEY:-}" ]; then
  identity_bridge_key="$SAVIA_INTERNAL_BRIDGE_KEY"
elif [ -n "${SAVIA_MCP_SHARED_SECRET:-}" ]; then
  identity_bridge_key="$(node -e 'const { createHmac } = require("node:crypto"); process.stdout.write(createHmac("sha256", process.argv[1].trim()).update("savia:auth-tenant-user-administration:v1").digest("hex"))' "$SAVIA_MCP_SHARED_SECRET")"
else
  identity_bridge_key="$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')"
fi
set -- "$@" --var "SAVIA_INTERNAL_BRIDGE_KEY:$identity_bridge_key"

# Local defaults deliver into Mailpit. Explicit SMTP values in auth.dev.env
# override these; credentials remain in the backend process.
smtp_default_port=465
smtp_default_security=tls
smtp_default_insecure=false
if [ -z "${SAVIA_SMTP_HOST:-}" ]; then
  smtp_default_port=1025
  smtp_default_security=plain
  smtp_default_insecure=true
fi
set -- "$@" \
  --var "SAVIA_SMTP_HOST:${SAVIA_SMTP_HOST:-127.0.0.1}" \
  --var "SAVIA_SMTP_PORT:${SAVIA_SMTP_PORT:-$smtp_default_port}" \
  --var "SAVIA_SMTP_FROM:${SAVIA_SMTP_FROM:-no-reply@savia.test}" \
  --var "SAVIA_SMTP_SECURITY:${SAVIA_SMTP_SECURITY:-$smtp_default_security}" \
  --var "SAVIA_SMTP_ALLOW_INSECURE:${SAVIA_SMTP_ALLOW_INSECURE:-$smtp_default_insecure}"
if [ -n "${SAVIA_SMTP_USERNAME:-}" ]; then
  set -- "$@" --var "SAVIA_SMTP_USERNAME:$SAVIA_SMTP_USERNAME"
fi
if [ -n "${SAVIA_SMTP_PASSWORD:-}" ]; then
  set -- "$@" --var "SAVIA_SMTP_PASSWORD:$SAVIA_SMTP_PASSWORD"
fi

start_process Auth "$@"
wait_for_service Auth http://127.0.0.1:8788/_internal/session

if [ -n "${SAVIA_MCP_SHARED_SECRET:-}" ]; then
  start_process MCP env -i PATH="$PATH" HOME="${HOME:-}" TMPDIR="${TMPDIR:-/tmp}" \
    MCP_TRANSPORT=http MCP_HOST=127.0.0.1 MCP_PORT=8789 \
    SAVIA_API_URL=http://127.0.0.1:8787 \
    SAVIA_MCP_SHARED_SECRET="$SAVIA_MCP_SHARED_SECRET" \
    pnpm --filter @savia/mcp start
fi

start_process Hook-Executor pnpm --filter @savia/hook-executor exec wrangler dev --local \
  --ip 127.0.0.1 --port 8798 --inspector-port 9233 --config wrangler.jsonc
start_process Request pnpm --filter @savia/request exec wrangler dev --local \
  --ip 127.0.0.1 --port 8797 --inspector-port 9232 --config wrangler.jsonc

if [ "$SAVIA_FLOWS_ENABLED" = "1" ]; then
  start_process Flows env "SAVIA_FLOWS_PUBLIC_ORIGIN=$admin_origin" pnpm flows:dev
  wait_for_service Flows http://127.0.0.1:8796/health
fi

start_process API env "SAVIA_PUBLIC_ORIGIN=$admin_origin" "SAVIA_INTERNAL_BRIDGE_KEY=$identity_bridge_key" "SAVIA_DISABLE_CAPTCHA=1" "SAVIA_MOCK_QUOTES=${SAVIA_MOCK_QUOTES:-1}" pnpm exec node scripts/dev-api-runtime.mjs
wait_for_service API http://127.0.0.1:8787/health api_is_ready
start_process Admin env SAVIA_DEV_USE_LOCAL_API=true \
  pnpm --filter @savia/admin exec vite --host "${SAVIA_DEV_HOST:-127.0.0.1}" \
  --port "$admin_port" --strictPort

while [ -n "$processes" ]; do
  check_processes
  if [ -n "$processes" ]; then sleep 0.2; fi
done
