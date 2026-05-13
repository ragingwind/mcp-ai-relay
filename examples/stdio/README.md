# Example — stdio (Claude Desktop direct)

A 20-line stdio MCP server that registers `chat-completions` against
OpenAI and is consumed directly by Claude Desktop via
`claude_desktop_config.json`. No HTTP, no auth gate — the stdio
transport assumes the local process is trusted.

## Run from this monorepo

```bash
# from the repo root
pnpm install
pnpm --filter ai-relay build

AI_RELAY_API_KEY=sk-... AI_RELAY_MODEL=gpt-4o-mini pnpm --filter @example/stdio start
```

The server reads JSON-RPC frames on stdin and writes responses on
stdout. To verify locally without Claude Desktop:

```bash
# in another terminal — sends a tools/list request via npx mcp-inspector
AI_RELAY_API_KEY=sk-... AI_RELAY_MODEL=gpt-4o-mini \
  npx @modelcontextprotocol/inspector --cli \
  -- pnpm --filter @example/stdio start
```

## Run from npm (after `ai-relay@0.1.0` is published)

Outside this monorepo, in any new directory:

```bash
npm init -y
npm pkg set type=module
npm install ai-relay @modelcontextprotocol/sdk openai
npm install --save-dev tsx
```

Copy `server.ts` from this directory, then:

```bash
AI_RELAY_API_KEY=sk-... AI_RELAY_MODEL=gpt-4o-mini npx tsx server.ts
```

## Register in Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or the equivalent path on other OSes:

```json
{
  "mcpServers": {
    "openai-relay": {
      "command": "node",
      "args": [
        "--import",
        "tsx",
        "/absolute/path/to/examples/stdio/server.ts"
      ],
      "env": {
        "AI_RELAY_API_KEY": "sk-...",
        "AI_RELAY_MODEL": "gpt-4o-mini"
      }
    }
  }
}
```

For a published-to-disk approach, `tsc` the server into JS first and
point `command`/`args` at the compiled file.

Restart Claude Desktop. The `chat-completions` tool will appear in the
tools selector.

## Verification

Run the committed smoke test from the repo root:

```bash
pnpm --filter @example/stdio smoke
```

It boots an inline mock OpenAI HTTP server, spawns `server.ts` over stdio
with `AI_RELAY_BASE_URL` pointed at the mock, drives `initialize` →
`tools/list` → `tools/call chat-completions`, and asserts a sentinel string
round-trips through the relay. Ends with `=== PASS ===`.

## Configuration

Environment variables read by `server.ts`:

| Var | Required | Notes |
|---|---|---|
| `AI_RELAY_API_KEY` | ✅ | OpenAI API key |
| `AI_RELAY_MODEL` | ✅ | Upstream model id (e.g. `gpt-4o-mini`) |
| `AI_RELAY_BASE_URL` | ❌ | Override for Azure / vLLM / Ollama / AI Gateway |

`max_tokens`, `temperature`, `top_p`, `stop`, and request timeout are
SDK-default unless you extend `server.ts` to pass them in
`OpenAIChatConfig`. The caller-facing tool input is `{ messages }`
only — these parameters cannot be supplied per call.
