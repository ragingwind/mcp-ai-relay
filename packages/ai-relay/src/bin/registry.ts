import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type OpenAIChatConfig,
  type OpenAIChatHandlerBundle,
  openAIChatTool,
  registerOpenAIProvider,
  type ToolDescriptor,
} from "../openai/index.js";

export type AnyTool = ToolDescriptor<OpenAIChatConfig, OpenAIChatHandlerBundle>;

export interface ProviderEntry {
  /** Mount all of this provider's API tools on an `McpServer`. */
  registerOnServer: (server: McpServer, config: OpenAIChatConfig) => void;
  /** CLI one-shot tool descriptors keyed by tool name. */
  tools: Record<string, AnyTool>;
}

export const registry = {
  openai: {
    registerOnServer: registerOpenAIProvider,
    tools: {
      "chat-completions": openAIChatTool,
    },
  },
} as const satisfies Record<string, ProviderEntry>;

export type Provider = keyof typeof registry;

export function resolveProvider(name: string): ProviderEntry | undefined {
  return (registry as Record<string, ProviderEntry>)[name];
}

export function resolveProviderTool(provider: string, tool: string): AnyTool | undefined {
  const entry = (registry as Record<string, ProviderEntry>)[provider];
  return entry?.tools[tool];
}
