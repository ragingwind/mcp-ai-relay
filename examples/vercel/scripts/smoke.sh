#!/usr/bin/env bash
set -u
set -o pipefail

EXAMPLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$EXAMPLE_DIR"

fail=0

# V-1: vercel.json is valid JSON.
echo "[smoke] V-1: vercel.json parses as JSON"
if ! node -e "JSON.parse(require('node:fs').readFileSync('vercel.json','utf8'))"; then
  echo "[smoke] FAIL V-1: vercel.json is not valid JSON"
  fail=1
fi

# V-2: README does not reference dropped APIs.
echo "[smoke] V-2: README has no dropped API references"
README="README.md"
for pattern in "OPENAI_API_KEY" "mcp-ai-relay" "@ragingwind/mcp-ai-relay"; do
  if grep -F -q "${pattern}" "${README}"; then
    echo "[smoke] FAIL V-2: README contains dropped reference '${pattern}'"
    fail=1
  fi
done

# V-3: README references the current SDK surface.
echo "[smoke] V-3: README references current SDK surface"
for required in "ai-relay" "ai-relay/openai" "registerOpenAIChat" "verifyBearer" "loadConfig"; do
  if ! grep -F -q "${required}" "${README}"; then
    echo "[smoke] FAIL V-3: README missing '${required}'"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "[smoke] === FAIL ==="
  exit 1
fi

echo "[smoke] === PASS ==="
