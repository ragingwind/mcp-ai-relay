# ai-relay

Provider-agnostic MCP relay SDK. Embed `chat-completions` (OpenAI Chat
Completions, OpenAI-compatible APIs, and unified gateways) — and future
provider tools — into any [Model Context Protocol](https://modelcontextprotocol.io)
server.

The SDK ships two bins:

- **`ai-relay <api-type>`** — long-lived stdio MCP server keyed by an
  api-type positional (today: `chat-completions`).
- **`ai-relay-cli <tool> <model> [flags] [input]`** — one-shot CLI
  invocation that prints a single tool result as JSON.

> **v0.6.0** ships only the OpenAI provider, exposed as `chat-completions`
> (the upstream API's native name). Future provider tools — `messages`
> for Anthropic, `responses` for OpenAI Responses, etc. — will land under
> their own keys without breaking existing `chat-completions` consumers.

---

## Install

```bash
npm install ai-relay @modelcontextprotocol/sdk openai
# or
pnpm add ai-relay @modelcontextprotocol/sdk openai
```

`@modelcontextprotocol/sdk` and `openai` are declared as **peer
dependencies** so the consumer controls their versions.

Requires **Node.js 20+** (or any runtime with `node:async_hooks`
compatibility — Bun, Deno, Cloudflare Workers with `nodejs_compat`).

---

## Bin

This package ships two bins:

- **`ai-relay <api-type>`** — long-lived stdio MCP server that an MCP
  host (Claude Desktop, Claude Code, Cursor, …) spawns as a child
  process. The `<api-type>` positional (today: `chat-completions`)
  selects which upstream API is registered. Speaks the JSON-RPC MCP
  protocol over stdin/stdout. See
  [Claude Desktop / Claude Code / Cursor — stdio MCP server](#claude-desktop--claude-code--cursor--stdio-mcp-server)
  below.
- **`ai-relay-cli <tool> <model> [flags] [input]`** — one-shot
  invocation that prints a single tool result as JSON to stdout, then
  exits. For scripts, CI smoke tests, and ad-hoc use.

### One-shot CLI

`ai-relay-cli <tool> <model> [flags] [input]` — prints the tool result
as JSON on stdout.

```bash
ai-relay-cli chat-completions gpt-4o-mini "ping"
ai-relay-cli chat-completions gpt-4o-mini -s "be terse" "explain TLS"
ai-relay-cli chat-completions gpt-4o-mini '{"messages":[{"role":"user","content":"ping"}]}'
ai-relay-cli chat-completions gpt-4o-mini --api-key sk-... "ping"
ai-relay-cli chat-completions gpt-4o-mini --base-url https://my-azure.openai.azure.com/v1 "ping"
ai-relay-cli chat-completions gpt-4o-mini --env ./prod.env "ping"
echo '{"messages":[…]}' | ai-relay-cli chat-completions gpt-4o-mini
```

Tool and model are both required positionals. The tool name follows the
upstream API's native naming — `chat-completions` for OpenAI Chat
Completions today; future entries (e.g. `messages` for Anthropic,
`responses` for OpenAI Responses) will be added as additional keys.

Input is either a positional argument or piped via stdin (exactly one).
A positional starting with `{` or `[` is parsed as a JSON literal;
anything else is treated as a plain user message and folded into a
`messages` array (with `-s/--system` prepended when supplied). Exit
code is `0` on success, `1` on a runtime/upstream error, `2` on a
usage error.

| Flag | Purpose |
|------|---------|
| `-s, --system <text>` | System message prepended to plain-text input. |
| `--api-key <key>` | Overrides `AI_RELAY_API_KEY`. |
| `--base-url <url>` | Overrides `AI_RELAY_BASE_URL`. |
| `--max-tokens <n>` | Cap on `max_tokens`. |
| `--timeout <ms>` | Per-request timeout. |
| `--env <path>` | Load `AI_RELAY_*` keys from a dotenv file. |
| `-h, --help` | Show usage. |
| `-V, --version` | Print SDK version. |

### Environment variables

| Name | Required | Notes |
|------|----------|-------|
| `AI_RELAY_API_KEY` | ✅ (or `--api-key`) | Upstream API key. |
| `AI_RELAY_BASE_URL` | ❌ | Override for Azure / vLLM / Ollama / AI Gateway. |
| `AI_RELAY_MAX_OUTPUT_TOKENS` | ❌ | Default 4096. |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | ❌ | Default 60000. |

CLI flags > `--env` file > process env > built-in defaults.

### Claude Desktop / Claude Code / Cursor — stdio MCP server

Invoke the `ai-relay` bin with the `<api-type>` positional (today:
`chat-completions`) and it runs as a long-lived stdio MCP server that
an MCP host can spawn directly. It accepts the configuration flags
(`--api-key`, `--base-url`, `--max-tokens`, `--timeout`, `--env`) and
reads `AI_RELAY_*` env vars.

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "chat-completions"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

Point at an OpenAI-compatible endpoint (Azure / vLLM / Ollama / AI
Gateway) by adding `"AI_RELAY_BASE_URL"` to the `env` block, or by
passing `--base-url <url>` in `args` (e.g.
`"args": ["-y", "ai-relay", "chat-completions", "--base-url", "https://my-azure.openai.azure.com/v1"]`).

Project-local `.mcp.json` works the same way — pass the absolute path
to the installed bin (or `npx ai-relay`) plus the `chat-completions`
positional.

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "node",
      "args": ["./node_modules/ai-relay/dist/bin/ai-relay.js", "chat-completions"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

For HTTP/SSE MCP transport instead of stdio, deploy the reference Hono
app in this repo (`/api/mcp` route) — see the project root README.

---

## SDK

### Embed in a Hono / Node HTTP MCP route

```ts
// src/index.ts — minimal Hono server (mirrors `app/src/index.ts`)
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig, verifyBearer } from "ai-relay";
import { registerOpenAIChat } from "ai-relay/openai";
import { createMcpHandler, withMcpAuth } from "mcp-handler";

const config = loadConfig({ env: process.env });
const provider = config.providers[0]!;

const handler = createMcpHandler(
  (server) => {
    registerOpenAIChat(server, {
      apiKey: provider.apiKey,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      ...(provider.maxOutputTokens ? { maxOutputTokensCeiling: provider.maxOutputTokens } : {}),
      ...(provider.requestTimeoutMs ? { requestTimeoutMs: provider.requestTimeoutMs } : {}),
    });
  },
  {},
  { basePath: "/api" },
);

const wrapped = withMcpAuth(
  handler,
  (_req, token) =>
    verifyBearer(token, process.env.AI_RELAY_AUTH_TOKEN!)
      ? { token: token as string, clientId: "shared-secret", scopes: ["openai:chat"] }
      : undefined,
  { required: true, requiredScopes: ["openai:chat"] },
);

const app = new Hono();
app.get("/healthz", (c) => c.text("ok", 200));
app.all("/api/mcp", (c) => wrapped(c.req.raw));

serve({ fetch: app.fetch, port: Number(process.env.AI_RELAY_PORT ?? 8787) });
```

For the Vercel/Next.js variant, see
[`examples/vercel/README.md`](../../examples/vercel/README.md).

### Embed in a stdio MCP server (Claude Desktop direct)

```ts
// server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "openai-relay", version: "0.1.0" });
registerOpenAIChat(server, {
  apiKey: process.env.AI_RELAY_API_KEY!,
});

await server.connect(new StdioServerTransport());
```

### Embed in a Cloudflare Workers MCP

```ts
// src/index.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "ai-relay/openai";

export class OpenAIRelay extends McpAgent {
  server = new McpServer({ name: "openai-relay", version: "0.1.0" });

  async init() {
    registerOpenAIChat(this.server, { apiKey: this.env.AI_RELAY_API_KEY });
  }
}
```

`wrangler.toml` requires `compatibility_flags = ["nodejs_compat"]` so
`AsyncLocalStorage` (used internally for upstream-error redaction) is
available. Without it, the SDK degrades gracefully — the request still
succeeds, but upstream 5xx body snippets won't appear in the result text.

### Multi-upstream (one server, multiple instances)

`registerOpenAIChat` is closure-isolated: each call captures its own
client, ceiling, and timeout. Call it any number of times on the same
server with distinct `name` values to expose multiple upstreams as
distinct tools.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "multi-relay", version: "0.1.0" });

registerOpenAIChat(server, {
  name: "chat-completions",
  apiKey: process.env.AI_RELAY_API_KEY!,
});

registerOpenAIChat(server, {
  name: "azure-chat-completions",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
  description: "Azure OpenAI — internal-data tier",
});

registerOpenAIChat(server, {
  name: "local-llm",
  apiKey: "not-needed",
  baseURL: "http://localhost:11434/v1",
  maxOutputTokensCeiling: 8192,
});
```

`tools/list` then exposes `chat-completions`, `azure-chat-completions`,
and `local-llm` as three distinct entries.

---

## API reference

### `registerOpenAIChat(server, config)`

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type OpenAI from "openai";
import type { RequestScope } from "ai-relay/openai";

export interface OpenAIChatConfig {
  name?: string;
  description?: string;
  apiKey: string;
  baseURL?: string;
  maxOutputTokensCeiling?: number;
  requestTimeoutMs?: number;
  openaiClient?: OpenAI;
  requestScope?: RequestScope;
}

export function registerOpenAIChat(server: McpServer, config: OpenAIChatConfig): void;
```

### `makeOpenAIChatHandler(config)` / `openAIChatTool`

`makeOpenAIChatHandler` returns the transport-agnostic bundle
(`{ schema, handler, name, description }`) that `registerOpenAIChat`
binds into MCP. The same factory is exposed as the `makeHandler`
property of the `openAIChatTool` descriptor (importable from
`ai-relay/openai`), which the bundled CLI uses for one-shot
invocation. Build your own dispatcher around either when you don't
have an `McpServer` to register against.

### `verifyBearer(actual, expected)`

Constant-time byte comparison — portable to Node, Bun, Deno, and
Workers without `nodejs_compat`.

### `loadConfig(source)`

```ts
import { loadConfig } from "ai-relay";

const cfg = loadConfig({ env: process.env });
```

Single resolution function for every embed shape. Pass `env`, `file`
(JSON config), and/or `args` (programmatic overrides). The relay app's
HTTP-only schema (`AI_RELAY_AUTH_TOKEN` ≥ 32 bytes, `AI_RELAY_*`
ceilings, `AI_RELAY_PORT`) is private to the deployed `app/` Hono
server — embedders in other runtimes validate their own env.

### `createOpenAIClient(config)`

Lower-level factory that returns an `OpenAI` client wired with
fetch-redaction and a per-client `AsyncLocalStorage` scope.

---

## Result shape

```ts
{
  content: [{ type: "text", text: string }],
  structuredContent: {
    model: string,
    usage?: { prompt_tokens, completion_tokens, total_tokens },
    finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | "function_call",
    code?: ToolErrorCode,
    retryAfter?: number,
  },
  isError: boolean,
}
```

`ToolErrorCode` values: `"auth"`, `"rate_limited"`, `"context_length"`,
`"content_policy"`, `"upstream_error"`, `"bad_request"`.

---

## Compatibility

| Dependency | Version |
|---|---|
| Node.js | 20.x |
| `@modelcontextprotocol/sdk` | `^1.26` |
| `openai` | `^6` |
| `mcp-handler` (optional) | `^1.1` |

The SDK is ESM-only (`"type": "module"`). Transitive `node:` imports
limited to `node:async_hooks`.

---

## Non-goals (v0.x)

- Embeddings / image / audio tools.
- OAuth 2.1 — bearer-shared-secret only.
- Rate limiting / budget caps / observability.

---

## Testing

CLI spawn-harness coverage (real subprocess + mocked upstream) lives in
[`tests/cli/README.md`](./tests/cli/README.md).

## License

MIT.
