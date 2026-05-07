# Example — stdio (Claude Desktop direct)

A 20-line stdio MCP server that registers `completion_chat` against
OpenAI and is consumed directly by Claude Desktop via
`claude_desktop_config.json`. No HTTP, no auth gate — the stdio
transport assumes the local process is trusted.

## Run from this monorepo

```bash
# from the repo root
pnpm install
pnpm --filter @ragingwind/ai-relay build

OPENAI_API_KEY=sk-... pnpm --filter @example/stdio start
```

The server reads JSON-RPC frames on stdin and writes responses on
stdout. To verify locally without Claude Desktop:

```bash
# in another terminal — sends a tools/list request via npx mcp-inspector
OPENAI_API_KEY=sk-... npx @modelcontextprotocol/inspector --cli \
  -- pnpm --filter @example/stdio start
```

## Run from npm (after `@ragingwind/ai-relay@0.1.0` is published)

Outside this monorepo, in any new directory:

```bash
npm init -y
npm pkg set type=module
npm install @ragingwind/ai-relay @modelcontextprotocol/sdk openai
npm install --save-dev tsx
```

Copy `server.ts` from this directory, then:

```bash
OPENAI_API_KEY=sk-... npx tsx server.ts
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
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

For a published-to-disk approach, `tsc` the server into JS first and
point `command`/`args` at the compiled file.

Restart Claude Desktop. The `completion_chat` tool will appear in the
tools selector.

## Configuration

Environment variables read by `server.ts`:

| Var | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | OpenAI API key |
| `OPENAI_BASE_URL` | ❌ | Override for Azure / vLLM / Ollama / AI Gateway |

`max_tokens` ceiling (default 4096) and request timeout (default 60 s)
are taken from the SDK defaults. Set them by editing `server.ts` if you
need custom values.
