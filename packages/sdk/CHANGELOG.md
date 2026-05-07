# Changelog

All notable changes to `@ragingwind/mcp-ai-relay` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 ships. Pre-v1.0 minor bumps may include breaking changes — read
this file before upgrading.

## [0.1.0] — Unreleased

First public release. Extracts the durable, framework-agnostic core of
[mcp-ai-relay](https://github.com/ragingwind/mcp-ai-relay) into a
publishable npm package.

### Added

- **`registerOpenAIChat(server, config)`** — register the
  `completion_chat` MCP tool on any `McpServer`. Each call creates an
  independent closure; the same server may be registered against
  multiple times with different `name` + `apiKey` + `baseURL` to expose
  multiple upstreams as distinct tools (OpenAI proper, Azure OpenAI,
  vLLM, Ollama, OpenRouter, Vercel AI Gateway in OpenAI mode).
- **`makeOpenAIChatHandler(config)`** — same factory exposed at handler
  granularity for advanced consumers (custom dispatchers, non-McpServer
  hosts, integration tests).
- **`verifyBearer(actual, expected)`** — constant-time bearer-token
  comparison using `TextEncoder` + a manual XOR-OR loop. Portable to
  Node, Bun, Deno, and Cloudflare Workers without `nodejs_compat`.
- **`parseEnv(source)`** (subpath `./env`) — opt-in zod-validated
  environment parser. Side-effect-free on import; the consumer chooses
  when to read `process.env`.
- **`createOpenAIClient(config)`** (subpath `./openai`) — lower-level
  factory exposing the OpenAI SDK instance + per-client
  `AsyncLocalStorage` scope used for upstream-error redaction.
- Subpath exports: `.`, `./auth`, `./env`, `./openai`. Future provider
  subpaths (`./anthropic`, `./gemini`, `./ai-gateway`) will be added
  without breaking existing consumers.

### Tested against

- Node.js 20.x (engine declaration)
- `@modelcontextprotocol/sdk@^1.26`
- `openai@^6`
- `mcp-handler@^1.1` (for Vercel/Next.js consumers)

### Notes for early adopters

- API surface is **stable in shape but pre-1.0** — minor bumps may
  refine names. v1.0 freezes the surface (planned after ≥4 weeks of
  dogfooding).
- `openai` is a peer dependency marked `optional`. The 0.1.0 SDK ships
  only the `./openai` subpath, so consumers do need it today —
  `peerDependenciesMeta.openai.optional = true` is forward-looking for
  the planned `./anthropic` / `./gemini` / `./ai-gateway` subpaths.
- `AsyncLocalStorage` is required for the upstream-body redaction
  feature. Workers must enable `compatibility_flags = ["nodejs_compat"]`;
  runtimes without AsyncLocalStorage get a no-op fallback (the SDK's
  default error message remains, just without the redacted snippet).
