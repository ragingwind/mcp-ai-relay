# app/scripts

Operational tooling that exercises the published shape of the `app/`
Hono runner image (`ghcr.io/ragingwind/ai-relay`).

---

## `docker-smoke.sh`

Self-contained shell smoke test for the distroless runtime image. Verifies
build correctness, runtime invariants, and an image-size budget — meant to
catch regressions before tagging a release. Run it locally before opening
a PR that touches `app/**`, `Dockerfile`, or the deploy bundle layout.

### Local invocation

```bash
pnpm docker:smoke
```

Or directly:

```bash
bash app/scripts/docker-smoke.sh
```

The script auto-skips with `[SKIP] docker not available` when Docker is
absent (no failure exit code), so it is safe to wire into `pnpm test`-style
flows on dev machines without Docker.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `IMAGE_TAG` | `ai-relay:smoke` | Tag used for `docker build` + `docker run`. |
| `DOCKER_SIZE_BUDGET_BYTES` | `157286400` | B-2 budget (default 150 MB). Compared against `docker image inspect Size` (NOT `docker images SIZE`). |
| `DOCKER_SMOKE_MULTIARCH` | unset | Set `=1` to enable B-3 multi-arch buildx. Slow; off by default. |
| `MOCK_PORT` | dynamic | Mock OpenAI fixture port. Auto-picked when unset (the mock prints `LISTENING port=N`). |
| `SMOKE_HOST_PORT` | `18787` | Published host port for the container under test. |

### Assertions

Each assertion logs `[PASS] <id> ...` or `[FAIL] <id> ...` and contributes
to a final `summary: passed=N failed=M` line. Any `[FAIL]` produces a
non-zero exit code.

| ID | What | Notes |
|---|---|---|
| B-1 | `docker build -f app/Dockerfile -t $IMAGE_TAG .` succeeds (single arch). | First failure short-circuits the rest. |
| B-2 | Image content size < `DOCKER_SIZE_BUDGET_BYTES`. | Uses `docker image inspect --format '{{.Size}}'`, NOT the rounded `docker images` SIZE column. |
| B-3 | Multi-arch buildx (linux/amd64 + linux/arm64) succeeds. | Opt-in via `DOCKER_SMOKE_MULTIARCH=1`. Fails loud if buildx is missing while opted in. |
| B-4 | No `.node` native bindings under `/app/node_modules`. | Distroless has no shell — invoked via `node -e`. |
| R-1 | HEALTHCHECK reports `healthy` within 60 s. | Dockerfile sets `--interval=30s --start-period=10s --retries=3`. On timeout, prints last 30 lines of `docker logs`. |
| R-2 | Container `Config.User` is `nonroot` or `65532`. | Distroless symbolizes uid 65532 as `nonroot`. |
| R-3 | `docker exec ... sh -c true` exits non-zero. | Distroless invariant: no shell present. |
| R-4 | `GET /healthz` returns body containing `ok`. | |
| R-5 | `POST /api/mcp` (no bearer) returns 401. | Sends MCP `initialize` JSON-RPC. |
| R-6 | `POST /api/mcp` (with bearer) returns body containing `"protocolVersion"`. | Same `initialize` request. |
| R-7 | `tools/call` for `openai_chat` returns the mock canned reply (`smoke-canned-reply`). | |
| R-8 | `docker stop --time=10` returns within 7 s and exit code is 0 or 143. | 143 = 128 + SIGTERM(15). |
| R-9 | `docker run --rm <image>` with no env vars exits non-zero AND mentions `AI_RELAY_API_KEY` or `AI_RELAY_AUTH_TOKEN`. | Validates the env-validation error path. |

### Adding a new assertion

The script tracks failures with two counters (`PASS_COUNT`, `FAIL_COUNT`)
and helpers `pass "<id> <description>"` / `fail "<id> <description>"`. To
add a new assertion:

1. Pick the next free id (`B-5`, `R-10`, …).
2. Add an `--- <id>: <name> ---` echo banner.
3. Run the check; call `pass` or `fail` based on the outcome.
4. Document the new id in the table above.

The script intentionally runs every assertion (no `set -e`) so the summary
reflects the full picture even when an early assertion fails.

### Cross-platform notes

- `host.docker.internal:host-gateway` works on Linux Docker 20.10+ and
  macOS Docker Desktop. CI uses `ubuntu-latest`, dev typically uses macOS.
- The script avoids GNU-only flags so it runs on both BSD and GNU
  userlands.
