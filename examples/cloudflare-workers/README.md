# Example — Cloudflare Workers

Embeds `registerOpenAIChat` in a Cloudflare Workers MCP server built
on the [`agents/mcp`](https://developers.cloudflare.com/agents/model-context-protocol/)
framework. The framework handles the Streamable HTTP transport,
session state via Durable Objects, and routing — this example just
registers the SDK's tool in `init()` and adds a bearer-token gate.

> **Note on framework dependencies**: The `agents` package is
> Cloudflare's official MCP-on-Workers framework. Its API is still
> evolving in 2026 — this example targets `agents@^0.0.40`. If your
> deployment uses a different framework version, adapt the
> `OpenAIRelay extends McpAgent` and `serveSSE("/sse")` calls per
> Cloudflare's latest docs.

## Run from this monorepo

```bash
# from the repo root
pnpm install
pnpm --filter ai-relay build

# Set Workers secrets (use wrangler from the example dir)
cd examples/cloudflare-workers
pnpm exec wrangler secret put AI_RELAY_API_KEY    # paste your key when prompted
pnpm exec wrangler secret put AI_RELAY_AUTH_TOKEN  # paste a 32+ byte token
# Optional:
# pnpm exec wrangler secret put AI_RELAY_BASE_URL

# Local dev (hot reload)
pnpm dev

# Deploy
pnpm deploy
```

The Worker will be available at `https://<name>.<subdomain>.workers.dev/sse`.

## Run from npm (after `ai-relay@0.1.0` is published)

```bash
mkdir my-relay-worker && cd my-relay-worker
npm init -y && npm pkg set type=module
npm install ai-relay @modelcontextprotocol/sdk openai agents
npm install --save-dev wrangler @cloudflare/workers-types
```

Copy `src/index.ts`, `wrangler.toml`, and `tsconfig.json` from this
directory. Then follow the secret + deploy steps above.

## Why `nodejs_compat`?

The SDK uses `AsyncLocalStorage` from `node:async_hooks` to capture
upstream 5xx response bodies and redact API keys before surfacing them
in error result text. Workers requires
`compatibility_flags = ["nodejs_compat"]` to expose
`AsyncLocalStorage`.

Without the flag, the SDK degrades gracefully: requests still succeed,
errors still get the right `code`, only the redacted upstream body
snippet is omitted from result text.

## Configuration

| Secret | Required | Notes |
|---|---|---|
| `AI_RELAY_API_KEY` | ✅ | Set via `wrangler secret put` |
| `AI_RELAY_AUTH_TOKEN` | ✅ | Bearer token sent by the MCP host (32+ bytes) |
| `AI_RELAY_BASE_URL` | ❌ | Override for Azure / vLLM / Ollama / AI Gateway |

`max_tokens` ceiling and request timeout default to the SDK's values
(4096 / 60 s). Edit `src/index.ts` to override.

## Connect from an MCP host

Once deployed:

```bash
claude mcp add --transport http openai-relay-worker \
  https://<your-worker>.workers.dev/sse \
  --header "Authorization: Bearer <AI_RELAY_AUTH_TOKEN>"
```
