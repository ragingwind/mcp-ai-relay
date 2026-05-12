// MCP stdio server library function. The argv-parsing entrypoint lives
// in `ai-relay.ts`; this module exposes a pure starter that takes a
// resolved api-type + config and connects the stdio transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OpenAIChatConfig } from "../openai/index.js";
import { type ApiType, registry } from "./registry.js";

export interface StartMcpServerOptions {
  apiType: ApiType;
  config: OpenAIChatConfig;
  version: string;
}

export async function startMcpServer(opts: StartMcpServerOptions): Promise<void> {
  const server = new McpServer({ name: "ai-relay", version: opts.version });
  registry[opts.apiType].registerMcp(server, opts.config);
  await server.connect(new StdioServerTransport());
}
