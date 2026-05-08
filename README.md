# mcp-ai-relay

> 한국어: [README.ko.md](./README.ko.md)

A relay that exposes the OpenAI Chat Completions API as an
[MCP (Model Context Protocol)](https://modelcontextprotocol.io) tool. Register
the relay's HTTP endpoint with an MCP host (Claude Code, Claude Desktop, …) so
the host's LLM can call OpenAI models as if they were tools.

```
[ MCP host ]  --bearer-->  [ relay HTTP /api/mcp ]  --API key-->  [ OpenAI / compatible upstream ]
```

Three ways to consume it:

1. **Run as an HTTP server** — Docker self-hosted or Vercel managed. The
   primary deployment shape; what an MCP host registers.
2. **One-shot CLI** — `npx ai-relay openai chat -m <model> "<input>"` for
   shell pipelines, smoke tests, or quick experimentation.
3. **Embed the SDK in your own MCP server** — most control. Best when you want
   custom logic, multi-upstream registration, or non-Node runtimes.

The npm package is
[`ai-relay`](https://www.npmjs.com/package/ai-relay).
Pick a path below.

---

## 1. Quick start — HTTP server (Docker Compose)

The relay's primary surface is HTTP. MCP hosts (Claude Code, Claude Desktop,
…) connect to a single bearer-protected endpoint that handles streaming chat
completions.

```bash
git clone https://github.com/ragingwind/mcp-ai-relay.git
cd mcp-ai-relay
cp .env.example .env.local
# Fill AI_RELAY_API_KEY and RELAY_AUTH_TOKEN (32+ bytes — `openssl rand -hex 32`)
docker compose up -d
```

The MCP endpoint is now at `http://localhost:8787/api/mcp`. Stop with
`docker compose down`. Override the host port with
`HOST_PORT=... docker compose up -d`.

### Register in Claude Code

```bash
claude mcp add --transport http openai-relay \
  http://localhost:8787/api/mcp \
  --header "Authorization: Bearer <RELAY_AUTH_TOKEN>"
```

### Register in Claude Desktop

Open `claude_desktop_config.json`. The path is OS-specific:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the `mcpServers` entry below (merge the `"openai-relay"` key into the
existing `"mcpServers"` object if any):

```json
{
  "mcpServers": {
    "openai-relay": {
      "transport": {
        "type": "http",
        "url": "http://localhost:8787/api/mcp",
        "headers": {
          "Authorization": "Bearer <RELAY_AUTH_TOKEN>"
        }
      }
    }
  }
}
```

Quit Claude Desktop completely (⌘Q on macOS) and reopen it. The
`completion_chat` tool appears under `openai-relay`.

For Vercel serverless, raw `docker run`, full operations (token rotation,
troubleshooting, OpenAI usage cap), see [`doc/DEPLOY.md`](./doc/DEPLOY.md).

### Environment variables

| Key | Required | Notes |
|---|---|---|
| `AI_RELAY_API_KEY` | ✅ | Upstream API key. Sensitive. |
| `RELAY_AUTH_TOKEN` | ✅ | Bearer token MCP hosts send. ≥ 32 bytes. |
| `AI_RELAY_BASE_URL` | ❌ | Override for Azure / vLLM / Ollama / AI Gateway. |
| `AI_RELAY_MAX_OUTPUT_TOKENS` | ❌ | Default 4096. |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | ❌ | Default 60000. |

---

## 2. One-shot CLI

The SDK ships an `ai-relay` bin that invokes a tool once and prints the
result on stdout. It is **not** a long-lived stdio MCP server — wire MCP
hosts at the HTTP endpoint above instead.

```bash
AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini "ping"
echo '{"messages":[{"role":"user","content":"ping"}]}' \
  | AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini
AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini -s "be terse" "explain TLS"
```

`-m/--model` is required. Input is either positional or piped via stdin
(exactly one). Plain text becomes a `messages` array; JSON literals are
passed verbatim. Full flag list: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md#cli).

---

## 3. Embed the SDK in your own MCP server

If you're building a custom MCP server (Cloudflare Workers, Hono/Express, your
own Next.js route, etc.) the SDK package is the import surface:

```bash
npm install ai-relay @modelcontextprotocol/sdk openai
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, { apiKey: process.env.AI_RELAY_API_KEY! });
```

`registerOpenAIChat` is closure-isolated, so the same server may host multiple
upstreams (OpenAI + Azure + local LLM, …) as distinct named tools. Full API
reference: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md).

Runnable examples in [`examples/`](./examples/):

| Example | Use case |
|---|---|
| [`stdio/`](./examples/stdio/) | Single-tool stdio launcher |
| [`multi-upstream/`](./examples/multi-upstream/) | One server, multiple upstreams (OpenAI + Azure + local LLM) |
| [`cloudflare-workers/`](./examples/cloudflare-workers/) | Workers MCP via `agents/mcp` framework |

---

## Status

**v0.1.0** (npm SDK) / **v1 relay app** — single tool `completion_chat`,
bearer token authentication, Streamable HTTP transport. The v2 backlog
(Responses API, OAuth 2.1, rate limiting, budget caps, observability) is
tracked in
[`doc/ARCHITECTURE.md` §11](./doc/ARCHITECTURE.md#11-future-work-v2-backlog).

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

## Documentation

| Topic | Document |
|---|---|
| SDK API + CLI + recipes | [`packages/ai-relay/README.md`](./packages/ai-relay/README.md) |
| Architecture, decisions, references | [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) |
| Deployment runbook (Vercel + Docker, operations) | [`doc/DEPLOY.md`](./doc/DEPLOY.md) |
| Manual verification (pre-PR, post-deploy) | [`doc/QA-MCP-INSPECTOR.md`](./doc/QA-MCP-INSPECTOR.md) |
| AI agent collaboration | [`CLAUDE.md`](./CLAUDE.md) |

Korean translations of the user-facing docs (English remains canonical):
[`README.ko.md`](./README.ko.md) ·
[`doc/ARCHITECTURE.ko.md`](./doc/ARCHITECTURE.ko.md) ·
[`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) ·
[`doc/QA-MCP-INSPECTOR.ko.md`](./doc/QA-MCP-INSPECTOR.ko.md).

---

## License

MIT — see [LICENSE](./LICENSE).
