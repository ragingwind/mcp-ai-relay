# Changelog

All notable changes to `ai-relay` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 ships. Pre-v1.0 minor bumps may include breaking changes — read
this file before upgrading.

## [0.4.1] — 2026-05-12

### Fixed

- **`max_tokens: 0` now accepted as "use default"** — 0.4.0 rejected
  zero with `Too small: expected number to be >0`, which broke clients
  that emit `0` from a numeric input field to mean "no specific limit".
  Zero is now treated the same as omitted: the configured ceiling
  (default 4096) is injected. Negative values are still rejected.
  Positive values clamp to the ceiling as before.

## [0.4.0] — 2026-05-12

### Changed (BREAKING — caller-visible)

- **`max_tokens` defaults to the configured ceiling** when the caller
  omits it. Previously, an omitted `max_tokens` was passed through
  unset, leaving the upstream's own default in effect (often unbounded
  or model-specific). Every upstream call now carries an explicit cap
  — `maxOutputTokensCeiling` (default 4096; override with
  `AI_RELAY_MAX_OUTPUT_TOKENS` / `--max-tokens` / SDK
  `OpenAIChatConfig.maxOutputTokensCeiling`). Callers who relied on the
  upstream's larger default should set `max_tokens` explicitly. The
  clamp behaviour for caller-supplied values is unchanged.
- **`temperature` / `top_p` remain pass-through** — when the caller
  omits them they are not sent to the upstream, so the upstream's own
  defaults apply unchanged. Documented as a deliberate non-symmetry
  with `max_tokens`: the latter is a cost-defense boundary, the former
  two are sampling knobs whose OpenAI defaults (1.0 / 1.0) are stable.

### Fixed

- **`npx` invocation in docs** — 0.3.0 advertised `npx ai-relay-mcp`,
  which fails with `E404 'ai-relay-mcp@*' is not in this registry`
  because npx resolves the first argument as a package name. The bin
  lives inside `ai-relay`, so the correct form is
  `npx --package=ai-relay ai-relay-mcp`. Root `README.md`,
  `README.ko.md`, the SDK `README.md`, and the bin's `--help` USAGE
  block now show the correct command and `claude_desktop_config.json`
  arg array. (Originally staged as 0.3.1; rolled into 0.4.0.)

## [0.3.0] — 2026-05-11

### Added

- **`ai-relay-mcp` bin** — second binary that runs a long-lived stdio MCP
  server exposing the `openai_chat` tool. Intended for direct registration
  in MCP hosts (Claude Desktop, Claude Code, Cursor) via
  `claude_desktop_config.json`. Accepts the same flags as `ai-relay`
  (`--api-key`, `--base-url`, `--max-tokens`, `--timeout`, `--env`,
  `--help`, `--version`) and reads the same `AI_RELAY_*` env vars.
- **Integration tests for `ai-relay-mcp`** — six stdio JSON-RPC scenarios
  sharing the existing `npm pack` + tarball-install fixture.
- **`prepublishOnly` script** — runs `clean && build && test` so
  `pnpm publish` cannot proceed unless the SDK + bins build cleanly and
  all 132 tests pass.

### Fixed

- **`VERSION` constants** — both bins now report the package version
  (`--version` previously printed the placeholder `0.1.0`).

## [0.2.0] — 2026-05-11

First version actually published to npm. The `[0.1.0]` entry below was never
shipped to the registry and exists for historical reference only.

### Changed (BREAKING)

- **Package name** — published as `ai-relay` (unscoped). The repo previously
  drafted `@ragingwind/mcp-ai-relay` (#51) and `@ragingwind/ai-relay` (#54)
  before settling on the unscoped form. Consumers install via
  `npm install ai-relay`.
  > _If npm rejected the unscoped name at publish time, the actual published
  > name is `@ragingwind/ai-relay` — see `package.json` `name`._
- **Config model (#60)** — single `RelayConfig` shape consumed via
  `loadConfig()`. The 0.1.0-era `OPENAI_*` env schema (`OPENAI_API_KEY`,
  `OPENAI_BASE_URL`, `OPENAI_MAX_OUTPUT_TOKENS_CEILING`,
  `OPENAI_REQUEST_TIMEOUT_MS`) and the HTTP-only env schema have been
  removed.
- **CLI form (#61)** — one-shot `<provider> <tool>` form:
  `npx ai-relay openai completion-chat`. The previous flag form
  (`--openai-completion`) and the standalone `mcp-ai-relay` stdio bin
  alias have been removed.

### Changed

- `zod` runtime dep floor bumped `^4.3.6` → `^4.4.3` (#35). No API
  change; ensures consumers pull a version with the latest validator
  fixes.

### Removed

- `OPENAI_*` env vars (replaced by `RelayConfig` per #60)
- `mcp-ai-relay` stdio bin alias (collapsed into the single `ai-relay` bin per #61)

### Tested against

| Peer | Version |
|---|---|
| `@modelcontextprotocol/sdk` | `^1.26` |
| `openai` | `^6` (currently `6.37.x`) |
| `node` | `>=20.10` |

### Migration from 0.1.0 (repo-only consumers)

| Old | New |
|---|---|
| `npx mcp-ai-relay --openai-completion` | `npx ai-relay openai completion-chat` |
| `OPENAI_API_KEY=…` env-only | `RelayConfig` via `loadConfig()` |
| `import … from '@ragingwind/mcp-ai-relay'` | `import … from 'ai-relay'` |

## [0.1.0] — Never released, superseded by 0.2.0

> See 0.2.0 above for the actual first release.

First public release. Extracts the durable, framework-agnostic core of
[mcp-ai-relay](https://github.com/ragingwind/mcp-ai-relay) into a
publishable npm package.

### Added

- **CLI bin `mcp-ai-relay`** — zero-config stdio MCP server launcher.
  `npx -y ai-relay --openai-completion` registers the
  `completion_chat` tool and connects via stdio. Provider flag set is
  designed for forward extension (`--anthropic-messages`,
  `--gemini-generate`, `--ai-gateway-chat` reserved). `--name` and
  `--description` flags override the default tool descriptor; env vars
  (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`,
  `OPENAI_MAX_OUTPUT_TOKENS_CEILING`, `OPENAI_REQUEST_TIMEOUT_MS`)
  supply the runtime config. Multi-upstream registration stays a
  code-based use case — the CLI ships one tool per invocation.
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
