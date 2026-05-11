#!/usr/bin/env bash
# Real smoke test for the Cloudflare Workers example.
#
# Boots `wrangler dev` on a non-default port, then asserts:
#   1. GET /sse without auth        → HTTP 401 (bearer gate works negatively)
#   2. GET /sse with valid bearer   → HTTP 200 + SSE body containing
#      `event: endpoint` and `/sse/message?sessionId=` (proves the
#      `agents/mcp` McpAgent.serveSSE handler ran AND issued a valid
#      session endpoint, i.e. the MCP server actually handled the request)
#
# Exits 0 only when BOTH assertions hold; ends output with `=== PASS ===`.

set -u
set -o pipefail

EXAMPLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$EXAMPLE_DIR"

PORT="${SMOKE_PORT:-8788}"
URL="http://localhost:${PORT}/sse"
DEV_VARS="${EXAMPLE_DIR}/.dev.vars"
WRANGLER_LOG="$(mktemp -t cf-smoke-wrangler.XXXXXX)"
WRANGLER_PID=""
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  echo "[smoke] FAIL: pnpm or corepack is required"
  exit 1
fi

cleanup() {
  if [ -n "$WRANGLER_PID" ] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    # Wrangler spawns workerd; give it a moment then force-kill stragglers on the port.
    sleep 1
    if command -v lsof >/dev/null 2>&1; then
      pids=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
      if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
      fi
    fi
  fi
  rm -f "$WRANGLER_LOG"
}
trap cleanup EXIT INT TERM

# 1. Ensure .dev.vars exists with a deterministic test token.
if [ ! -f "$DEV_VARS" ]; then
  echo "[smoke] .dev.vars missing, generating one for the test run"
  TEST_TOKEN="$(openssl rand -hex 32)"
  cat >"$DEV_VARS" <<EOF
AI_RELAY_API_KEY="test-key"
AI_RELAY_AUTH_TOKEN="${TEST_TOKEN}"
EOF
fi

TOKEN="$(grep '^AI_RELAY_AUTH_TOKEN=' "$DEV_VARS" | cut -d'"' -f2)"
if [ -z "$TOKEN" ]; then
  echo "[smoke] FAIL: could not read AI_RELAY_AUTH_TOKEN from $DEV_VARS"
  exit 1
fi

# 2. Boot wrangler dev in background.
echo "[smoke] booting wrangler dev on port $PORT (log: $WRANGLER_LOG)"
"${PNPM[@]}" exec wrangler dev --port "$PORT" --ip 127.0.0.1 >"$WRANGLER_LOG" 2>&1 &
WRANGLER_PID=$!

# Poll for readiness up to ~60s.
ready=0
for i in $(seq 1 60); do
  if grep -qE "Ready on http://(localhost|127\.0\.0\.1):${PORT}" "$WRANGLER_LOG" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "[smoke] FAIL: wrangler exited before becoming ready"
    echo "----- wrangler log -----"
    cat "$WRANGLER_LOG"
    exit 1
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "[smoke] FAIL: wrangler did not report Ready within 60s"
  echo "----- wrangler log -----"
  cat "$WRANGLER_LOG"
  exit 1
fi

# Give workerd one more beat to bind the listener.
sleep 1

fail=0

# 3. Assert 1: no-auth → 401.
echo "[smoke] assert 1: GET $URL without auth → expect 401"
NOAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL" || echo "000")
echo "[smoke]   status=$NOAUTH_STATUS"
if [ "$NOAUTH_STATUS" != "401" ]; then
  echo "[smoke] FAIL assert 1: expected 401, got $NOAUTH_STATUS"
  fail=1
fi

# 4. Assert 2: GET /sse with bearer → 200 + SSE body announcing the
#    `/sse/message?sessionId=...` endpoint. `serveSSE("/sse")` from
#    `agents/mcp` opens the stream on GET and emits the endpoint as the
#    first SSE event; receiving it proves the bearer gate accepted the
#    token AND the McpAgent handler ran.
echo "[smoke] assert 2: GET $URL with bearer → expect 200 + SSE 'event: endpoint' /sse/message"
AUTH_BODY_FILE="$(mktemp -t cf-smoke-body.XXXXXX)"
AUTH_STATUS=$(curl -s -N --max-time 5 -o "$AUTH_BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: text/event-stream' \
  "$URL" || true)

# Read at most ~4 KB of the body (SSE stream stays open; we only need
# the first frame which contains the endpoint event).
AUTH_BODY="$(head -c 4096 "$AUTH_BODY_FILE" 2>/dev/null || true)"
rm -f "$AUTH_BODY_FILE"

# curl --max-time exits non-zero (28) on the SSE timeout we expect; the
# response status was already captured before the body stalled. Only
# treat an empty status as a real failure.
if [ -z "$AUTH_STATUS" ]; then
  AUTH_STATUS="000"
fi

echo "[smoke]   status=$AUTH_STATUS"
echo "[smoke]   body (first 4 KB):"
echo "$AUTH_BODY" | sed 's/^/[smoke]     /'

if [ "$AUTH_STATUS" = "401" ]; then
  echo "[smoke] FAIL assert 2: bearer gate rejected a valid token (got 401)"
  fail=1
elif [ "$AUTH_STATUS" != "200" ]; then
  echo "[smoke] FAIL assert 2: expected 200, got $AUTH_STATUS"
  fail=1
fi

case "$AUTH_BODY" in
  *"event: endpoint"*"/sse/message?sessionId="*) ;;
  *)
    echo "[smoke] FAIL assert 2: SSE body did not contain 'event: endpoint' + '/sse/message?sessionId='"
    fail=1
    ;;
esac

if [ "$fail" -ne 0 ]; then
  echo "----- wrangler log (tail) -----"
  tail -n 80 "$WRANGLER_LOG" || true
  echo "[smoke] === FAIL ==="
  exit 1
fi

echo "[smoke] === PASS ==="
