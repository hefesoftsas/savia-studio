#!/bin/sh

set -eu

api_url="${API_URL:-http://localhost:8787}"

get_api() {
  url="$1"
  attempt=1
  while :; do
    if body="$(curl --fail --silent --max-time 4 -- "$url")"; then
      printf '%s' "$body"
      return 0
    fi

    [ "$attempt" -lt 15 ] || break
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "Could not reach ${url} after ${attempt} attempts" >&2
  return 1
}

matches_json() {
  printf '%s' "$2" | node -e '
    try {
      const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const valid = process.argv[1] === "health"
        ? data?.status === "ok" && data.database === "ok"
        : data?.openapi === "3.1.0" && Boolean(data.paths?.["/health"]);
      process.exitCode = valid ? 0 : 1;
    } catch {
      process.exitCode = 1;
    }
  ' "$1"
}

verify_origin() {
  origin="${1%/}"
  health="$(get_api "${origin}/health")"
  if ! matches_json health "$health"; then
    echo "Expected ${origin}/health to report status: ok and database: ok" >&2
    exit 1
  fi

  openapi="$(get_api "${origin}/openapi.json")"
  if ! matches_json openapi "$openapi"; then
    echo "Expected ${origin}/openapi.json to report OpenAPI 3.1.0 with /health" >&2
    exit 1
  fi

  docs="$(get_api "${origin}/docs")"
  if ! printf '%s' "$docs" | grep -qi "scalar"; then
    echo "Expected ${origin}/docs to include Scalar" >&2
    exit 1
  fi

  printf '%s\n' "$2 verified at ${origin}"
}

verify_origin "$api_url" "Local stack"
if [ -n "${ADMIN_URL:-}" ]; then
  verify_origin "$ADMIN_URL" "Local Admin proxy"
fi
