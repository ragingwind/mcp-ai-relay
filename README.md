# ai-relay

> An MCP relay that exposes OpenAI Chat Completions (and any OpenAI-compatible upstream) as a Model Context Protocol tool.

> 한국어: [README.ko.md](./README.ko.md)

`ai-relay` lets any [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
host call OpenAI-compatible chat models as if they were tools. The same SDK
ships four interchangeable surfaces — pick the one that fits how you want to
deploy.

```
MCP host  ──►  ai-relay  ──►  OpenAI-compatible API
              (CLI | SDK | App | Docker)
```

---

## Surfaces

| Surface | Transport | Install | When |
|---|---|---|---|
| `npx ai-relay-cli <provider> <tool> [flags] [input]` | none (one-shot) | none | quick test, scripting, CI smoke |
| `npx ai-relay <provider>` | stdio MCP | none | direct registration in Claude Desktop / Claude Code / Cursor |
| SDK (`ai-relay`) | caller's choice (stdio / HTTP / Workers) | npm | embed in custom MCP server |
| App (`./app`, Hono) | HTTP | `git clone` (self-host on Node) | personal or team HTTP endpoint |
| Docker (`ghcr.io/ragingwind/ai-relay`) | HTTP | `docker run` (no build) | container deployment, multi-arch (amd64/arm64) |

---

## Quick start — one-shot CLI (`ai-relay-cli`)

```bash
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini "ping"

# Model can also come from the JSON input itself
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions \
  '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'

# …or from an env var
AI_RELAY_API_KEY=sk-... AI_RELAY_MODEL=gpt-4o-mini \
  npx ai-relay-cli openai chat-completions "ping"

echo "explain TLS in 2 sentences" \
  | AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini -s "be terse"

# Inline key via flag (no env var):
npx ai-relay-cli openai chat-completions -m gpt-4o-mini --api-key sk-... "ping"

# Point at Azure OpenAI / vLLM / Ollama / AI Gateway (any OpenAI-compatible endpoint):
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini \
  --base-url https://my-azure.openai.azure.com/v1 \
  "ping"
```

Invocation is `ai-relay-cli <provider> <tool> [flags] [input]`. Today the
only provider is `openai`, exposing `chat-completions`; future entries
will be `anthropic` (with `messages`) and `openai` with `responses`.
Input is either a positional
argument or piped via stdin (exactly one — they are XOR). A plain-text
positional becomes a `{messages:[…]}` array; a JSON literal (`{` / `[`) is
passed verbatim.

The model is resolved in this order (first match wins): `model` field in
the JSON input, then `-m`/`--model <id>` flag, then the `AI_RELAY_MODEL`
env var.

**Debugging:** pass `-v` / `--verbose` (or set `AI_RELAY_VERBOSE=1`) to
trace each stage (`argv`, `parsed-flags`, `env-snapshot`, `loaded-config`,
`openai-request`, `result`, …) to stderr. Secrets and response bodies
are redacted; stdout JSON is never polluted.

---

## Quick start — stdio MCP server (`ai-relay <provider>`)

For direct registration in Claude Desktop, Claude Code, Cursor, or any other
MCP host that spawns a child process and speaks JSON-RPC over stdin/stdout:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "openai"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

Run `ai-relay <provider>` to start the stdio MCP server (today the only
provider is `openai`, which exposes the `chat-completions` tool). For
shell pipelines and one-shot invocation, use
`ai-relay-cli <provider> <tool> -m <model> "…"`.

Point at an OpenAI-compatible endpoint (Azure OpenAI / vLLM / Ollama / AI
Gateway) by adding `"AI_RELAY_BASE_URL"` to the `env` block:

```json
"env": {
  "AI_RELAY_API_KEY": "sk-...",
  "AI_RELAY_BASE_URL": "https://my-azure.openai.azure.com/v1"
}
```

The MCP server accepts ad-hoc overrides as flags (`--api-key`,
`--base-url`, `--max-tokens`, `--timeout`, `--env <path>`). Run
`npx ai-relay --help` for the full list.

---

## Quick start — Docker

```bash
docker run -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  ghcr.io/ragingwind/ai-relay:latest
```

The MCP endpoint is served at `http://localhost:8787/api/mcp` and a
liveness check at `http://localhost:8787/healthz`. The image is multi-arch
(amd64 + arm64) and ships from this repo's
[`release-app` workflow](./.github/workflows/release-app.yml) on every
`v*` tag.

A `compose.yml` is provided for `docker compose up` (pulls the published
image). For local-build development, use `compose.dev.yml`:

```bash
docker compose -f compose.dev.yml up --build
```

### Verification

Before publishing or trusting a local build, run the committed smoke
harness against the distroless runner image:

```bash
pnpm docker:smoke
```

`pnpm docker:smoke` invokes [`app/scripts/docker-smoke.sh`](./app/scripts/docker-smoke.sh),
which builds the image and runs build-correctness + runtime assertions
(image-size budget, distroless invariants, bearer auth, MCP `initialize`
+ `tools/call` round-trip). See [`app/scripts/README.md`](./app/scripts/README.md)
for the assertion catalog and tunable env vars.

---

## Quick start — embed the SDK

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, { apiKey: process.env.AI_RELAY_API_KEY! });
await server.connect(new StdioServerTransport());
```

Full runnable versions live in [`examples/stdio/`](./examples/stdio/),
[`examples/multi-upstream/`](./examples/multi-upstream/), and
[`examples/cloudflare-workers/`](./examples/cloudflare-workers/).

---

## Environment variables

| Var | Scope | Required | Default |
|---|---|---|---|
| `AI_RELAY_API_KEY` | upstream credential (CLI + app) | yes (CLI + app) | — |
| `AI_RELAY_BASE_URL` | upstream endpoint override | no | SDK default |
| `AI_RELAY_MAX_OUTPUT_TOKENS` | per-request `max_tokens` ceiling | no | 4096 |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | upstream HTTP timeout | no | 60000 |
| `AI_RELAY_AUTH_TOKEN` | HTTP bearer for `./app` route (server-only) | yes (app) | — |
| `AI_RELAY_PORT` | bind port for the Hono server | no (app) | 8787 |

---

## Migration from v0.1

| Old | New | Source |
|---|---|---|
| `mcp-ai-relay` (bin) | `ai-relay` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `mcp-ai-relay --openai-completion` (stdio) | `ai-relay openai chat -m … "…"` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `--tool-name <id>` | (removed; default tool name is `chat-completions`) | [#55](https://github.com/ragingwind/mcp-ai-relay/issues/55) + [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `completion_chat` / `openai_chat` (former default tool names) | `chat-completions` | [#55](https://github.com/ragingwind/mcp-ai-relay/issues/55) |
| `OPENAI_API_KEY` | `AI_RELAY_API_KEY` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `OPENAI_BASE_URL` | `AI_RELAY_BASE_URL` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `MAX_OUTPUT_TOKENS_CEILING` | `AI_RELAY_MAX_OUTPUT_TOKENS` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `REQUEST_TIMEOUT_MS` | `AI_RELAY_REQUEST_TIMEOUT_MS` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `RELAY_AUTH_TOKEN` | `AI_RELAY_AUTH_TOKEN` | [#57](https://github.com/ragingwind/mcp-ai-relay/issues/57) |
| `docker build .` (Next.js, port 3000) | `docker run ghcr.io/ragingwind/ai-relay` (Hono, port 8787) | [#57](https://github.com/ragingwind/mcp-ai-relay/issues/57) |

---

## Status

**v0.5.0** (npm SDK) / **v1 relay app** — single tool `chat-completions`,
bearer token authentication, Streamable HTTP transport. The v2 backlog
(Responses API, OAuth 2.1, rate limiting, budget caps, observability) is
tracked in
[`doc/ARCHITECTURE.md` §11](./doc/ARCHITECTURE.md#11-future-work-v2-backlog).

---

## Documentation

| Topic | Document |
|---|---|
| SDK API + CLI + recipes | [`packages/ai-relay/README.md`](./packages/ai-relay/README.md) |
| Architecture, decisions, references | [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) |
| Deployment runbook (Vercel + Docker, operations) | [`doc/DEPLOY.md`](./doc/DEPLOY.md) |
| AI agent collaboration | [`CLAUDE.md`](./CLAUDE.md) |

Korean translations of the user-facing docs (English remains canonical):
[`README.ko.md`](./README.ko.md) ·
[`doc/ARCHITECTURE.ko.md`](./doc/ARCHITECTURE.ko.md) ·
[`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) ·
[`doc/QA-MCP-INSPECTOR.ko.md`](./doc/QA-MCP-INSPECTOR.ko.md).

---

## Contributing

Local development needs Node.js 20.x + pnpm 9:

```bash
pnpm install
cp .env.example .env.local        # fill AI_RELAY_API_KEY + AI_RELAY_AUTH_TOKEN
pnpm dev                          # http://localhost:8787/api/mcp
pnpm test                         # vitest
```

`pnpm dev` refuses to start (with actionable instructions) when `.env.local`
is missing or `AI_RELAY_AUTH_TOKEN` is not set. All build/test/verify
commands are listed in
[`CLAUDE.md` §3 — Verify Commands](./CLAUDE.md#3-verify-commands).

---

## License

MIT — see [LICENSE](./LICENSE).
