# Example — multi-upstream

One MCP server registers multiple OpenAI-compatible upstreams as
distinct named tools. The same `registerOpenAIChat` factory is invoked
once per upstream — each call captures its own client, base URL, and
ceiling via closure, with no module-level shared state.

This is the **C7 (multi-registration) scenario** referenced in
[`doc/QA-MCP-INSPECTOR.md`](../../doc/QA-MCP-INSPECTOR.md).

## When to use this pattern

- Routing one MCP host to multiple model pools (a single Claude Code
  process talks to OpenAI for some models, Azure for others, and a
  local LLM for development) without standing up multiple MCP
  servers.
- Cost or compliance segregation: each upstream has its own API key, so
  spending and access policy stay isolated. A leak in one bearer key
  does not grant access to the others — they live behind the same MCP
  bearer token but route to distinct upstream credentials.
- Hot-swap experiments: register a `local_llm` alongside `chat-completions`
  so the host can A/B prompts against both without changing endpoints.

## Run from this monorepo

```bash
# from the repo root
pnpm install
pnpm --filter ai-relay build

# enable the upstreams you have credentials for
AI_RELAY_API_KEY=sk-... AI_RELAY_MODEL=gpt-4o-mini \
AZURE_OPENAI_KEY=... AZURE_OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/deployments/<deployment> AZURE_OPENAI_MODEL=gpt-4o \
LOCAL_LLM_BASE_URL=http://localhost:11434/v1 LOCAL_LLM_MODEL=llama3 \
  pnpm --filter @example/multi-upstream start
```

Each upstream needs its own model id; `server.ts` reads `AI_RELAY_MODEL` /
`AZURE_OPENAI_MODEL` / `LOCAL_LLM_MODEL` and falls back to sensible defaults.
Since 0.10.0 the caller-facing MCP input is `{ messages }` only — model is
captured per-registration at server boot.

The server logs `multi-upstream-relay: registered N tool(s).` to stderr
on start (so it doesn't pollute the JSON-RPC stdout stream). At least
one of the three upstream blocks must be configured or the server
exits non-zero.

## Verify with MCP Inspector (C7)

```bash
AI_RELAY_API_KEY=sk-... AI_RELAY_MODEL=gpt-4o-mini \
LOCAL_LLM_BASE_URL=http://localhost:11434/v1 LOCAL_LLM_MODEL=llama3 \
  npx @modelcontextprotocol/inspector --cli \
    -- pnpm --filter @example/multi-upstream start
```

In the Inspector's **Tools** tab, you should see two distinct entries
(`chat-completions` and `local_llm`) — `tools/list` returns them both.
Each `tools/call` routes to the upstream captured at registration
time. To prove isolation, switch the `LOCAL_LLM_BASE_URL` mid-test to
something that always 503s and verify the `chat-completions` tool keeps
working independently.

## Verification

Run the committed smoke test from the repo root:

```bash
pnpm --filter @example/multi-upstream smoke
```

It boots two inline mock OpenAI HTTP servers on distinct ephemeral ports
(sentinel `from-upstream-A` and `from-upstream-B`), spawns `server.ts`
wired to mock A via `AI_RELAY_BASE_URL` and to mock B via
`LOCAL_LLM_BASE_URL`, and asserts that `tools/call chat-completions` and
`tools/call local_llm` each round-trip the correct sentinel. Ends with
`=== PASS ===`.

## Configuration

| Var | Effect |
|---|---|
| `AI_RELAY_API_KEY` | Registers `chat-completions` against OpenAI proper |
| `AI_RELAY_MODEL` | Model id for `chat-completions` (default `gpt-4o-mini`) |
| `AI_RELAY_BASE_URL` | Optional base URL override for `chat-completions` |
| `AZURE_OPENAI_KEY` + `AZURE_OPENAI_BASE_URL` | Registers `azure_chat` |
| `AZURE_OPENAI_MODEL` | Model id for `azure_chat` (default `gpt-4o-mini`) |
| `LOCAL_LLM_BASE_URL` | Registers `local_llm` (default `max_tokens: 8192`) |
| `LOCAL_LLM_MODEL` | Model id for `local_llm` (default `llama3`) |
| `LOCAL_LLM_KEY` | Optional auth for the local LLM endpoint |

Add more upstreams by copying the `registerOpenAIChat` block in
`server.ts` and choosing a unique `name` value.

## Run from npm (after `ai-relay@0.1.0` is published)

```bash
npm init -y
npm pkg set type=module
npm install ai-relay @modelcontextprotocol/sdk openai
npm install --save-dev tsx
# Copy server.ts from this directory.
AI_RELAY_API_KEY=sk-... AI_RELAY_MODEL=gpt-4o-mini npx tsx server.ts
```
