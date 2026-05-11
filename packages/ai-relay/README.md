# ai-relay

Provider-agnostic MCP relay SDK. Embed `openai_chat` (OpenAI Chat
Completions, OpenAI-compatible APIs, and unified gateways) — and future
provider tools — into any [Model Context Protocol](https://modelcontextprotocol.io)
server.

The SDK also ships a one-shot CLI (`ai-relay <provider> <tool>`) that
invokes the same tool descriptors used by the SDK registrars — handy
for shell pipelines and quick experimentation. The
[mcp-ai-relay](https://github.com/ragingwind/mcp-ai-relay) repository
ships a Vercel/Next.js HTTP MCP server built on this package; see its
README for deployment paths.

> **v0.2.0** ships only the OpenAI provider. Future provider subpaths
> (`./anthropic`, `./gemini`, `./ai-gateway`) will land under their own
> directories without breaking existing `./openai` consumers.

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

## CLI

`ai-relay <provider> <tool> -m <model> [flags] [input]` — one-shot
invocation that prints the tool result as JSON on stdout.

```bash
ai-relay openai chat -m gpt-4o-mini "ping"
ai-relay openai chat -m gpt-4o-mini -s "be terse" "explain TLS"
ai-relay openai chat -m gpt-4o-mini '{"messages":[{"role":"user","content":"ping"}]}'
ai-relay openai chat -m gpt-4o-mini --env ./prod.env "ping"
echo '{"messages":[…]}' | ai-relay openai chat -m gpt-4o-mini
```

`-m/--model` is required. Input is either a positional argument or
piped via stdin (exactly one). A positional starting with `{` or `[`
is parsed as a JSON literal; anything else is treated as a plain user
message and folded into a `messages` array (with `-s/--system`
prepended when supplied). Exit code is `0` on success, `1` on a
runtime/upstream error, `2` on a usage error.

| Flag | Purpose |
|------|---------|
| `-m, --model <id>` | Required. Model id (e.g. `gpt-4o-mini`). |
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

### Claude Desktop integration

The CLI is intentionally one-shot and does **not** speak the long-lived
stdio MCP protocol. Wire Claude Desktop at the HTTP MCP endpoint of a
deployed relay (Vercel / Cloudflare Workers / your own host) instead —
the reference relay in this repo serves `/api/mcp`. See the
[stdio example](https://github.com/ragingwind/mcp-ai-relay/tree/main/examples/stdio)
for how to compose `registerOpenAIChat` into your own stdio MCP server
when that is what you need.

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
  name: "openai_chat",
  apiKey: process.env.AI_RELAY_API_KEY!,
});

registerOpenAIChat(server, {
  name: "azure_chat",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
  description: "Azure OpenAI — internal-data tier",
});

registerOpenAIChat(server, {
  name: "local_llm",
  apiKey: "not-needed",
  baseURL: "http://localhost:11434/v1",
  maxOutputTokensCeiling: 8192,
});
```

`tools/list` then exposes `openai_chat`, `azure_chat`, and `local_llm`
as three distinct entries.

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

## License

MIT.
