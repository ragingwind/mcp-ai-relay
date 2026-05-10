# DEPLOY — mcp-ai-relay

> 한국어: [DEPLOY.ko.md](./DEPLOY.ko.md)

This runbook covers v1 deployment via two paths: **Vercel** (managed
serverless) and **Docker** (self-hosted container). Architecture decisions
live in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§6 `vercel.json`, §7 env
vars, §9 security). Coding rules live in [`../CLAUDE.md`](../CLAUDE.md).

---

## 1. Prerequisites

Universal:
- An OpenAI (or OpenAI-compatible) API key.
- A 32+ byte bearer token: `openssl rand -hex 32`.
- The repository cloned: `git clone https://github.com/ragingwind/mcp-ai-relay.git`.

For **Vercel**:
- A Vercel account (Pro plan recommended — needed for `maxDuration: 300`).
- Two OpenAI projects (Production + Preview), each with its own key. The
  two-project split isolates a leaked Preview key from production billing.
- Vercel CLI: `npm i -g vercel` (or `pnpm dlx vercel ...`).

For **Docker**:
- Docker `^24` (Compose v2 plugin included by default).
- A reverse proxy / load balancer if exposing publicly (handles TLS and
  long-running request timeouts).

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
the only line of defense if `RELAY_AUTH_TOKEN` leaks. Set it before exposing
the relay anywhere — Vercel or Docker.

For each OpenAI project key:

1. Open the [OpenAI dashboard → Settings → Billing → Limits](https://platform.openai.com/account/limits).
2. Switch to the project (top-left selector).
3. Set **Hard limit** to your monthly tolerance (e.g., `$10` for Preview).
4. Set **Soft limit** lower (e.g., 50% of hard) for an early-warning email.

The v2 plan to add per-relay rate limiting is in
[`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-future-work-v2-backlog).

---

## 3. Vercel deployment

### 3.1 Link the project

```bash
vercel link
```

Pick **Create new project** the first time, or select the existing project
on subsequent runs. `vercel link` writes `.vercel/project.json` — verify
`.vercel/` is gitignored.

### 3.2 Confirm runtime configuration

`vercel.json` already pins:

```json
{
  "regions": ["iad1"],
  "functions": { "app/api/**/route.ts": { "maxDuration": 300 } }
}
```

Node version is selected via `engines.node` in `package.json`
(`>=20.0.0 <21.0.0`). The route also exports `runtime = "nodejs"` and
`maxDuration = 300` for defense in depth.

After deploying, verify in the Vercel dashboard:
- **Settings → General → Node.js Version**: 20.x
- **Functions** tab: `app/api/[transport]/route.ts` listed as `nodejs20.x`
  with `Max Duration: 300s`
- **Settings → Functions → Region**: iad1
- **Settings → Fluid Compute**: enabled (Pro plan default)

### 3.3 Register Sensitive env vars

Register every key for **both** Production and Preview environments. Use
the **Sensitive** flag — Vercel will not let you re-read the value after
creation (audit-friendly; rotation is by replacement).

| Key | Required | Production | Preview | Sensitive |
|---|---|---|---|---|
| `AI_RELAY_API_KEY` | ✅ | upstream key #1 | upstream key #2 (different project) | ✅ |
| `RELAY_AUTH_TOKEN` | ✅ | 32+ random bytes | 32+ random bytes (different) | ✅ |
| `AI_RELAY_BASE_URL` | ❌ | (omit for OpenAI default) | same or staging URL | — |
| `AI_RELAY_MAX_OUTPUT_TOKENS` | ❌ | `4096` | `4096` | — |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | ❌ | `60000` | `60000` | — |

```bash
# Production secrets
vercel env add AI_RELAY_API_KEY production --sensitive
vercel env add RELAY_AUTH_TOKEN production --sensitive

# Preview secrets (different OpenAI key + different relay token)
vercel env add AI_RELAY_API_KEY preview --sensitive
vercel env add RELAY_AUTH_TOKEN preview --sensitive

# Optional plain env vars
vercel env add AI_RELAY_BASE_URL production    # only if pointing at non-OpenAI upstream
vercel env add AI_RELAY_MAX_OUTPUT_TOKENS production
vercel env add AI_RELAY_REQUEST_TIMEOUT_MS production
```

Verify with `vercel env ls`. The Sensitive flag shows as `Encrypted`.

> **Preview deployments are auto-locked.** Vercel applies Vercel
> Authentication to Preview by default — only your team members can reach
> the preview URL. Verify in **Settings → Deployment Protection**.

### 3.4 First deployment

```bash
vercel deploy --prod
```

Vercel returns the production URL: `https://<your-project>.vercel.app`.
The MCP endpoint is at `/api/mcp`.

### 3.5 Verification checklist

- [ ] `vercel deploy --prod` completes without error.
- [ ] Vercel dashboard → **Functions** shows `app/api/[transport]/route.ts`
      listed as `nodejs20.x`, region `iad1`, `Max Duration: 300s`.
- [ ] Smoke test:
      ```bash
      curl -i https://<your-project>.vercel.app/api/mcp \
        -H "Authorization: Bearer $RELAY_AUTH_TOKEN" -X GET
      ```
      Expect HTTP 4xx (mcp-handler responds to bare GET) — anything other
      than 5xx proves the function reached. A 401 means the bearer is wrong.
- [ ] Run the manual verification from
      [`QA-MCP-INSPECTOR.md`](./QA-MCP-INSPECTOR.md). For prod, §E covers
      the re-verification subset (C1, C2, C5).
- [ ] OpenAI dashboard → **Usage** shows the call recorded against the
      prod project (proves the right key is wired).

---

## 4. Docker (self-hosted)

The relay ships a multi-stage `Dockerfile` at the repo root that produces a
~70 MB runtime image based on `node:20-alpine` (digest-pinned for
supply-chain stability), running as a non-root user (UID 1001) with a Node
`fetch` HEALTHCHECK against `/api/mcp`.

> **Pinned base image.** `Dockerfile` references `node:20-alpine@sha256:...`
> rather than the floating `node:20-alpine` tag. Bump the digest deliberately
> (`docker pull node:20-alpine && docker inspect node:20-alpine --format
> '{{.RepoDigests}}'`) — do not unpin.

> **Timeouts are the operator's responsibility.** There is no analogue of
> Vercel's 300 s function timeout. Configure your reverse proxy / load
> balancer to allow long-running requests; 300 s is a reasonable starting
> value for parity with Vercel.

### 4.1 Compose (recommended)

```bash
cp .env.example .env.local         # then fill AI_RELAY_API_KEY + RELAY_AUTH_TOKEN
docker compose up -d               # builds on first run, then starts
```

The relay is reachable at `http://localhost:8787/api/mcp`. `restart:
unless-stopped` keeps it running across reboots.

**Host port override.** The default `8787` matches Cloudflare Wrangler's
remote-MCP examples and avoids the typical Next.js / Node `:3000` collision.
To use a different port:

```bash
HOST_PORT=9876 docker compose up -d   # → http://localhost:9876/api/mcp
```

The container always listens on `3000` internally — only the host-side
mapping changes.

**Lifecycle:**

```bash
docker compose up -d                  # build + start (detached)
docker compose ps                     # status + health
docker compose logs -f relay          # follow logs
docker compose down                   # stop and remove
docker compose up -d --build          # rebuild after Dockerfile / source changes
```

`compose.yml` reads `.env.local` via `env_file:` and forwards every key
into the container's process env. Same env contract as raw `docker run`
(§4.2).

> Compose does NOT replace the production runbook. For multi-host or
> managed orchestration use Kubernetes / a PaaS — `compose.yml` is for
> single-host self-hosting and local development.

### 4.2 Raw `docker run`

Build:

```bash
docker build -t mcp-ai-relay .
```

Final image size should be under 200 MB. The build does not need real
secrets — `pnpm build` injects build-time dummy values.

Run with inline `-e` flags:

```bash
docker run --rm -p 8787:3000 \
  -e AI_RELAY_API_KEY=sk-... \
  -e RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e AI_RELAY_BASE_URL=https://your-gateway.example.com/v1 \
  -e AI_RELAY_MAX_OUTPUT_TOKENS=4096 \
  -e AI_RELAY_REQUEST_TIMEOUT_MS=60000 \
  mcp-ai-relay
```

Or with `--env-file`:

```bash
docker run --rm -p 8787:3000 --env-file .env.production mcp-ai-relay
```

`AI_RELAY_API_KEY` and `RELAY_AUTH_TOKEN` are required. `AI_RELAY_BASE_URL`,
`AI_RELAY_MAX_OUTPUT_TOKENS`, and `AI_RELAY_REQUEST_TIMEOUT_MS` are optional (see
[`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-environment-variables) for
defaults).

### 4.3 Verification checklist

HEALTHCHECK:

```bash
docker inspect --format '{{.State.Health.Status}}' <container>
```

Expect `healthy` within ~30 s of start. The check sends `GET /api/mcp` and
treats any non-5xx response as healthy (mcp-handler returns 405 to a bare
GET, which proves the function reached).

Smoke test (with the container running on default port 8787):

```bash
pnpm inspect --url=http://localhost:8787/api/mcp --method=tools/list
```

Expect a single tool named `openai_chat`. For the full pre-PR procedure
(C1–C6) see [`QA-MCP-INSPECTOR.md`](./QA-MCP-INSPECTOR.md).

### 4.4 Confirm no secrets baked in

```bash
docker history mcp-ai-relay --no-trunc | grep -iE 'AI_RELAY_API_KEY|RELAY_AUTH_TOKEN'
```

Only `pnpm build`'s dummy values (`build-dummy`, 32×`x`) should appear —
never real credentials.

---

## 5. Operations

### 5.1 Rotate `RELAY_AUTH_TOKEN`

Run when:
- A token is suspected leaked.
- A team member with token access leaves.
- Routine rotation (recommended every 90 days).

**Vercel:**

```bash
openssl rand -hex 32                          # generate
vercel env rm RELAY_AUTH_TOKEN production     # replace
vercel env add RELAY_AUTH_TOKEN production --sensitive
vercel deploy --prod                          # apply
```

**Docker:**

1. Generate a new token: `openssl rand -hex 32`.
2. Update `.env.local` (or your secrets manager).
3. `docker compose up -d --force-recreate` (or restart the container).

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
3. Re-run the verification checklist (§3.5 for Vercel, §4.3 for Docker).

### 5.3 Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnpm build` fails locally with `Invalid environment: ...` | Module-level `parseEnv(process.env)` evaluation; missing env at build time | The `package.json` `build` script injects dummy values for `AI_RELAY_API_KEY` and `RELAY_AUTH_TOKEN`. Restore it or set real env in `.env.local`. |
| Vercel build fails with the same env error | Same as above, in CI/Vercel | Vercel injects real env vars at build time when registered — verify with `vercel env ls`. |
| `curl` returns 401 + `WWW-Authenticate: Bearer` | Bearer token absent or wrong | Compare your client header to the value of `RELAY_AUTH_TOKEN`. |
| `tools/call` returns `isError: true, code: "auth"` | Wrong `AI_RELAY_API_KEY` | Verify the key in the OpenAI dashboard. |
| `tools/call` returns `code: "rate_limited"` with `retryAfter` | OpenAI rate limit | Wait `retryAfter` seconds. v2 will add per-relay rate limiting. |
| Function exceeds `maxDuration` (504 / function timeout) | Long generation, or stuck on a tool call | Verify `vercel.json` and route-level `maxDuration: 300` are both set. The Pro plan ceiling is 300 s. |
| Docker container reports `unhealthy` | HEALTHCHECK can't reach `/api/mcp` | Inspect logs: `docker compose logs relay`. The most common cause is a missing required env var — startup fails fast. |
| OpenAI dashboard shows usage on the wrong project | `AI_RELAY_API_KEY` from Preview leaked into Production (or vice versa) | Re-run §3.3 carefully — keys MUST come from different OpenAI projects. |

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
