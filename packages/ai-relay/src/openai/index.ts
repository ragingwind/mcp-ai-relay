// ai-relay/openai — OpenAI Chat Completions provider.
//
// Compatible with any OpenAI Chat Completions-shaped API: OpenAI proper,
// Azure OpenAI, vLLM, Ollama, OpenRouter, Vercel AI Gateway (OpenAI mode).

export type {
  OpenAIChatConfig,
  OpenAIChatHandler,
  OpenAIChatHandlerBundle,
  OpenAIChatInput,
  OpenAIChatResult,
  OpenAIChatSchema,
  OpenAIChatStructured,
  OpenaiUsage,
  ToolDescriptor,
} from "./chat.js";
export {
  makeOpenAIChatHandler,
  makeOpenAIChatSchema,
  mapOpenAIError,
  openAIChatTool,
  registerOpenAIChat,
} from "./chat.js";
export type {
  CreatedOpenAIClient,
  OpenAIClientConfig,
  RequestScope,
} from "./client.js";
export { createOpenAIClient } from "./client.js";
