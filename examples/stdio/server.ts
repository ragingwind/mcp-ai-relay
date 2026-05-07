// Minimal stdio MCP server: registers `completion_chat` against OpenAI
// and serves it over stdin/stdout for direct registration in
// Claude Desktop's `claude_desktop_config.json`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "@ragingwind/ai-relay/openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY environment variable is required.");
  process.exit(1);
}

const server = new McpServer({
  name: "openai-relay-stdio",
  version: "0.1.0",
});

registerOpenAIChat(server, {
  apiKey,
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
});

await server.connect(new StdioServerTransport());
