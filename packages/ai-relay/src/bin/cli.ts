#!/usr/bin/env node
//
// Zero-config CLI for ai-relay.
//
// Launches a single-tool stdio MCP server using the SDK's registrar
// for the provider/capability selected by a flag. Designed for direct
// consumption from `claude_desktop_config.json` via `npx`:
//
//   {
//     "mcpServers": {
//       "openai-relay": {
//         "command": "npx",
//         "args": ["-y", "ai-relay", "--openai-completion"],
//         "env": { "OPENAI_API_KEY": "sk-..." }
//       }
//     }
//   }
//
// One flag = one provider/capability. Future flags reserved:
//   --openai-completion    OpenAI Chat Completions       [SHIPPING in 0.1.0]
//   --anthropic-messages   Anthropic Messages            [reserved]
//   --gemini-generate      Gemini generateContent        [reserved]
//   --ai-gateway-chat      Vercel AI Gateway (chat mode) [reserved]
//
// Multi-upstream registration (one server, multiple distinct names) is
// not expressible via the CLI surface. Use the SDK API directly — see
// `examples/multi-upstream/` in the repo.
//
// Pure helpers (parseArgs, buildOpenAIChatConfig, …) live in
// `./helpers.js` so unit tests can import them without invoking
// `main()`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "../openai/index.js";
import { buildOpenAIChatConfig, type ParsedArgs, parseArgs } from "./helpers.js";

// Bumped in lockstep with package.json on every release.
const VERSION = "0.1.0";

const USAGE = `Usage: mcp-ai-relay <provider-flag> [--name <name>] [--description <desc>]

Provider flags (exactly one required):
  --openai-completion   OpenAI Chat Completions
                        Required env: OPENAI_API_KEY
                        Optional env: OPENAI_BASE_URL,
                                      OPENAI_MAX_OUTPUT_TOKENS_CEILING,
                                      OPENAI_REQUEST_TIMEOUT_MS

Options:
  --name <name>         Override the registered MCP tool name
                        (default: openai_chat)
  --description <desc>  Override the tool description
  --help, -h            Show this message
  --version, -V         Print SDK version

Example:
  OPENAI_API_KEY=sk-... npx -y ai-relay --openai-completion

Multi-upstream registration is not expressible via the CLI; use the
SDK API directly. See:
  https://github.com/ragingwind/mcp-ai-relay/tree/main/examples/multi-upstream
`;

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!args.provider) {
    process.stderr.write(`A provider flag is required.\n\n${USAGE}`);
    process.exit(2);
  }

  const server = new McpServer({
    name: `mcp-ai-relay-${args.provider}`,
    version: VERSION,
  });

  switch (args.provider) {
    case "openai-completion":
      registerOpenAIChat(server, buildOpenAIChatConfig(args));
      break;
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
