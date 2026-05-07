# mcp-ai-relay

> 한국어: [README.ko.md](./README.ko.md)

A relay that exposes the OpenAI Chat Completions API as an
[MCP (Model Context Protocol)](https://modelcontextprotocol.io) tool. When you
register this relay with an MCP host such as Claude Code or Claude Desktop, the
host's LLM can call OpenAI models as if they were tools.

```
[ MCP host (Claude Code, Claude Desktop, ...) ]  --bearer-->  [ this relay ]  --API key-->  [ OpenAI / compatible upstream ]
```

Three ways to consume it:

1. **`npx` + your MCP host's config** — zero install, stdio transport. Best for
   personal use or quick experiments.
2. **Run as an HTTP server** — Docker self-hosted or Vercel managed. Best when
   you want a shared endpoint for a team or to expose the relay publicly.
3. **Embed the SDK in your own MCP server** — most control. Best when you want
   custom logic, multi-upstream registration, or non-Node runtimes.

The npm package is
[`@ragingwind/ai-relay`](https://www.npmjs.com/package/@ragingwind/ai-relay).
Pick a path below.

---

## 1. Quick start — npx (zero install)

Have `npx` launch the relay as a stdio MCP server, direct from npm. No clone,
no build, no server to host.

### Prerequisites

- **Node.js 20+** (for `npx`)
- **An OpenAI API key** (`sk-...`)

### Verify the package works

In a terminal — replace `sk-...` with your real key:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | OPENAI_API_KEY=sk-... npx -y @ragingwind/ai-relay --openai-completion
```

Expected: a single-line JSON-RPC response that contains
`"name":"completion_chat"`. If you see that, you're ready to register it in an
MCP host.

### Register in Claude Desktop

1. Open `claude_desktop_config.json`. The path is OS-specific:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add the `mcpServers` entry below. If the file is empty, the whole snippet
   is the file. If it already has other servers, merge the `"openai-relay"`
   key into the existing `"mcpServers"` object.

```json
{
  "mcpServers": {
    "openai-relay": {
      "command": "npx",
      "args": ["-y", "@ragingwind/ai-relay", "--openai-completion"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

3. **Quit Claude Desktop completely** (⌘Q on macOS — closing the window
   isn't enough) and reopen it.
4. In a new chat, click the tools / connectors icon. You should see
   `completion_chat` listed under `openai-relay`. Ask Claude something like
   *"use the completion_chat tool with model gpt-4o-mini to summarize this
   page"* — it will call the tool.

### Register in Claude Code

In a project directory:

```bash
claude mcp add openai-relay \
  -e OPENAI_API_KEY=sk-... \
  -- npx -y @ragingwind/ai-relay --openai-completion
```

Or write `.mcp.json` directly:

```json
{
  "mcpServers": {
    "openai-relay": {
      "command": "npx",
      "args": ["-y", "@ragingwind/ai-relay", "--openai-completion"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Run `claude mcp list` to confirm the server is registered.

### What you get

A single MCP tool named `completion_chat` that the host LLM can invoke:

| Input | Type | Required |
|---|---|---|
| `model` | `string` (e.g., `gpt-4o-mini`) | ✅ |
| `messages` | `Array<{role, content}>` | ✅ |
| `temperature` | `number` (0~2) | |
| `max_tokens` | `number` (clamped to server ceiling, default 4096) | |
| `top_p` | `number` (0~1) | |
| `stop` | `string \| string[]` | |

Returns the accumulated assistant message text plus token usage.

### CLI options (full)

```
npx -y @ragingwind/ai-relay <provider-flag> [--name <name>] [--description <desc>]

Provider flags (exactly one required, one tool per invocation):
  --openai-completion   OpenAI Chat Completions
                        Required env: OPENAI_API_KEY
                        Optional env: OPENAI_BASE_URL,
                                      OPENAI_MAX_OUTPUT_TOKENS_CEILING,
                                      OPENAI_REQUEST_TIMEOUT_MS

Options:
  --name <name>         Override the registered MCP tool name
                        (default: completion_chat)
  --description <desc>  Override the tool description
  --help, -h            Show usage
  --version, -V         Print SDK version
```

`OPENAI_BASE_URL` lets you point the same CLI at any OpenAI-compatible
endpoint — Azure OpenAI, vLLM, Ollama, OpenRouter, or Vercel AI Gateway in
OpenAI mode.

### Multiple upstreams in one server

The CLI ships one tool per invocation. If you want a single MCP server that
hosts OpenAI proper + Azure + a local Ollama as three distinct named tools,
use the SDK API directly — see the
[multi-upstream example](./examples/multi-upstream/) and
[`packages/ai-relay/README.md`](./packages/ai-relay/README.md).

---

## 2. Run as an HTTP server (Docker Compose)

If you want a shared endpoint a team can hit, or you'd rather keep the
OpenAI key on a server instead of every developer's laptop, run the relay as
an HTTP service.

```bash
git clone https://github.com/ragingwind/mcp-ai-relay.git
cd mcp-ai-relay
cp .env.example .env.local
# Fill OPENAI_API_KEY and RELAY_AUTH_TOKEN (32+ bytes — `openssl rand -hex 32`)
docker compose up -d
```

The MCP endpoint is now at `http://localhost:8787/api/mcp`. Stop with
`docker compose down`. Override the host port with
`HOST_PORT=... docker compose up -d`.

Connect from an MCP host:

```bash
claude mcp add --transport http openai-relay \
  http://localhost:8787/api/mcp \
  --header "Authorization: Bearer <RELAY_AUTH_TOKEN>"
```

For Vercel serverless, raw `docker run`, full operations (token rotation,
troubleshooting, OpenAI usage cap), see [`doc/DEPLOY.md`](./doc/DEPLOY.md).

---

## 3. Embed the SDK in your own MCP server

If you're building a custom MCP server (Cloudflare Workers, Hono/Express, your
own Next.js route, etc.) the SDK package is the import surface:

```bash
npm install @ragingwind/ai-relay @modelcontextprotocol/sdk openai
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "@ragingwind/ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, { apiKey: process.env.OPENAI_API_KEY! });
```

`registerOpenAIChat` is closure-isolated, so the same server may host multiple
upstreams (OpenAI + Azure + local LLM, …) as distinct named tools. Full API
reference: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md).

Runnable examples in [`examples/`](./examples/):

| Example | Use case |
|---|---|
| [`stdio/`](./examples/stdio/) | Single-tool stdio launcher (same shape as the npx CLI, but in code) |
| [`multi-upstream/`](./examples/multi-upstream/) | One server, multiple upstreams (OpenAI + Azure + local LLM) — exercises the C7 multi-registration scenario |
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
| SDK API + recipes | [`packages/ai-relay/README.md`](./packages/ai-relay/README.md) |
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
