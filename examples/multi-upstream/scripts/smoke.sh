#!/usr/bin/env bash
set -u
set -o pipefail

EXAMPLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "${EXAMPLE_DIR}/scripts/smoke.mjs"
