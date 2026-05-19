# DEPLOY — mcp-ai-relay

> 한국어: [DEPLOY.ko.md](./DEPLOY.ko.md)

This runbook covers v1 deployment. The canonical surface is **Docker**
(`ghcr.io/ragingwind/ai-relay`, multi-arch amd64/arm64). A
**Vercel** recipe lives in [`examples/vercel/`](../examples/vercel/) and is
community-supported (no first-party CI for that path). Architecture
decisions live in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§5 directory,
§6 container release, §7 env vars, §9 security). Coding rules live in
[`../CLAUDE.md`](../CLAUDE.md).

---

## 1. Prerequisites

Universal:
- An OpenAI (or OpenAI-compatible) API key.
- A 32+ byte bearer token: `openssl rand -hex 32`.
- The repository cloned: `git clone https://github.com/ragingwind/mcp-ai-relay.git`.

For **Docker** (canonical):
- Docker `^24` (Compose v2 plugin included by default).
- A reverse proxy / load balancer if exposing publicly (handles TLS and
  long-running request timeouts).
- For multi-key isolation: distinct OpenAI projects per environment
  (Production + Staging) with hard usage caps configured per §2.

For **Vercel** (community-supported, see [`examples/vercel/README.md`](../examples/vercel/README.md)):
- A Vercel account (Pro plan recommended — needed for `maxDuration: 300`).
- A separate Next.js project that consumes `ai-relay` from npm — this
  repository is not a Next.js app.
- Two OpenAI projects (Production + Preview), each with its own key.
- Vercel CLI: `npm i -g vercel` (or `pnpm dlx vercel ...`).

For **Embed via SDK** (host the capability inside your own MCP server —
Cloudflare Workers, raw stdio for Claude Desktop, Hono, Express, etc.):
- `npm install ai-relay @modelcontextprotocol/sdk openai`.
- Full API + runtime-specific recipes (Vercel/Next.js, stdio,
  Cloudflare Workers, multi-upstream): [`packages/ai-relay/README.md`](../packages/ai-relay/README.md).
- Operations (rotation + troubleshooting) below still apply at the env
  level; deployment surface is whatever your MCP server ships on.

---

## 2. OpenAI hard usage cap (MANDATORY)

**v1 has no rate limiting or budget counters.** The OpenAI hard usage cap is
the only line of defense if `AI_RELAY_AUTH_TOKEN` leaks. Set it before exposing
the relay anywhere — Docker or Vercel.

For each OpenAI project key:

1. Open the [OpenAI dashboard → Settings → Billing → Limits](https://platform.openai.com/account/limits).
2. Switch to the project (top-left selector).
3. Set **Hard limit** to your monthly tolerance (e.g., `$10` for Preview).
4. Set **Soft limit** lower (e.g., 50% of hard) for an early-warning email.

The v2 plan to add per-relay rate limiting is in
[`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-future-work-v2-backlog).

---

## 3. Docker (canonical)

The canonical artifact is the multi-arch Docker image
`ghcr.io/ragingwind/ai-relay` (amd64 + arm64), built and pushed by
[`.github/workflows/release-app.yml`](../.github/workflows/release-app.yml)
on every `v*` tag.

The image is a `node:20-alpine` runtime (digest-pinned for supply-chain
stability) running the Hono server as a non-root user (UID 1001) with a
Node `fetch` HEALTHCHECK against `/healthz`.

> **Timeouts are the operator's responsibility.** Configure your reverse
> proxy / load balancer to allow long-running requests; 300 s is a
> reasonable starting value (matching the Vercel function ceiling for
> parity).

### 3.1 First-time ghcr setup (maintainer, one-time)

After cloning a fork or forking the workflow into a new repo:

1. **Settings → Actions → General → Workflow permissions**: select
   "Read and write permissions" + "Allow GitHub Actions to create and
   approve pull requests".
2. Cut the first tag — e.g.: `git tag v0.2.0-rc.0 && git push --tags`.
3. The `release-app` workflow runs; verify in **Actions → release-app**.
4. **Settings → Packages → ai-relay** appears once the first push lands;
   change visibility to **Public** if you want anonymous `docker pull`.
   Default is Private (org members only).

### 3.2 Compose (recommended)

```bash
cp .env.example .env.local         # then fill AI_RELAY_API_KEY + AI_RELAY_AUTH_TOKEN
docker compose up -d               # pulls ghcr image and starts
```

The relay is reachable at `http://localhost:8787/api/mcp` and a liveness
endpoint at `http://localhost:8787/healthz`. `restart: unless-stopped`
keeps it running across reboots.

**Host port override:**

```bash
HOST_PORT=9876 docker compose up -d   # → http://localhost:9876/api/mcp
```

The container always listens on `8787` internally (matches `AI_RELAY_PORT`
default) — only the host-side mapping changes.

**Local-build path (development):**

```bash
docker compose -f compose.dev.yml up --build
```

Uses `app/Dockerfile` from the repo. Useful when iterating on the server
locally; production users should pull the published image instead.

**Lifecycle:**

```bash
docker compose up -d                  # pull + start (detached)
docker compose ps                     # status + health
docker compose logs -f relay          # follow logs
docker compose down                   # stop and remove
docker compose pull && docker compose up -d   # update to latest tag
```

`compose.yml` reads `.env.local` via `env_file:` and forwards every key
into the container's process env. Same env contract as raw `docker run`
(§3.3).

> Compose does NOT replace the production runbook. For multi-host or
> managed orchestration use Kubernetes / a PaaS — `compose.yml` is for
> single-host self-hosting and local development.

### 3.3 Raw `docker run`

```bash
docker run --rm -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e AI_RELAY_MODEL=gpt-4o-mini \
  -e AI_RELAY_BASE_URL=https://your-gateway.example.com/v1 \
  -e AI_RELAY_TEMPERATURE=0.7 \
  -e AI_RELAY_MAX_TOKENS=4096 \
  -e AI_RELAY_REQUEST_TIMEOUT_MS=60000 \
  ghcr.io/ragingwind/ai-relay:latest
```

Or with `--env-file`:

```bash
docker run --rm -p 8787:8787 --env-file .env.production ghcr.io/ragingwind/ai-relay:latest
```

`AI_RELAY_API_KEY`, `AI_RELAY_AUTH_TOKEN`, and `AI_RELAY_MODEL` are required.
The remaining keys (including `AI_RELAY_PORT`, `AI_RELAY_TEMPERATURE`,
`AI_RELAY_TOP_P`, `AI_RELAY_STOP`) are optional — see
[`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-environment-variables) for
defaults.

> The caller-facing MCP tool input does not accept `model` / sampling
> parameters. Configure them per server instance via the `AI_RELAY_*` env
> vars above. `AI_RELAY_MAX_TOKENS` is forwarded as-is on every upstream call.

### 3.4 Verification checklist

**Before deploying, run `pnpm docker:smoke`** to verify build correctness,
runtime health, distroless invariants (no shell, non-root uid 65532), and
the image-size budget. The harness exits non-zero on any regression — see
[`app/scripts/README.md`](../app/scripts/README.md) for the assertion
catalog and tunable env vars (image tag, size budget, multi-arch opt-in).

- [ ] `docker compose up -d` (or `docker run`) starts without error.
- [ ] HEALTHCHECK reports healthy within ~30 s of start:
      ```bash
      docker inspect --format '{{.State.Health.Status}}' <container>
      ```
      The check hits `GET /healthz` and exits 0 on `200 ok`.
- [ ] Liveness:
      ```bash
      curl -i http://localhost:8787/healthz
      ```
      Expect `HTTP/1.1 200 OK` + body `ok`.
- [ ] Bearer required:
      ```bash
      curl -i http://localhost:8787/api/mcp
      ```
      Expect `HTTP/1.1 401` + `WWW-Authenticate: Bearer ...` header.
- [ ] Tool list:
      ```bash
      pnpm inspect --url=http://localhost:8787/api/mcp --method=tools/list
      ```
      Expect a single tool named `chat-completions`. For the full pre-PR
      procedure (C1–C6) see [`QA-MCP-INSPECTOR.md`](./QA-MCP-INSPECTOR.md).
- [ ] OpenAI dashboard → **Usage** shows the call recorded against the
      prod project (proves the right key is wired).

### 3.5 Confirm no secrets baked in

```bash
docker history ghcr.io/ragingwind/ai-relay:latest --no-trunc \
  | grep -iE 'AI_RELAY_API_KEY|AI_RELAY_AUTH_TOKEN'
```

Should return nothing — the image build never reads real credentials, and
runtime values are injected via `env_file` / `-e` only.

### 3.6 Anthropic provider (stdio bin only)

The HTTP container above is OpenAI-only in v1. To use the Anthropic Messages
provider, launch the stdio bin directly with provider-scoped env:

```bash
export AI_RELAY_API_KEY=sk-ant-...          # Anthropic API key
export AI_RELAY_MODEL=claude-sonnet-4-6     # Anthropic model id (required)
export AI_RELAY_MAX_TOKENS=1024             # required by Anthropic per call
export AI_RELAY_TEMPERATURE=0.7             # optional, range 0..1 (not 0..2)
ai-relay anthropic                          # stdio MCP server
```

Wire it into Claude Desktop / Claude Code via `.mcp.json` like any other
stdio server. The HTTP `/api/mcp` route in `app/` stays single-provider
(OpenAI) for v1 — multi-provider HTTP is tracked separately.

---

## 4. Vercel (community-supported)

This repository is not a Next.js app. To deploy on Vercel, build a
thin Next.js project that consumes `ai-relay` from npm. The recipe lives
at [`examples/vercel/README.md`](../examples/vercel/README.md) — copy the
`vercel.json` from that directory into your own project and follow the
template route handler shown in the README.

The Vercel target is not covered by this repository's CI or release
pipeline. Treat it as a reference deployment.

---

## 5. Operations

### 5.1 Rotate `AI_RELAY_AUTH_TOKEN`

Run when:
- A token is suspected leaked.
- A team member with token access leaves.
- Routine rotation (recommended every 90 days).

**Docker:**

1. Generate a new token: `openssl rand -hex 32`.
2. Update `.env.local` (or your secrets manager).
3. `docker compose up -d --force-recreate` (or restart the container).

**Vercel (community recipe):**

```bash
openssl rand -hex 32                              # generate
vercel env rm AI_RELAY_AUTH_TOKEN production      # replace
vercel env add AI_RELAY_AUTH_TOKEN production --sensitive
vercel deploy --prod                              # apply
```

After either path:

4. Update every MCP client (Claude Code, Claude Desktop Connectors,
   `.mcp.json` files) with the new bearer token.
5. Verify with `pnpm inspect` or MCP Inspector that the new token works
   **and** the old one does not.
6. Audit OpenAI dashboard usage for any anomaly during the suspected-leak
   window.

> **Vercel: repeat the procedure for Preview** if rotating the Preview
> token. Production and Preview have independent tokens.

### 5.2 Rotate `AI_RELAY_API_KEY`

Identical to §5.1 (replace + redeploy / restart). Additionally:

1. **Revoke the old key** in the OpenAI dashboard (otherwise it remains
   valid).
2. **Confirm the hard usage cap** is still set on the new key (caps are
   per-key).
3. Re-run the verification checklist (§3.4 for Docker; the Vercel recipe
   has its own checklist in `examples/vercel/README.md`).

### 5.3 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnpm dev` fails with `Invalid environment: ...` | `parseEnv(process.env)` rejected the env; missing or short auth token | Confirm `.env.local` has both `AI_RELAY_API_KEY` and a 32-byte `AI_RELAY_AUTH_TOKEN`. |
| Container exits immediately on start | Same as above, inside the image | `docker compose logs relay` — the env error names the failing key (no value echo). |
| `curl` returns 401 + `WWW-Authenticate: Bearer` | Bearer token absent or wrong | Compare your client header to the value of `AI_RELAY_AUTH_TOKEN`. |
| `tools/call` returns `isError: true, code: "auth"` | Wrong `AI_RELAY_API_KEY` | Verify the key in the OpenAI dashboard. |
| `tools/call` returns `code: "rate_limited"` with `retryAfter` | OpenAI rate limit | Wait `retryAfter` seconds. v2 will add per-relay rate limiting. |
| Long requests cut off by upstream proxy (504) | Reverse proxy timeout below the model's response time | Raise the proxy's read/idle timeout — 300 s matches the parity target with Vercel's max function duration. |
| Docker container reports `unhealthy` | HEALTHCHECK can't reach `/healthz` | Inspect logs: `docker compose logs relay`. The most common cause is a missing required env var — startup fails fast. |
| `docker pull` returns `denied` | ghcr package is private and you are unauthenticated | Either run `docker login ghcr.io -u <user>` with a PAT (`read:packages` scope), or have the maintainer flip Settings → Packages → ai-relay → Public. |
| OpenAI dashboard shows usage on the wrong project | `AI_RELAY_API_KEY` from one environment leaked into another | Use distinct OpenAI project keys per environment (Production / Staging / Preview). |

---

## 6. Non-goals (v1)

The following are intentionally NOT in this runbook because they are not
in v1 (see [`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-future-work-v2-backlog)
for the v2 backlog):

- Rate limiting (Upstash, etc.)
- Daily token / dollar budget counters
- OAuth 2.1
- Sentry / OTel / Axiom observability
- Preview deploy comment bot
- Canary or blue-green deploys
- Kubernetes / Helm charts
