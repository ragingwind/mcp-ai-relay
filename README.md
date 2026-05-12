# ai-relay

> An MCP relay that exposes OpenAI Chat Completions (and any OpenAI-compatible upstream) as a Model Context Protocol tool.

> 한국어: [README.ko.md](./README.ko.md)

---

## Quick reference

**1. One-shot CLI** — run a model from the shell:

```bash
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini "ping"
```

**2. stdio MCP** — register in Claude Desktop / Claude Code / Cursor:

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

**3. Docker HTTP** — self-host an MCP HTTP endpoint:

```bash
docker run -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  ghcr.io/ragingwind/ai-relay:latest
```

**4. SDK** — embed in your own MCP server:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, { apiKey: process.env.AI_RELAY_API_KEY! });
await server.connect(new StdioServerTransport());
```

---

## 1. One-shot CLI

Invocation: `ai-relay-cli <provider> <tool> [flags] [input]`. Today `<provider>` is `openai` and `<tool>` is `chat-completions`. The model resolves from JSON input → `-m` flag → `AI_RELAY_MODEL`, in that order. Input is either a positional or piped via stdin (XOR); plain text becomes `{messages:[{role:"user",content:…}]}`, JSON literals (`{` / `[`) pass through.

```bash
# JSON input (model inside the payload)
npx ai-relay-cli openai chat-completions \
  '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'

# Stdin pipe + system prompt
echo "explain TLS in 2 sentences" \
  | npx ai-relay-cli openai chat-completions -m gpt-4o-mini -s "be terse"

# Azure OpenAI / vLLM / Ollama / AI Gateway — any OpenAI-compatible endpoint
npx ai-relay-cli openai chat-completions -m gpt-4o-mini \
  --api-key sk-... --base-url https://my-azure.openai.azure.com/v1 "ping"
```

`npx ai-relay-cli --help` for the full flag list. `-v` / `--verbose` (or `AI_RELAY_VERBOSE=1`) traces each stage to stderr; secrets are redacted, stdout JSON stays clean.

---

## 2. stdio MCP server

Register `ai-relay` as an MCP server in any host that spawns a child process and speaks JSON-RPC over stdin/stdout (Claude Desktop, Claude Code, Cursor, project-local `.mcp.json`). Replace `sk-...` and you're done.

Point at an OpenAI-compatible endpoint by adding `AI_RELAY_BASE_URL` to the `env` block:

```json
"env": {
  "AI_RELAY_API_KEY": "sk-...",
  "AI_RELAY_BASE_URL": "https://my-azure.openai.azure.com/v1"
}
```

The bin also accepts `--api-key`, `--base-url`, `--max-tokens`, `--timeout`, `--env <path>` as flags. Run `npx ai-relay --help` for the full list.

---

## 3. Docker HTTP server

The container serves MCP at `http://localhost:8787/api/mcp` (bearer-authenticated by `AI_RELAY_AUTH_TOKEN`) and a liveness probe at `http://localhost:8787/healthz`. The image is multi-arch (amd64 + arm64) on `ghcr.io/ragingwind/ai-relay:latest`.

For Docker Compose:

```bash
docker compose up                            # uses the published image
docker compose -f compose.dev.yml up --build # local build
```

For Vercel or another self-host of the Hono app, see [`examples/vercel/`](./examples/vercel/).

---

## 4. Embed the SDK

Above is the stdio variant. The same `registerOpenAIChat` works in HTTP (Hono / Node) and Cloudflare Workers. Runnable examples:

- [`examples/stdio/`](./examples/stdio/) — stdio MCP server
- [`examples/multi-upstream/`](./examples/multi-upstream/) — one server, multiple OpenAI-compatible upstreams
- [`examples/cloudflare-workers/`](./examples/cloudflare-workers/) — Workers
- [`examples/vercel/`](./examples/vercel/) — Vercel deploy of the Hono app

SDK API reference: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md).

---

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `AI_RELAY_API_KEY` | yes | — |
| `AI_RELAY_BASE_URL` | no | OpenAI default |
| `AI_RELAY_MODEL` | no (CLI only) | — |
| `AI_RELAY_MAX_OUTPUT_TOKENS` | no | 4096 |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | no | 60000 |
| `AI_RELAY_AUTH_TOKEN` | yes (Docker / HTTP app) | — |
| `AI_RELAY_PORT` | no (HTTP app) | 8787 |

---

## Documentation

- SDK API + recipes: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md)
- Architecture: [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) ([한국어](./doc/ARCHITECTURE.ko.md))
- Deployment runbook: [`doc/DEPLOY.md`](./doc/DEPLOY.md) ([한국어](./doc/DEPLOY.ko.md))

## License

MIT — see [LICENSE](./LICENSE).
