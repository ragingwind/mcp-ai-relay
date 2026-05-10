import {
  type OpenAIChatConfig,
  type OpenAIChatHandlerBundle,
  openAIChatTool,
  type ToolDescriptor,
} from "../openai/index.js";

export type AnyTool = ToolDescriptor<OpenAIChatConfig, OpenAIChatHandlerBundle>;

export const cliRegistry = {
  openai: {
    chat: openAIChatTool,
  },
} as const satisfies Record<string, Record<string, AnyTool>>;

export function resolveTool(provider: string, tool: string): AnyTool | undefined {
  const providerEntry = (cliRegistry as Record<string, Record<string, AnyTool>>)[provider];
  if (!providerEntry) return undefined;
  return providerEntry[tool];
}
