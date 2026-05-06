# mcp-openai-relay

A relay server that exposes the OpenAI Chat Completions API as an
[MCP (Model Context Protocol)](https://modelcontextprotocol.io) tool.
When you register this server with an MCP host such as Claude Code, the
host's LLM can call OpenAI models as if they were tools.

```
[ MCP host (Claude Code) ]  --bearer-->  [ this relay ]  --API key-->  [ OpenAI / compatible upstream ]
```

Runs on **Vercel** (managed serverless) or as a **Docker container**
(self-hosted).

---

## Quick start (Docker Compose)

The fastest way to run the relay locally or on a single host:

```bash
git clone https://github.com/ragingwind/mcp-openai-relay.git
cd mcp-openai-relay
cp .env.example .env.local
# Fill OPENAI_API_KEY and RELAY_AUTH_TOKEN (32+ bytes — `openssl rand -hex 32`)
docker compose up -d
```

The MCP endpoint is now at `http://localhost:8787/api/mcp`. Stop with
`docker compose down`. Override the host port with
`HOST_PORT=... docker compose up -d`.

For other paths (Vercel serverless, raw `docker run`, full operations),
see [`doc/DEPLOY.md`](./doc/DEPLOY.md).

---

## Status

**v1 (current)** — single tool `completion_chat`, bearer token authentication,
Streamable HTTP transport. The v2 backlog (Responses API, OAuth 2.1, rate
limiting, budget caps, observability) is tracked in
[`doc/ARCHITECTURE.md` §11](./doc/ARCHITECTURE.md#11-future-work-v2-backlog).

---

## Tool: `completion_chat`

Invokes OpenAI Chat Completions once and returns the accumulated response
text.

| Input | Type | Required |
|---|---|---|
| `model` | `string` | ✅ |
| `messages` | `Array<{role, content}>` | ✅ |
| `temperature` | `number` (0~2) | |
| `max_tokens` | `number` (clamped to server ceiling) | |
| `top_p` | `number` (0~1) | |
| `stop` | `string \| string[]` | |

Response: accumulated text plus `usage` metadata. Full schema in
[`doc/ARCHITECTURE.md` §4](./doc/ARCHITECTURE.md#4-mcp-tool-definition).

---

## Use from Claude Code

```bash
claude mcp add --transport http openai-relay \
  http://localhost:8787/api/mcp \
  --header "Authorization: Bearer <RELAY_AUTH_TOKEN>"
```

Or register directly in `.mcp.json`:

```json
{
  "mcpServers": {
    "openai-relay": {
      "type": "http",
      "url": "${RELAY_URL:-http://localhost:8787/api/mcp}",
      "headers": { "Authorization": "Bearer ${RELAY_AUTH_TOKEN}" }
    }
  }
}
```

> **Claude Desktop** registers remote MCP servers through **Settings →
> Connectors** in the UI (Pro/Max plans), not via
> `claude_desktop_config.json`.

---

## Contributing

Local development needs Node.js 20.x + pnpm 9:

```bash
pnpm install
cp .env.example .env.local        # fill OPENAI_API_KEY + RELAY_AUTH_TOKEN
pnpm dev                          # http://localhost:3000/api/mcp
pnpm test                         # vitest
```

`pnpm dev` refuses to start (with actionable instructions) when `.env.local`
is missing or the two required values are not set. All build/test/verify
commands are listed in
[`CLAUDE.md` §3 — Verify Commands](./CLAUDE.md#3-verify-commands).

---

## Documentation

| Topic | Document |
|---|---|
| Architecture, decisions, references | [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) |
| Deployment runbook (Vercel + Docker, operations) | [`doc/DEPLOY.md`](./doc/DEPLOY.md) |
| Manual verification (pre-PR, post-deploy) | [`doc/QA-MCP-INSPECTOR.md`](./doc/QA-MCP-INSPECTOR.md) |
| AI agent collaboration | [`CLAUDE.md`](./CLAUDE.md) |

---

## License

MIT — see [LICENSE](./LICENSE).
