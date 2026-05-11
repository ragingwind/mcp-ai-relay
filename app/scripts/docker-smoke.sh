#!/usr/bin/env bash
# docker-smoke.sh — committed publish-shape smoke for the app/ Hono runner image.
#
# Verifies build correctness (B-1..B-4) and runtime behavior (R-1..R-9)
# of the distroless image produced by app/Dockerfile. Every assertion is
# reported as `[PASS]` or `[FAIL]` and a non-zero exit code is returned
# when any assertion fails. Multi-arch (B-3) is gated behind
# DOCKER_SMOKE_MULTIARCH=1 because it is slow.
#
# Env vars (defaults shown):
#   IMAGE_TAG=ai-relay:smoke              build/run tag
#   DOCKER_SIZE_BUDGET_BYTES=157286400    image-size guard (150 MB)
#   DOCKER_SMOKE_MULTIARCH=                set =1 to enable B-3
#   MOCK_PORT=                             mock OpenAI port (auto when unset)
#   SMOKE_HOST_PORT=18787                 published host port for the container
#
# host.docker.internal:host-gateway is supported on Linux Docker 20.10+ and
# macOS Docker Desktop — the CI runner (ubuntu-latest) and dev machines both
# satisfy this.
#
# Shell mode: `set -u` only — we deliberately do NOT `set -e` so every
# assertion runs and contributes to the pass/fail summary.

set -u

# ---------------------------------------------------------------------------
# Resolve REPO_ROOT regardless of cwd. The script lives at
# <repo>/app/scripts/docker-smoke.sh.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT"

IMAGE_TAG=${IMAGE_TAG:-ai-relay:smoke}
DOCKER_SIZE_BUDGET_BYTES=${DOCKER_SIZE_BUDGET_BYTES:-$((150 * 1024 * 1024))}
SMOKE_HOST_PORT=${SMOKE_HOST_PORT:-18787}
CONTAINER_NAME=ai-relay-smoke

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "[PASS] $*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "[FAIL] $*"
}

# ---------------------------------------------------------------------------
# Skip path: docker absent → exit 0 with [SKIP] (local-dev fallback).
if ! command -v docker >/dev/null 2>&1; then
  echo "[SKIP] docker not available — install Docker to run this smoke"
  exit 0
fi

# ---------------------------------------------------------------------------
# Cleanup trap: stop+remove container, kill mock pid.
MOCK_PID=""
cleanup() {
  local exit_code=$?
  if [ -n "${MOCK_PID:-}" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup EXIT

# ===========================================================================
# B-1: docker build single-arch
# ===========================================================================
echo "--- B-1: docker build (single arch) ---"
if docker build -f app/Dockerfile -t "$IMAGE_TAG" . ; then
  pass "B-1 docker build single-arch (tag=$IMAGE_TAG)"
else
  fail "B-1 docker build single-arch (tag=$IMAGE_TAG)"
  echo "B-1 failed; remaining assertions will be skipped"
  echo ""
  echo "summary: passed=$PASS_COUNT failed=$FAIL_COUNT"
  exit 1
fi

# ===========================================================================
# B-2: image content size guard
#   docker image inspect Size = uncompressed on-disk content size in bytes.
#   This is NOT the `docker images` SIZE column rounded to MB.
# ===========================================================================
echo "--- B-2: image-size budget ---"
size_bytes=$(docker image inspect --format '{{.Size}}' "$IMAGE_TAG" 2>/dev/null || echo "0")
size_mb=$(( size_bytes / 1024 / 1024 ))
budget_mb=$(( DOCKER_SIZE_BUDGET_BYTES / 1024 / 1024 ))
if [ "$size_bytes" -gt 0 ] && [ "$size_bytes" -lt "$DOCKER_SIZE_BUDGET_BYTES" ]; then
  pass "B-2 image size ${size_mb} MB < ${budget_mb} MB budget (measured via 'docker image inspect Size', NOT 'docker images SIZE')"
else
  fail "B-2 image size ${size_mb} MB exceeds ${budget_mb} MB budget (measured via 'docker image inspect Size' = ${size_bytes} bytes; compare against DOCKER_SIZE_BUDGET_BYTES=${DOCKER_SIZE_BUDGET_BYTES})"
fi

# ===========================================================================
# B-3: multi-arch buildx (linux/amd64 + linux/arm64) — opt-in
# ===========================================================================
if [ "${DOCKER_SMOKE_MULTIARCH:-}" = "1" ]; then
  echo "--- B-3: multi-arch buildx (DOCKER_SMOKE_MULTIARCH=1) ---"
  if ! docker buildx version >/dev/null 2>&1; then
    fail "B-3 multi-arch build — docker buildx is unavailable"
  elif docker buildx build --platform linux/amd64,linux/arm64 -f app/Dockerfile . ; then
    pass "B-3 multi-arch build (linux/amd64,linux/arm64)"
  else
    fail "B-3 multi-arch build (linux/amd64,linux/arm64)"
  fi
else
  echo "--- B-3: multi-arch buildx — skipped (set DOCKER_SMOKE_MULTIARCH=1 to enable) ---"
fi

# ===========================================================================
# B-4: no native bindings (.node) in the deploy bundle
#   Distroless has no shell — invoke node directly.
# ===========================================================================
echo "--- B-4: no native .node bindings in /app/node_modules ---"
native_out=$(docker run --rm --entrypoint=/nodejs/bin/node "$IMAGE_TAG" -e "import('node:fs').then(fs=>{const out=fs.readdirSync('/app/node_modules',{recursive:true,withFileTypes:true}).filter(d=>d.isFile()&&d.name.endsWith('.node')).map(d=>d.parentPath+'/'+d.name);process.stdout.write(out.join('\\n'));process.exit(out.length?1:0);})" 2>&1)
native_rc=$?
if [ "$native_rc" -eq 0 ]; then
  pass "B-4 no .node native bindings under /app/node_modules"
else
  fail "B-4 found .node native bindings under /app/node_modules:"
  echo "$native_out" | sed 's/^/        /'
fi

# ===========================================================================
# Mock OpenAI fixture launch
# ===========================================================================
echo "--- launching mock OpenAI fixture ---"
mock_log=$(mktemp -t ai-relay-mock.XXXXXX)
node tests/fixtures/mock-openai/server.mjs --port="${MOCK_PORT:-0}" >"$mock_log" 2>&1 &
MOCK_PID=$!
# Wait up to 5s for the LISTENING line.
mock_port=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if grep -q '^LISTENING port=' "$mock_log" 2>/dev/null; then
    mock_port=$(sed -n 's/^LISTENING port=\([0-9]*\).*/\1/p' "$mock_log" | head -n1)
    break
  fi
  sleep 0.5
done
if [ -z "$mock_port" ]; then
  fail "mock OpenAI fixture failed to start within 5s; mock log:"
  sed 's/^/        /' "$mock_log"
  echo ""
  echo "summary: passed=$PASS_COUNT failed=$FAIL_COUNT"
  exit 1
fi
echo "mock OpenAI listening on 127.0.0.1:${mock_port} (pid=${MOCK_PID})"

# ===========================================================================
# Container launch
# ===========================================================================
echo "--- launching container ---"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
SMOKE_BEARER=$(printf 'x%.0s' $(seq 1 32))
if ! docker run -d \
  --name="$CONTAINER_NAME" \
  -e AI_RELAY_API_KEY=smoke-key \
  -e AI_RELAY_AUTH_TOKEN="$SMOKE_BEARER" \
  -e AI_RELAY_BASE_URL="http://host.docker.internal:${mock_port}/v1" \
  --add-host=host.docker.internal:host-gateway \
  -p "${SMOKE_HOST_PORT}:8787" \
  "$IMAGE_TAG" >/dev/null ; then
  fail "container failed to launch"
  echo ""
  echo "summary: passed=$PASS_COUNT failed=$FAIL_COUNT"
  exit 1
fi

# ===========================================================================
# R-1: HEALTHCHECK reaches healthy within 60s
#   Dockerfile config: --interval=30s --start-period=10s --retries=3
# ===========================================================================
echo "--- R-1: HEALTHCHECK -> healthy within 60s ---"
healthy=0
for _ in $(seq 1 60); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "missing")
  if [ "$status" = "healthy" ]; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -eq 1 ]; then
  pass "R-1 container reported healthy"
else
  fail "R-1 container did not reach healthy within 60s (last status=$status)"
  echo "        last 30 lines of docker logs:"
  docker logs --tail 30 "$CONTAINER_NAME" 2>&1 | sed 's/^/        /'
fi

# ===========================================================================
# R-2: container runs as nonroot (uid 65532)
# ===========================================================================
echo "--- R-2: container User = nonroot / 65532 ---"
user=$(docker inspect --format '{{.Config.User}}' "$CONTAINER_NAME" 2>/dev/null || echo "")
case "$user" in
  nonroot|65532)
    pass "R-2 container User=$user"
    ;;
  *)
    fail "R-2 expected nonroot or 65532, got '$user'"
    ;;
esac

# ===========================================================================
# R-3: distroless invariant — no shell present
# ===========================================================================
echo "--- R-3: no shell in container (distroless invariant) ---"
if docker exec "$CONTAINER_NAME" sh -c true >/dev/null 2>&1; then
  fail "R-3 container has a shell (sh -c true succeeded) — image is not distroless"
else
  pass "R-3 no shell available in container"
fi

# ===========================================================================
# R-4: GET /healthz -> 200 ok
# ===========================================================================
echo "--- R-4: GET /healthz -> 200 ok ---"
healthz_body=$(curl -fsS "http://localhost:${SMOKE_HOST_PORT}/healthz" 2>&1 || true)
if echo "$healthz_body" | grep -q "ok"; then
  pass "R-4 /healthz returned body containing 'ok'"
else
  fail "R-4 /healthz response did not contain 'ok' (got: $healthz_body)"
fi

# ===========================================================================
# R-5: POST /api/mcp without bearer -> 401
# ===========================================================================
echo "--- R-5: POST /api/mcp without bearer -> 401 ---"
init_body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
unauth_code=$(curl -s -o /dev/null -w '%{http_code}' \
  "http://localhost:${SMOKE_HOST_PORT}/api/mcp" \
  -X POST \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d "$init_body")
if [ "$unauth_code" = "401" ]; then
  pass "R-5 unauthenticated initialize -> 401"
else
  fail "R-5 expected 401 without bearer, got $unauth_code"
fi

# ===========================================================================
# R-6: POST /api/mcp with bearer -> 200 + protocolVersion
# ===========================================================================
echo "--- R-6: POST /api/mcp initialize with bearer -> 200 + protocolVersion ---"
# mcp-handler v1.1+ uses Streamable HTTP — the response sets a
# Mcp-Session-Id header that subsequent requests (R-7) MUST echo back.
# We capture the headers via `-D` so the session id propagates to R-7.
init_headers=$(mktemp)
init_resp=$(curl -s -D "$init_headers" \
  "http://localhost:${SMOKE_HOST_PORT}/api/mcp" \
  -X POST \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer ${SMOKE_BEARER}" \
  -d "$init_body")
SESSION_ID=$(grep -i '^Mcp-Session-Id:' "$init_headers" | awk '{print $2}' | tr -d '\r\n')
rm -f "$init_headers"
if echo "$init_resp" | grep -q '"protocolVersion"'; then
  pass "R-6 authenticated initialize returned protocolVersion"
else
  fail "R-6 authenticated initialize did not return protocolVersion"
fi

# ===========================================================================
# R-7: tools/call openai_chat -> mock canned reply present
# ===========================================================================
echo "--- R-7: tools/call openai_chat -> canned reply ---"
call_body='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"openai_chat","arguments":{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}}}'
# Mcp-Session-Id is required for stateful MCP transport — without it the
# server treats this as an out-of-session request and returns no result.
call_resp=$(curl -s \
  "http://localhost:${SMOKE_HOST_PORT}/api/mcp" \
  -X POST \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer ${SMOKE_BEARER}" \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
  -d "$call_body")
if echo "$call_resp" | grep -q "smoke-canned-reply"; then
  pass "R-7 tools/call returned mock canned reply"
else
  fail "R-7 tools/call did not return canned reply"
fi

# ===========================================================================
# R-8: graceful shutdown — docker stop returns within 7s with exit 0 or 143
# ===========================================================================
echo "--- R-8: docker stop -> graceful exit within 7s ---"
stop_start=$(date +%s)
docker stop --time=10 "$CONTAINER_NAME" >/dev/null 2>&1 || true
stop_end=$(date +%s)
stop_elapsed=$(( stop_end - stop_start ))
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo "missing")
if [ "$stop_elapsed" -lt 7 ] && { [ "$exit_code" = "0" ] || [ "$exit_code" = "143" ]; }; then
  pass "R-8 graceful stop in ${stop_elapsed}s (exit=${exit_code})"
else
  fail "R-8 stop took ${stop_elapsed}s, exit=${exit_code} (expected <7s and exit 0 or 143)"
fi

# ===========================================================================
# R-9: missing required env vars -> non-zero exit + actionable error
# ===========================================================================
echo "--- R-9: missing env -> non-zero exit + mentions AI_RELAY_API_KEY/AI_RELAY_AUTH_TOKEN ---"
# Capture both stdout+stderr AND the docker run exit code without piping to
# `head` — a pipeline's $? is the rightmost command's exit, which would
# always be 0 from `head`. Truncate after the fact with parameter expansion.
env_out=$(docker run --rm "$IMAGE_TAG" 2>&1)
env_rc=$?
env_out_head=$(printf '%s\n' "$env_out" | head -20)
if [ "$env_rc" -ne 0 ] && printf '%s' "$env_out" | grep -qE "AI_RELAY_API_KEY|AI_RELAY_AUTH_TOKEN"; then
  pass "R-9 missing env -> exit $env_rc and error mentions required key(s)"
else
  fail "R-9 missing env: exit=$env_rc, output:"
  printf '%s\n' "$env_out_head" | sed 's/^/        /'
fi

# ===========================================================================
# Summary
# ===========================================================================
echo ""
echo "summary: passed=$PASS_COUNT failed=$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
