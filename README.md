# mcp-ai-relay

> An MCP relay that exposes OpenAI Chat Completions (and any OpenAI-compatible upstream) as a Model Context Protocol tool.

> 한국어: [README.ko.md](./README.ko.md)

`mcp-ai-relay` lets any [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
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
| `npx ai-relay` | none (one-shot) | none | quick test, scripting, CI smoke |
| SDK (`ai-relay`) | caller's choice (stdio / HTTP / Workers) | npm | embed in custom MCP server |
| App (`./app`, Next.js) | HTTP | `git clone` (self-host on Vercel/Node) | personal or team HTTP endpoint |
| Docker (local build) | HTTP | `docker build` from this repo | container deployment now; published image lands with [#57](https://github.com/ragingwind/mcp-ai-relay/issues/57) |

---

## Quick start — one-shot CLI

```bash
AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini "ping"

AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini \
  '{"messages":[{"role":"user","content":"ping"}]}'

echo "explain TLS in 2 sentences" \
  | AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini -s "be terse"
```

`-m/--model` is mandatory. Input is either a positional argument or piped via
stdin (exactly one — they are XOR). A plain-text positional becomes a
`{messages:[…]}` array; a JSON literal (`{` / `[`) is passed verbatim.

---

## Quick start — Docker (local build)

```bash
docker build -t mcp-ai-relay .

docker run -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  mcp-ai-relay
```

The MCP endpoint is then served at `http://localhost:8787/api/mcp`. A
`compose.yml` is also provided in the repo root if you prefer
`docker compose up`.

> When [#57](https://github.com/ragingwind/mcp-ai-relay/issues/57) lands, the
> `docker build` step is replaced by a pull from
> `ghcr.io/ragingwind/ai-relay`. Until then, build locally.

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
| `RELAY_AUTH_TOKEN` | HTTP bearer for `./app` route (server-only) | yes (app) | — |

---

## Migration from v0.1

| Old | New | Source |
|---|---|---|
| `mcp-ai-relay` (bin) | `ai-relay` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `mcp-ai-relay --openai-completion` (stdio) | `ai-relay openai chat -m … "…"` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `--tool-name <id>` | (removed; default tool name is `openai_chat`) | [#55](https://github.com/ragingwind/mcp-ai-relay/issues/55) + [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `completion_chat` (default tool name) | `openai_chat` | [#55](https://github.com/ragingwind/mcp-ai-relay/issues/55) |
| `OPENAI_API_KEY` | `AI_RELAY_API_KEY` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `OPENAI_BASE_URL` | `AI_RELAY_BASE_URL` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `MAX_OUTPUT_TOKENS_CEILING` | `AI_RELAY_MAX_OUTPUT_TOKENS` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `REQUEST_TIMEOUT_MS` | `AI_RELAY_REQUEST_TIMEOUT_MS` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |

---

## Status

**v0.1.0** (npm SDK) / **v1 relay app** — single tool `openai_chat`,
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
cp .env.example .env.local        # fill AI_RELAY_API_KEY + RELAY_AUTH_TOKEN
pnpm dev                          # http://localhost:3000/api/mcp
pnpm test                         # vitest
```

`pnpm dev` refuses to start (with actionable instructions) when `.env.local`
is missing or `RELAY_AUTH_TOKEN` is not set. All build/test/verify
commands are listed in
[`CLAUDE.md` §3 — Verify Commands](./CLAUDE.md#3-verify-commands).

---

## License

MIT — see [LICENSE](./LICENSE).
