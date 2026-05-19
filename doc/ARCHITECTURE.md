# ARCHITECTURE — mcp-ai-relay

> 한국어: [ARCHITECTURE.ko.md](./ARCHITECTURE.ko.md)

A relay server that exposes the OpenAI Chat Completions API as an MCP
(Model Context Protocol) tool. Shipped as a multi-arch Docker image
(`ghcr.io/ragingwind/ai-relay`, amd64+arm64) built on a minimal Hono HTTP
server. A community-supported Vercel recipe lives in `examples/vercel/`.
When an MCP host such as Claude Code calls in, this server calls OpenAI
and returns the response back to the host.

This document is the single source of truth (SSOT) for v1 architecture.
For background research, tradeoffs, and alternatives considered, see the
sources in the [Reference index](#reference-index).

---

## 1. Core decisions (v1)

| # | Decision | Rationale (summary) |
|---|---|---|
| D1 | **Hono `^4` + `@hono/node-server`** with a single `/api/mcp` route + `/healthz` liveness | Web-Request native, ~30 KB runtime, plays directly with `mcp-handler`'s `(Request) => Promise<Response>` signature without a Next.js dependency |
| D2 | **OpenAI Chat Completions API only** (`/v1/chat/completions`) | Most ubiquitous and stable; Responses API, embeddings, and image tools belong to v2 |
| D3 | **Bearer shared-secret auth** (`withMcpAuth`) | Assumes single-user / small-scale use. OAuth 2.1 belongs to v2 |
| D4 | **Simple architecture** — no observability, rate limiting, or external KV | Observability comes later; rate limiting and budget caps belong to v2 |
| D5 | **Node.js 20.x + multi-arch Docker** (`ghcr.io/ragingwind/ai-relay`, amd64+arm64) | Self-hosted; portable across cloud + on-prem. Vercel target moved to `examples/vercel/` (community-supported) |
| D6 | **Streamable HTTP transport only** (SSE disabled) | Stateless. Avoids Redis dependency |
| D7 | **OpenAI streams are accumulated server-side and returned as a single `CallToolResult`** | MCP `tools/call` returns a single result; there is no token-level streaming channel |
| D8 | **Env interpretation is invocation-derived** | `AI_RELAY_*` keys reinterpret per the invoked provider; multi-provider-per-server is forbidden. See §12.1. |
| D9 | **Tool-name namespacing is deferred-until-collision** | Flat kebab-case names today; `<provider>-<api>` migration only on collision. Reserved right to rename. See §12.2. |
| D10 | **Tool input schemas are upstream-faithful** | Each tool's caller schema mirrors its upstream API; no unified-message abstraction. SDK modules perform syntactic adapters (e.g., Anthropic `system` extraction). See §12.3. |

---

## 2. System diagram

```
┌──────────────────────┐                ┌─────────────────────────────┐                 ┌───────────────────┐
│  MCP Host            │  Streamable    │  Relay  (Node 20.x, Hono)   │  HTTPS/SSE      │  OpenAI API       │
│  (Claude Code, etc.) │  HTTP + Bearer │  ghcr.io/ragingwind/ai-relay│  stream:true    │  /v1/chat/        │
│                      │ ─────────────► │  app/src/index.ts           │ ─────────────► │  completions      │
│                      │                │   ├─ GET /healthz → 200 ok  │                 │                   │
│                      │                │   ├─ ALL /api/mcp           │                 │                   │
│                      │                │   │   ├─ withMcpAuth(bearer)│                 │                   │
│                      │ ◄───────────── │   │   ├─ mcp-handler        │ ◄───────────── │                   │
│                      │  CallToolResult│   │   │   └─ chat-completions    │  delta chunks   │                   │
└──────────────────────┘                │   │   └─ accumulate stream  │                 └───────────────────┘
                                        │   │       → single text     │
                                        │   port: AI_RELAY_PORT       │
                                        │         (default 8787)      │
                                        └─────────────────────────────┘
                                                     │
                                                     ▼
                                          AI_RELAY_API_KEY
                                          AI_RELAY_AUTH_TOKEN
```

---

## 3. Request flow (happy path)

1. The MCP host sends `Authorization: Bearer <AI_RELAY_AUTH_TOKEN>` plus a `tools/call` JSON-RPC message via `POST /api/mcp`.
2. `withMcpAuth` compares the header token to the `AI_RELAY_AUTH_TOKEN` env var in constant time (timing-safe).
3. `mcp-handler` parses the JSON-RPC and invokes the `chat-completions` tool handler.
4. The tool handler validates input with zod → applies the server policy `max_tokens` ceiling → calls the `openai` SDK's `chat.completions.create({ stream: true, ... })` (with an `AbortController` attached).
5. The upstream stream is accumulated as an async iterator (`for await (const chunk of stream)`).
6. The accumulated text and `usage` metadata are serialized as a `CallToolResult`:
   ```ts
   {
     content: [{ type: "text", text: "<accumulated assistant message>" }],
     structuredContent: { model, usage: { prompt_tokens, completion_tokens, total_tokens } },
     isError: false
   }
   ```
7. The MCP host's client LLM merges the result into its context.

### Cancellation / disconnect
- On MCP `notifications/cancelled` → `AbortController.abort()` → the OpenAI request terminates (token billing stops).
- If the HTTP client disconnects, the underlying Node HTTP server aborts `request.signal` (forwarded by Hono via `c.req.raw`) → the same path propagates.

### Error mapping
| Upstream | Response |
|---|---|
| 401/403 (auth) | `isError: true`, `code: "auth"` |
| 429 (rate limit) | `isError: true`, `code: "rate_limited"`, `retryAfter` |
| 400 `context_length_exceeded` | `isError: true`, `code: "context_length"` |
| 400 content policy | `isError: true`, `code: "content_policy"` |
| 5xx / network | `isError: true`, `code: "upstream_error"` |
| Other 4xx | `isError: true`, `code: "bad_request"` |

The non-streaming path uses the SDK default retry (2 attempts). **The streaming path uses `maxRetries: 0`** (mid-stream retry causes duplicated output).

---

## 4. MCP tool definition

### `chat-completions`

Invokes OpenAI Chat Completions once and returns the accumulated text.

**Input schema (Zod, `.strict()`)**

| Field | Type | Required | Notes |
|---|---|---|---|
| `messages` | `Array<{role: "system"|"user"|"assistant", content: string}>` | ✅ | OpenAI Chat shape |

The caller-facing surface is intentionally minimal — `model` and all sampling parameters (`temperature`, `max_tokens`, `top_p`, `stop`) are configured per server instance and forwarded automatically on every call. Callers that include any of these fields in `tools/call` arguments will have them silently stripped by the MCP SDK validator before the handler runs.

**Server-side configuration (`OpenAIChatConfig` / `AI_RELAY_*` env)**

| Field | Env | Required | Notes |
|---|---|---|---|
| `model` | `AI_RELAY_MODEL` | ✅ | Forwarded as-is to the upstream Chat Completions endpoint |
| `temperature` | `AI_RELAY_TEMPERATURE` | ❌ | 0..2; forwarded when set |
| `max_tokens` | `AI_RELAY_MAX_TOKENS` | ❌ | Positive integer; forwarded as-is — no clamp applied |
| `top_p` | `AI_RELAY_TOP_P` | ❌ | 0..1; forwarded when set |
| `stop` | `AI_RELAY_STOP` | ❌ | Single string or comma-separated list |

**Output schema**

```ts
{
  content: [{ type: "text", text: string }],
  structuredContent: {
    model: string,
    usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number },
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call"
  }
}
```

**Notes**:
- `tool_choice` / `tools` parameters are not supported in v1 — tool calls are not forwarded.
- If a function/tool call appears in the response, it is not serialized to text; instead the tool surfaces `finish_reason: "tool_calls"` so the host LLM can decide what to do.

### `messages` (Anthropic provider)

Invokes Anthropic Messages once and returns the accumulated assistant text. The caller-facing input/output schemas are identical to `chat-completions` (per D10 — upstream-faithful schema policy).

**Input schema (Zod, `.strict()`)** — identical to `chat-completions`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `messages` | `Array<{role: "system"|"user"|"assistant", content: string}>` | ✅ | Leading `system` messages are extracted into Anthropic's top-level `system` field (joined with `\n\n` if multiple); non-leading `system` is rejected with `bad_request` |

**Server-side configuration (`AnthropicMessagesConfig` / `AI_RELAY_*` env)**

| Field | Env | Required | Notes |
|---|---|---|---|
| `model` | `AI_RELAY_MODEL` | ✅ | Forwarded as-is to the upstream Messages endpoint |
| `temperature` | `AI_RELAY_TEMPERATURE` | ❌ | **0..1** (OpenAI uses 0..2); forwarded when set |
| `max_tokens` | `AI_RELAY_MAX_TOKENS` | ❌ | Positive integer. **Defaults to 1024** when omitted — Anthropic requires this field on every call |
| `top_p` | `AI_RELAY_TOP_P` | ❌ | 0..1; forwarded when set |
| `stop` | `AI_RELAY_STOP` | ❌ | Single string or comma-separated list; translated to `stop_sequences: string[]` upstream |

**Output schema** — identical to `chat-completions` (`structuredContent.model`, `usage` with `prompt_tokens` + `completion_tokens` + `total_tokens`, `finish_reason`, `code`, `retryAfter`).

#### Anthropic `stop_reason` → `finish_reason` mapping

| Anthropic `stop_reason` | Surfaced `finish_reason` | Notes |
|---|---|---|
| `end_turn` | `stop` | Normal completion |
| `max_tokens` | `length` | Cap hit |
| `stop_sequence` | `stop` | One of `stop_sequences` matched |
| `tool_use` | `tool_calls` | Mirrors OpenAI `tool_calls` (tools not forwarded in v1) |
| `refusal` | `content_filter` | Also sets `isError: true` and `code: "content_policy"` |

---

## 5. Directory structure

```
mcp-ai-relay/                              # repo root — pnpm workspace orchestrator
├── app/                                # private workspace package — Hono HTTP server
│   ├── src/
│   │   ├── index.ts                    # MCP entry — Hono app: GET /healthz + ALL /api/mcp
│   │   └── env.ts                      # AI_RELAY_* env validation (zod, redacted errors)
│   ├── package.json                    # private; deps: hono, @hono/node-server, mcp-handler, ai-relay (workspace:*)
│   ├── tsconfig.json
│   └── Dockerfile                      # multi-stage; alpine; pnpm deploy --prod for runtime tree
├── packages/
│   └── ai-relay/                       # publishable SDK
│       ├── src/
│       │   ├── index.ts                # public re-exports (auth)
│       │   ├── auth.ts                 # verifyBearer (portable, no node:crypto)
│       │   ├── bin/
│       │   │   ├── ai-relay.ts         # bin entry — `ai-relay <provider>` MCP stdio server
│       │   │   ├── ai-relay-cli.ts     # bin entry — `ai-relay-cli <provider> <tool> [flags] [input]` one-shot
│       │   │   ├── mcp-server.ts       # startMcpServer({apiType,config}) — pure library function
│       │   │   ├── run.ts              # one-shot CLI orchestrator (used by ai-relay-cli)
│       │   │   ├── parse.ts            # parseArgv (CLI) + parseMcpArgv (MCP)
│       │   │   ├── registry.ts         # api-type → {cli, registerMcp} map
│       │   │   └── env-file.ts         # minimal dotenv parser
│       │   └── openai/
│       │       ├── index.ts            # provider re-exports
│       │       ├── chat.ts             # registerOpenAIChat + makeOpenAIChatHandler
│       │       └── client.ts           # createOpenAIClient factory
│       ├── tests/
│       │   ├── setup-env.ts
│       │   └── unit/
│       │       ├── auth.test.ts
│       │       ├── chat.test.ts
│       │       ├── env.test.ts
│       │       └── multi-registration.test.ts
│       ├── package.json                # exports map + peerDeps + tsc build
│       ├── tsconfig.json               # extends root (typecheck mode)
│       ├── tsconfig.build.json         # emits dist/ for npm consumers
│       └── vitest.config.ts
├── tests/
│   ├── setup-env.ts                    # seeds process.env for the integration test
│   └── integration/
│       ├── route.test.ts               # imports `{ app }` from app/src/index.ts; calls app.fetch(request)
│       └── app-env.test.ts             # exercises app/src/env.ts (AI_RELAY_AUTH_TOKEN, AI_RELAY_PORT)
├── scripts/
│   ├── verify.mjs                      # automated C1/C2/C5 smoke against pnpm dev
│   ├── mcp-inspect.mjs                 # ad-hoc tools/call wrapping MCP Inspector CLI
│   └── check-dev-env.mjs               # pre-flight env check for pnpm dev
├── examples/
│   └── vercel/                         # community-supported Vercel deploy recipe
│       ├── README.md
│       └── vercel.json                 # ex-root config (pins maxDuration + region)
├── .github/workflows/
│   ├── ci.yml                          # typecheck + lint + build + test on PR
│   └── release-app.yml                 # multi-arch buildx → ghcr push on `v*` tags
├── doc/
│   ├── ARCHITECTURE.md                 # this document — design SSOT
│   ├── DEPLOY.md                       # Docker + Vercel runbook
│   └── QA-MCP-INSPECTOR.md             # manual verification procedure
├── CLAUDE.md                           # AI agent collaboration guide
├── compose.yml                         # production: pulls ghcr.io/ragingwind/ai-relay:latest
├── compose.dev.yml                     # local-build: builds from app/Dockerfile
├── pnpm-workspace.yaml                 # workspace declares packages/* + examples/* + app
├── package.json                        # workspace orchestrator; depends on ai-relay (workspace:*)
├── tsconfig.json
├── biome.json
├── vitest.workspace.ts                 # SDK unit + integration projects
├── .env.example
└── .gitignore
```

---

## 6. Tech stack (confirmed)

| Area | Choice |
|---|---|
| Framework | Hono `^4` + `@hono/node-server` `^1.13` |
| MCP handler | `mcp-handler@^1.1` |
| MCP SDK | `@modelcontextprotocol/sdk@^1.26` |
| Validation | `zod@^4` |
| OpenAI SDK | `openai@^6` (optional peer dep) |
| Anthropic SDK | `@anthropic-ai/sdk@^0.96.0` (optional peer dep) |
| Runtime | Node.js `20.x` (alpine container; multi-arch amd64+arm64) |
| Language | TypeScript strict, NodeNext ESM, `verbatimModuleSyntax: true` |
| Package manager | pnpm `^9` (pinned via `packageManager`) |
| Lint/Format | Biome `^2` |
| Test | vitest + msw (mock at the HTTP boundary) |
| Deployment | `ghcr.io/ragingwind/ai-relay` multi-arch image; `compose.yml` for production, `compose.dev.yml` for local builds. Vercel recipe in `examples/vercel/` (community-supported). |
| SDK build | `tsc -p tsconfig.build.json` → `packages/ai-relay/dist/`; ESM. peerDeps: `@modelcontextprotocol/sdk` (required); `openai` and `@anthropic-ai/sdk` are optional — install only the SDK for the provider(s) you use |
| App build | `tsc -p app/tsconfig.json` → `app/dist/`; runtime image uses `pnpm deploy --prod /deploy` to produce a self-contained tree |

### Container release

Multi-arch image (amd64 + arm64) built and pushed by
[`.github/workflows/release-app.yml`](../.github/workflows/release-app.yml)
on every `v*` tag (and on demand via `workflow_dispatch`):

- `ghcr.io/ragingwind/ai-relay:vX.Y.Z` — versioned tag
- `ghcr.io/ragingwind/ai-relay:latest` — updated when pushed from default branch
- Healthcheck baked into the image (`HEALTHCHECK ... /healthz`) — `compose.yml` inherits it.

### Vercel recipe (community-supported)

`examples/vercel/vercel.json` retains the original `regions: ["iad1"]` +
`functions[..].maxDuration: 300` shape. To deploy, build a thin Next.js
project that consumes `ai-relay` from npm (see `examples/vercel/README.md`).

### `tsconfig.json` essentials
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

---

## 7. Environment variables

`AI_RELAY_*` keys are interpreted per the provider passed at invocation (`ai-relay <provider>`). A given process serves exactly one provider; running multiple providers on one MCP server is not supported (see §12.1).

| Key | Required | Secret | Description |
|---|---|---|---|
| `AI_RELAY_API_KEY` | ✅ | Sensitive | Upstream API key. Recommend separate keys for Production/Preview. |
| `AI_RELAY_AUTH_TOKEN` | ✅ | Sensitive | Bearer token sent by the MCP host. 32+ random bytes. |
| `AI_RELAY_MODEL` | ✅ | Plain | Upstream model id forwarded on every `tools/call`. The caller-facing tool input does not accept `model`. |
| `AI_RELAY_BASE_URL` | ❌ | Plain | Override the upstream base URL. Default: SDK built-in. Use to point at Azure OpenAI, a self-hosted vLLM/Ollama gateway, or a local mock. See [`examples/baseurl-recipes/`](../examples/baseurl-recipes/) for per-upstream configuration. |
| `AI_RELAY_TEMPERATURE` | ❌ | Plain | Float. Range depends on provider: **0..2 for `openai`**, **0..1 for `anthropic`**. Forwarded as `temperature` to every upstream call when set. |
| `AI_RELAY_MAX_TOKENS` | ❌ | Plain | Positive integer. Forwarded as `max_tokens` to every upstream call. No server-side clamp is applied — set conservatively. For `anthropic`: defaults to `1024` when omitted (Anthropic requires this field per call). |
| `AI_RELAY_TOP_P` | ❌ | Plain | Float 0..1. Forwarded as `top_p` to every upstream call when set. |
| `AI_RELAY_STOP` | ❌ | Plain | Single value or comma-separated list (`END` or `END,STOP`). Forwarded as `stop` to every upstream call. |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | ❌ | Plain | Integer. Default `60000`. Upstream call timeout. |
| `AI_RELAY_PORT` | ❌ | Plain | Integer 1..65535. Default `8787`. Bind port for the Hono server. |

Record keys only in `.env.example`; never commit values. Register the secrets via your container orchestrator's secret store (Docker `--env-file`, k8s Secret, etc.). The Vercel community recipe uses Vercel's Sensitive env vars.

---

## 8. Authentication (v1)

```ts
// lib/auth.ts (concept)
import { timingSafeEqual } from "node:crypto";

export function verifyToken(req: Request, bearerToken: string | undefined) {
  if (!bearerToken) return undefined;            // unauthenticated
  const expected = process.env.AI_RELAY_AUTH_TOKEN;
  if (!expected) return undefined;                // fail-closed
  const a = Buffer.from(bearerToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return undefined;
  if (!timingSafeEqual(a, b)) return undefined;
  return { clientId: "shared-secret", scopes: ["openai:chat"] };
}
```

Wrap the route handler with `withMcpAuth(handler, verifyToken, { required: true, requiredScopes: ["openai:chat"] })`.
On unauthenticated requests, `mcp-handler` automatically responds with 401 + `WWW-Authenticate` + the `/.well-known/oauth-protected-resource` headers.

> When graduating to OAuth 2.1 in v2, only `verifyToken` needs to change — the route signature stays the same.

---

## 9. Security — v1 minimum set

- Never echo `AI_RELAY_API_KEY` in responses, logs, or error messages.
- Always compare bearer tokens with `timingSafeEqual`.
- All tool inputs must be strictly validated with zod (use `.strict()`).
- `max_tokens` accepts the caller's value but is clamped to the server ceiling.
- `console` logs may include only metadata (model, token counts, latency, status). **Never log prompt/response bodies at default/info levels.**
- **`--verbose` carve-out**: when explicitly enabled via `--verbose` flag or `AI_RELAY_VERBOSE=1`, the stderr trace MAY emit full request/response bodies (tool arguments, accumulated assistant text, OpenAI HTTP body). Secrets — API keys, bearer tokens, `Authorization` header values, and env vars whose names match `*_KEY`/`*_TOKEN` — remain redacted via `redactSecret()`. The verbose stream is operator-only diagnostic output: never persist it to shared logging, PR comments, or git. See [CLAUDE.md §4](../CLAUDE.md#4-coding-conventions-repo-specific) for the operational policy.
- Container images run as a non-root `app` user (uid 1001); orchestrators should not override with root.
- The published image is private by default — flip to public via Settings → Packages → ai-relay only when ready.

### Not included in v1 (intentional)
- Rate limiting (Upstash, etc.)
- Daily token/dollar budget counters
- OAuth 2.1
- External observability (Sentry, OTel, Axiom)
- Per-caller usage tracking

These items are listed as v2 candidates in §11.

---

## 10. Testing strategy (v1)

| Layer | Tools | Scope |
|---|---|---|
| Unit (SDK) | vitest + msw, run inside `packages/ai-relay/` | `verifyBearer`, `parseEnv`, `registerOpenAIChat` factory — input validation, max_tokens clamp, error mapping |
| Multi-registration | vitest + msw, real `McpServer` | Same server registered against multiple times with different `name` + `apiKey` + `baseURL` — each handler routes to its own upstream with no cross-talk |
| Integration | vitest, Hono `app.fetch(request)` invoked directly with Web `Request`/`Response` | Bearer auth (present/missing/invalid), MCP `tools/list` and `tools/call` JSON-RPC flows, `/healthz` liveness, `AI_RELAY_PORT` validation |
| Manual E2E | MCP Inspector | Locally run `pnpm dev` → `npx @modelcontextprotocol/inspector` → Streamable HTTP, connect to `http://localhost:8787/api/mcp` |

Principle: **mock only the OpenAI HTTP boundary** (MSW). Never mock the SDK module itself — the risk of missing an SDK upgrade is too high.

---

## 11. Future work (v2+ backlog)

- **Responses API support** (add a `responses` tool — see §12.2 naming policy)
- **Embeddings / image** tools
- **OAuth 2.1** authentication (swap the `withMcpAuth` token verifier)
- **Rate limiting** — Upstash Ratelimit (Edge Middleware, IP + token two-tier)
- **Budget caps** — Upstash Redis daily token/dollar counters
- **Observability** — OpenTelemetry traces + Pino NDJSON logs + (optional) Sentry
- **Progress notifications** — handle `_meta.progressToken` and emit progress messages
- **Tools/function-calling pass-through** — serialize `tool_calls` results into `structuredContent`

---

## 12. Architectural policies

These policies govern how the SDK expands beyond a single provider. They are load-bearing for issues #91 (Anthropic), #92 (OpenAI Responses), #93 (Google Gemini), and any future provider work.

### 12.1 Env interpretation (D8)

`AI_RELAY_*` env keys retain stable names regardless of which provider is in use. Their meaning is **derived from the provider passed at invocation**:

- `ai-relay openai`     → `AI_RELAY_API_KEY` is the OpenAI key, `AI_RELAY_MODEL` is an OpenAI model id (`gpt-5-mini`).
- `ai-relay anthropic`  → same keys, interpreted as Anthropic (`claude-sonnet-4-6`, …).
- `ai-relay google`     → same keys, interpreted as Gemini (`gemini-2.5-pro`).

**Multi-provider-per-server is not supported.** A given process serves exactly one provider; running `openai` and `anthropic` tools on the same MCP server is out of scope. Operators who need multiple providers run multiple processes, each with its own provider invocation and env.

Rationale: avoids env-name explosion (`AI_RELAY_OPENAI_API_KEY` / `AI_RELAY_ANTHROPIC_API_KEY` / …) and matches how operators actually deploy — one container per upstream.

### 12.2 Tool-name namespacing (D9)

MCP tool names stay flat kebab-case while no collision exists:

| Provider   | Tool name           |
|------------|---------------------|
| OpenAI     | `chat-completions`  |
| OpenAI     | `responses`         |
| Anthropic  | `messages`          |
| Google     | `generate-content`  |

When a true name collision arises (e.g., a future provider also defining `messages`), tools migrate to `<provider>-<api>` form (`anthropic-messages`, `gemini-messages`, …) in a single coordinated release. **The project reserves the right to rename tools on collision.** Early adopters relying on flat names are warned to expect this migration.

Rationale: namespace decoration before need is premature. Migration cost is small (rename + minor version bump); current cost of always-namespacing is larger (uglier names, breaking change for v0.x consumers already shipping flat names).

### 12.3 Schema policy (D10)

Each MCP tool exposes the **native shape of its upstream API** as input. There is no unified-message abstraction across providers. Where the upstream shape differs from the caller-facing convention, the SDK module performs a **translation** internally — never a normalization that pretends two providers have the same surface.

Concrete example (Anthropic): the caller passes `{ messages: [{ role: 'system' | 'user' | 'assistant', content: string }] }` matching the OpenAI Chat shape. The Anthropic SDK module extracts leading `role: 'system'` entries to Anthropic's top-level `system: string` parameter before calling `client.messages.create(...)`. This is a **syntactic adapter**, not a schema unification: caller schemas for OpenAI Chat and Anthropic Messages remain independently versioned.

Rationale: pretending a unified shape exists creates lies at the schema boundary and rots as providers diverge. Gemini's `contents`/`parts` shape is the closest example of why this matters — a forced normalization would lose information that future provider features may need.

---

## Reference index

### MCP spec / SDK
- [MCP Specification 2025-11-25 (overview)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Spec — Server: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Spec — Basic: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Spec — Utility: Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [MCP Spec — Utility: Cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)
- [MCP Spec — Authorization (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP Inspector docs](https://modelcontextprotocol.io/legacy/tools/inspector)
- [MCP Inspector repo](https://github.com/modelcontextprotocol/inspector)

### Vercel mcp-handler
- [npm: mcp-handler](https://www.npmjs.com/package/mcp-handler)
- [github.com/vercel/mcp-handler](https://github.com/vercel/mcp-handler)
- [Vercel docs — Deploy MCP servers to Vercel](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Vercel blog — Building efficient MCP servers](https://vercel.com/blog/building-efficient-mcp-servers)
- [Vercel template — MCP with Next.js](https://vercel.com/templates/next.js/model-context-protocol-mcp-with-next-js)

### Vercel platform
- [Vercel — Functions Limits](https://vercel.com/docs/functions/limitations)
- [Vercel — Configuring Maximum Duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel — Fluid compute](https://vercel.com/docs/fluid-compute)
- [Vercel — Runtimes](https://vercel.com/docs/functions/runtimes)
- [Vercel — Configuring regions](https://vercel.com/docs/functions/configuring-functions/region)
- [Vercel — Environment Variables](https://vercel.com/docs/environment-variables)
- [Vercel — Sensitive Environment Variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
- [Vercel — Bypass body size limit](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
- [Vercel — Package Managers](https://vercel.com/docs/package-managers)
- [Vercel KB — April 2026 Security Incident](https://vercel.com/kb/bulletin/vercel-april-2026-security-incident)
- [Vercel — Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)

### OpenAI
- [openai-node README](https://github.com/openai/openai-node)
- [openai npm metadata](https://registry.npmjs.org/openai/latest)
- [OpenAI — Migrate to Responses](https://platform.openai.com/docs/guides/migrate-to-responses)
- [OpenAI — API Deprecations](https://developers.openai.com/api/docs/deprecations)
- [OpenAI — Rate Limits Guide](https://developers.openai.com/api/docs/guides/rate-limits)

### Claude Code / Claude Desktop
- [Claude Code — MCP docs (`claude mcp add`, scopes, `.mcp.json`)](https://code.claude.com/docs/en/mcp)
- [Claude — Custom Integrations via Remote MCP (Connectors UI)](https://support.claude.com/en/articles/11175166-getting-started-with-custom-integrations-using-remote-mcp)

### Tools / libraries
- [Zod](https://zod.dev/)
- [Biome](https://biomejs.dev/)
- [Vitest](https://vitest.dev/)
- [MSW](https://mswjs.io/)
