# @ragingwind/ai-relay

Provider-agnostic MCP relay SDK. Embed `completion_chat` (OpenAI Chat
Completions, OpenAI-compatible APIs, and unified gateways) — and future
provider tools — into any [Model Context Protocol](https://modelcontextprotocol.io)
server.

The SDK is the durable artifact. The
[mcp-ai-relay](https://github.com/ragingwind/mcp-ai-relay) repository
also ships a Vercel/Next.js reference relay that consumes this package;
see its README for self-hosted Docker and Vercel deployment paths.

> **v0.1.0** ships only the OpenAI provider. Future provider subpaths
> (`./anthropic`, `./gemini`, `./ai-gateway`) will land under their own
> directories without breaking existing `./openai` consumers.

---

## Install

```bash
npm install @ragingwind/ai-relay @modelcontextprotocol/sdk openai
# or
pnpm add @ragingwind/ai-relay @modelcontextprotocol/sdk openai
```

`@modelcontextprotocol/sdk` and `openai` are declared as **peer
dependencies** so the consumer controls their versions. `openai` is
optional in the package metadata — future non-OpenAI subpaths will not
require it — but you need it today for `./openai`.

Requires **Node.js 20+** (or any runtime with `node:async_hooks`
compatibility — Bun, Deno, Cloudflare Workers with `nodejs_compat`).

---

## Quick start

### Zero-config CLI (no code, no install — `npx`)

Easiest path for the single-OpenAI use case. The SDK ships a `bin`
named `mcp-ai-relay`; pass a provider flag and the package launches a
stdio MCP server that registers the matching tool.

Register directly in `claude_desktop_config.json` (Claude Desktop):

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

CLI surface:

```
mcp-ai-relay <provider-flag> [--name <name>] [--description <desc>]

Provider flags (exactly one required):
  --openai-completion   OpenAI Chat Completions
                        Required env: OPENAI_API_KEY
                        Optional env: OPENAI_BASE_URL,
                                      OPENAI_MAX_OUTPUT_TOKENS_CEILING,
                                      OPENAI_REQUEST_TIMEOUT_MS

Options:
  --name <name>         Override the registered MCP tool name
                        (default: completion_chat)
  --description <desc>  Override the tool description
  --help, -h            Show this message
  --version, -V         Print SDK version
```

Future flags (reserved): `--anthropic-messages`, `--gemini-generate`,
`--ai-gateway-chat`. Each follows the same pattern: provider-prefixed
env vars supply the credentials.

**Multi-upstream is intentionally not expressible via the CLI.** Use
the SDK API directly when you want one server hosting OpenAI + Azure +
local LLM as distinct named tools — see
[examples/multi-upstream/](https://github.com/ragingwind/mcp-ai-relay/tree/main/examples/multi-upstream).

### Embed in a Vercel/Next.js MCP route

```ts
// app/api/[transport]/route.ts
import { verifyBearer } from "@ragingwind/ai-relay";
import { parseEnv } from "@ragingwind/ai-relay/env";
import { registerOpenAIChat } from "@ragingwind/ai-relay/openai";
import { createMcpHandler, withMcpAuth } from "mcp-handler";

const env = parseEnv(process.env);

const handler = createMcpHandler(
  (server) => {
    registerOpenAIChat(server, {
      apiKey: env.OPENAI_API_KEY,
      ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
      maxOutputTokensCeiling: env.MAX_OUTPUT_TOKENS_CEILING,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    });
  },
  {},
  { basePath: "/api" },
);

const wrapped = withMcpAuth(
  handler,
  (_req, token) =>
    verifyBearer(token, env.RELAY_AUTH_TOKEN)
      ? { token: token as string, clientId: "shared-secret", scopes: ["openai:chat"] }
      : undefined,
  { required: true, requiredScopes: ["openai:chat"] },
);

export const runtime = "nodejs";
export const maxDuration = 300;
export { wrapped as GET, wrapped as POST, wrapped as DELETE };
```

### Embed in a stdio MCP server (Claude Desktop direct)

```ts
// server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "@ragingwind/ai-relay/openai";

const server = new McpServer({ name: "openai-relay", version: "0.1.0" });
registerOpenAIChat(server, {
  apiKey: process.env.OPENAI_API_KEY!,
});

await server.connect(new StdioServerTransport());
```

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openai-relay": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

### Embed in a Cloudflare Workers MCP

```ts
// src/index.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "@ragingwind/ai-relay/openai";

export class OpenAIRelay extends McpAgent {
  server = new McpServer({ name: "openai-relay", version: "0.1.0" });

  async init() {
    registerOpenAIChat(this.server, { apiKey: this.env.OPENAI_API_KEY });
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
import { registerOpenAIChat } from "@ragingwind/ai-relay/openai";

const server = new McpServer({ name: "multi-relay", version: "0.1.0" });

// OpenAI proper.
registerOpenAIChat(server, {
  name: "openai_chat",
  apiKey: process.env.OPENAI_API_KEY!,
});

// Azure OpenAI deployment.
registerOpenAIChat(server, {
  name: "azure_chat",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
  description: "Azure OpenAI — internal-data tier",
});

// Local Ollama / vLLM (OpenAI-compatible).
registerOpenAIChat(server, {
  name: "local_llm",
  apiKey: "not-needed",
  baseURL: "http://localhost:11434/v1",
  maxOutputTokensCeiling: 8192,
});
```

`tools/list` then exposes `openai_chat`, `azure_chat`, and `local_llm`
as three distinct entries. Each `tools/call` routes to the upstream
captured at registration time. Aborting one in-flight call does not
affect the others.

---

## API reference

### `registerOpenAIChat(server, config)`

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type OpenAI from "openai";
import type { RequestScope } from "@ragingwind/ai-relay/openai";

export interface OpenAIChatConfig {
  /** Registered MCP tool name. Default `"completion_chat"`.
   *  Must be unique within an MCP server when multiple instances are
   *  registered. snake_case is the MCP convention. */
  name?: string;
  /** Description override. Default is the SDK's built-in summary. */
  description?: string;
  /** OpenAI API key. Required unless `openaiClient` is supplied. */
  apiKey: string;
  /** OpenAI base URL override (Azure / vLLM / Ollama / AI Gateway / mock). */
  baseURL?: string;
  /** Server-side ceiling for `max_tokens`. Default 4096. */
  maxOutputTokensCeiling?: number;
  /** Per-request OpenAI timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
  /** Inject a pre-built OpenAI client. When supplied,
   *  `apiKey` / `baseURL` / `requestTimeoutMs` are ignored. */
  openaiClient?: OpenAI;
  /** Inject a request scope paired with `openaiClient`. Required only
   *  when both are supplied AND upstream-body redaction must remain wired. */
  requestScope?: RequestScope;
}

export function registerOpenAIChat(server: McpServer, config: OpenAIChatConfig): void;
```

### `makeOpenAIChatHandler(config)`

The factory `registerOpenAIChat` calls internally. Exposed for advanced
consumers (custom dispatchers, non-McpServer hosts, integration tests).

```ts
export function makeOpenAIChatHandler(config: OpenAIChatConfig): {
  schema: OpenAIChatSchema;
  handler: OpenAIChatHandler;
  name: string;
  description: string;
};
```

### `verifyBearer(actual, expected)`

Constant-time byte comparison using `TextEncoder` and a manual XOR-OR
loop. Portable to Node, Bun, Deno, and Workers without `nodejs_compat`.

```ts
export function verifyBearer(
  actual: string | undefined,
  expected: string | undefined,
): boolean;
```

### `parseEnv(source)` (opt-in subpath)

```ts
import { parseEnv } from "@ragingwind/ai-relay/env";

const env = parseEnv(process.env);  // explicit — no auto-load on import
```

Recognized keys: `OPENAI_API_KEY` (default `""`), `OPENAI_BASE_URL`
(optional URL), `RELAY_AUTH_TOKEN` (required, ≥32 bytes),
`MAX_OUTPUT_TOKENS_CEILING` (default 4096), `REQUEST_TIMEOUT_MS`
(default 60000). Error messages never echo input values.

### `createOpenAIClient(config)`

Lower-level factory that returns an `OpenAI` client wired with
fetch-redaction (5xx body capture) and a per-client `AsyncLocalStorage`
scope. Used internally by `registerOpenAIChat`; exported for consumers
who want to share one client across multiple registrations.

---

## Result shape

```ts
{
  content: [{ type: "text", text: string }],
  structuredContent: {
    model: string,
    usage?: { prompt_tokens, completion_tokens, total_tokens },
    finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | "function_call",
    code?: ToolErrorCode,         // only when isError === true
    retryAfter?: number,           // only on rate_limited
  },
  isError: boolean,
}
```

`ToolErrorCode` values: `"auth"`, `"rate_limited"`, `"context_length"`,
`"content_policy"`, `"upstream_error"`, `"bad_request"`. Error result
text is the SDK's mapped message; the raw upstream body is never echoed
unless it appears in a 5xx fallback path (where the API key is redacted
to `[REDACTED]` before the body is included).

---

## Compatibility

Tested against:

| Dependency | Version |
|---|---|
| Node.js | 20.x |
| `@modelcontextprotocol/sdk` | `^1.26` |
| `openai` | `^6` |
| `mcp-handler` (optional, for Vercel/Next.js) | `^1.1` |

The SDK is ESM-only (`"type": "module"`). Transitive `node:` imports
limited to `node:async_hooks` (used in `createOpenAIClient`); replace
with explicit threading if your runtime lacks AsyncLocalStorage and
upstream-body redaction matters.

---

## Non-goals (v0.x)

- Embeddings / image / audio tools — provider tools beyond chat
  completion are tracked for v1.x via the planned `./openai` companion
  registrars (`registerOpenAIEmbeddings`, etc.).
- OAuth 2.1 — bearer-shared-secret only.
- Rate limiting / budget caps / observability — consumer-side concerns.
- Adapter sub-packages (e.g. `./adapters/mcp-handler`) — kept minimal
  in 0.x; cookbook examples cover wiring.

---

## License

MIT.
