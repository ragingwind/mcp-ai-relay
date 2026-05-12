import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type OpenAIChatConfig,
  type OpenAIChatHandlerBundle,
  openAIChatTool,
  registerOpenAIChat,
  type ToolDescriptor,
} from "../openai/index.js";

export type AnyTool = ToolDescriptor<OpenAIChatConfig, OpenAIChatHandlerBundle>;

export interface RegistryEntry {
  /** CLI one-shot handler bundle (used by `ai-relay-cli`). */
  cli: AnyTool;
  /** Register this tool on an `McpServer` (used by `ai-relay`). */
  registerMcp: (server: McpServer, config: OpenAIChatConfig) => void;
}

// Each key is the api-type exposed at the CLI / MCP surface and follows the
// upstream provider's native API naming. Future entries: `messages` for
// Anthropic Messages, `responses` for OpenAI Responses, etc.
export const registry = {
  "chat-completions": {
    cli: openAIChatTool,
    registerMcp: registerOpenAIChat,
  },
} as const satisfies Record<string, RegistryEntry>;

export type ApiType = keyof typeof registry;

export function resolveApiType(name: string): ApiType | undefined {
  return name in registry ? (name as ApiType) : undefined;
}

export function resolveTool(tool: string): AnyTool | undefined {
  const entry = (registry as Record<string, RegistryEntry>)[tool];
  return entry?.cli;
}
