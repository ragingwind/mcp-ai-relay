# ai-relay

Provider-agnostic MCP relay SDK. Embed OpenAI Chat Completions (and any OpenAI-compatible upstream — Azure, vLLM, Ollama, AI Gateway) as MCP tools.

## Install

```bash
npm install ai-relay @modelcontextprotocol/sdk openai
```

`@modelcontextprotocol/sdk` and `openai` are peer dependencies — the consumer controls their versions. Requires **Node.js 20+** (or any runtime with `node:async_hooks` compatibility — Bun, Deno, Cloudflare Workers with `nodejs_compat`).

---

## Quick reference

**1. One-shot CLI** — `ai-relay-cli <provider> <tool> [flags] [input]`:

```bash
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini "ping"
```

**2. stdio MCP server** — `ai-relay <provider>`, register in any MCP host:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "openai", "-m", "gpt-4o-mini"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

**3. SDK embed** — `registerOpenAIChat(server, config)`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, {
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-4o-mini",
});
await server.connect(new StdioServerTransport());
```

**4. Multi-upstream** — one server, multiple `registerOpenAIChat` calls with distinct `name` values (each call captures its own `model`):

```ts
registerOpenAIChat(server, {
  name: "chat-completions",
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-4o-mini",
});
registerOpenAIChat(server, {
  name: "azure-chat-completions",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
  model: "gpt-4o",
});
```

---

## 1. One-shot CLI (`ai-relay-cli`)

Prints a single tool result as JSON on stdout, exits. Input is a positional argument or piped via stdin (XOR). A positional starting with `{` or `[` is parsed as JSON; anything else becomes a plain user message. Exit codes: `0` success, `1` runtime/upstream error, `2` usage error.

```bash
ai-relay-cli openai chat-completions -m gpt-4o-mini "ping"
ai-relay-cli openai chat-completions --model gpt-4o-mini -s "be terse" "explain TLS"
ai-relay-cli openai chat-completions -m gpt-4o --temperature 0.2 \
  '{"messages":[{"role":"user","content":"ping"}]}'
ai-relay-cli openai chat-completions -m gpt-4o-mini --base-url https://my-azure.openai.azure.com/v1 "ping"
echo '{"messages":[…]}' | ai-relay-cli openai chat-completions -m gpt-4o-mini
```

**Model resolution** (first match wins): `-m`/`--model` flag → `AI_RELAY_MODEL` env. The caller schema is `{ messages }` only and `.strict()` rejects extra keys, so JSON input cannot include a `model` field.

| Flag | Purpose |
|---|---|
| `-m, --model <id>` | Model id (e.g. `gpt-4o-mini`) — required (flag or `AI_RELAY_MODEL`) |
| `-s, --system <text>` | System message prepended to plain-text input |
| `--api-key <key>` | Override `AI_RELAY_API_KEY` |
| `--base-url <url>` | Override `AI_RELAY_BASE_URL` |
| `--max-tokens <n>` | Forwarded upstream as `max_tokens` (or `AI_RELAY_MAX_TOKENS`) |
| `--temperature <f>` | Sampling temperature 0..2 (or `AI_RELAY_TEMPERATURE`) |
| `--top-p <f>` | Nucleus sampling 0..1 (or `AI_RELAY_TOP_P`) |
| `--stop <csv>` | Stop sequence(s), comma-separated (or `AI_RELAY_STOP`) |
| `--timeout <ms>` | Per-request timeout |
| `--env <path>` | Load `AI_RELAY_*` from a dotenv file |
| `-v, --verbose` | Trace stages to stderr (also: `AI_RELAY_VERBOSE=1`) |

Verbose mode prints `argv`, `parsed-flags`, `loaded-config`, `openai-request`, `result`, etc. to stderr. Secrets are length-redacted; response body text never leaks to stderr.

---

## 2. stdio MCP server (`ai-relay`)

Long-lived stdio MCP server. The `<provider>` positional (today: `openai`) selects which upstream is mounted; all of that provider's tools are then registered. Today: `openai` mounts `chat-completions`.

Project-local `.mcp.json` with an absolute bin path:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "node",
      "args": ["./node_modules/ai-relay/dist/bin/ai-relay.js", "openai", "-m", "gpt-4o-mini"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

`-m`/`--model` (or `AI_RELAY_MODEL` in `env`) is required. `--api-key`, `--base-url`, `--max-tokens`, `--temperature`, `--top-p`, `--stop`, `--timeout`, `--env` are accepted as flags too — pass them in `args` after the provider name.

For HTTP/SSE MCP transport instead of stdio, deploy the reference Hono app in this repo's [`app/`](https://github.com/ragingwind/mcp-ai-relay/tree/main/app) — see the project root README.

---

## 3. Embed via `registerOpenAIChat`

The quick reference above shows the stdio variant. Same function for Hono/HTTP and Cloudflare Workers.

### Hono / Node HTTP route

```ts
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
      model: provider.model,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
      ...(provider.max_tokens !== undefined ? { max_tokens: provider.max_tokens } : {}),
      ...(provider.top_p !== undefined ? { top_p: provider.top_p } : {}),
      ...(provider.stop !== undefined ? { stop: provider.stop } : {}),
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

### Cloudflare Workers

```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "ai-relay/openai";

export class OpenAIRelay extends McpAgent {
  server = new McpServer({ name: "openai-relay", version: "0.1.0" });

  async init() {
    registerOpenAIChat(this.server, {
      apiKey: this.env.AI_RELAY_API_KEY,
      model: this.env.AI_RELAY_MODEL,
    });
  }
}
```

`wrangler.toml` needs `compatibility_flags = ["nodejs_compat"]` so `AsyncLocalStorage` is available. Without it the SDK still works; upstream 5xx body snippets just won't appear in error result text.

---

## 4. Multi-upstream

`registerOpenAIChat` is closure-isolated — each call captures its own client, ceiling, and timeout. Call it any number of times with distinct `name` values to expose multiple upstreams as separate tools on one server.

```ts
const server = new McpServer({ name: "multi-relay", version: "0.1.0" });

registerOpenAIChat(server, {
  name: "chat-completions",
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-4o-mini",
});

registerOpenAIChat(server, {
  name: "azure-chat-completions",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
  model: "gpt-4o",
});

registerOpenAIChat(server, {
  name: "local-llm",
  apiKey: "not-needed",
  baseURL: "http://localhost:11434/v1",
  model: "llama3",
  max_tokens: 8192,
});
```

`tools/list` exposes `chat-completions`, `azure-chat-completions`, and `local-llm`. Each tool is invoked with `{ messages }` only; the upstream model and sampling parameters captured at `registerOpenAIChat` time are authoritative.

---

## API

```ts
import { registerOpenAIChat, makeOpenAIChatHandler, openAIChatTool } from "ai-relay/openai";
import { verifyBearer, loadConfig } from "ai-relay";
import { createOpenAIClient } from "ai-relay/openai";

interface OpenAIChatConfig {
  name?: string;
  description?: string;
  apiKey: string;
  baseURL?: string;
  model: string;                    // required — caller-facing input does not accept model
  temperature?: number;             // forwarded as-is to every upstream call
  max_tokens?: number;              // forwarded as-is; no server-side clamp
  top_p?: number;
  stop?: string | string[];
  requestTimeoutMs?: number;        // default 60000
  openaiClient?: OpenAI;            // inject your own client
  requestScope?: RequestScope;
}

registerOpenAIChat(server: McpServer, config: OpenAIChatConfig): void;
makeOpenAIChatHandler(config): { schema, handler, name, description };  // transport-agnostic
verifyBearer(actual: string, expected: string): boolean;                 // constant-time
loadConfig({ env?, file?, args? }): { providers: [...] };                // env/file/args resolution
createOpenAIClient(config): OpenAI;                                       // lower-level factory
```

## Result shape

```ts
{
  content: [{ type: "text", text: string }],
  structuredContent: {
    model: string,
    usage?: { prompt_tokens, completion_tokens, total_tokens },
    finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | "function_call",
    code?: "auth" | "rate_limited" | "context_length" | "content_policy" | "upstream_error" | "bad_request",
    retryAfter?: number,
  },
  isError: boolean,
}
```

## Compatibility

| Dependency | Version |
|---|---|
| Node.js | 20+ |
| `@modelcontextprotocol/sdk` | `^1.26` |
| `openai` | `^6` |
| `mcp-handler` (optional) | `^1.1` |

ESM-only (`"type": "module"`). Only `node:` import is `node:async_hooks`.

## License

MIT.
