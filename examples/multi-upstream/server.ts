// Multi-upstream MCP server: registers up to three OpenAI-compatible
// upstreams (OpenAI proper, Azure OpenAI, local Ollama / vLLM) as
// distinct named tools on a single server. Each registration is opt-in
// based on whether the relevant environment variables are set, so this
// example degrades gracefully when only one upstream is available.
//
// Each call to `registerOpenAIChat` creates an independent closure
// (own client, own ceiling, own timeout) — there is no shared state
// between the registrations, and aborting one in-flight call does not
// affect the others. The `name` field is the MCP tool name surfaced to
// clients via `tools/list`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "@ragingwind/ai-relay/openai";

const server = new McpServer({
  name: "multi-upstream-relay",
  version: "0.1.0",
});

let registeredCount = 0;

if (process.env.OPENAI_API_KEY) {
  registerOpenAIChat(server, {
    name: "openai_chat",
    apiKey: process.env.OPENAI_API_KEY,
    description: "OpenAI Chat Completions — proper",
  });
  registeredCount++;
}

if (process.env.AZURE_OPENAI_KEY && process.env.AZURE_OPENAI_BASE_URL) {
  registerOpenAIChat(server, {
    name: "azure_chat",
    apiKey: process.env.AZURE_OPENAI_KEY,
    baseURL: process.env.AZURE_OPENAI_BASE_URL,
    description: "Azure OpenAI deployment",
  });
  registeredCount++;
}

if (process.env.LOCAL_LLM_BASE_URL) {
  registerOpenAIChat(server, {
    name: "local_llm",
    apiKey: process.env.LOCAL_LLM_KEY ?? "not-needed",
    baseURL: process.env.LOCAL_LLM_BASE_URL,
    maxOutputTokensCeiling: 8192,
    description: "Local Ollama / vLLM (OpenAI-compatible)",
  });
  registeredCount++;
}

if (registeredCount === 0) {
  console.error(
    "No upstream credentials found. Set at least one of:\n" +
      "  OPENAI_API_KEY\n" +
      "  AZURE_OPENAI_KEY + AZURE_OPENAI_BASE_URL\n" +
      "  LOCAL_LLM_BASE_URL (+ optional LOCAL_LLM_KEY)",
  );
  process.exit(1);
}

console.error(`multi-upstream-relay: registered ${registeredCount} tool(s).`);

await server.connect(new StdioServerTransport());
