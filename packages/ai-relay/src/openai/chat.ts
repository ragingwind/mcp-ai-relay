// OpenAI Chat Completions MCP tool registrar.
//
// `registerOpenAIChat(server, config)` registers a single MCP tool that
// streams an OpenAI Chat Completions response and returns it as one
// `CallToolResult`. The same server may be safely registered against
// multiple times with different `name` + `apiKey` + `baseURL` —
// every call produces an independent closure (schema, OpenAI client,
// per-request scope, AbortController) with NO module-level shared state.
//
// Streaming invariants:
//   - `maxRetries: 0` at the call site (mid-stream replay would duplicate
//     output).
//   - `stream_options: { include_usage: true }` so the trailing usage
//     chunk populates `structuredContent.usage`.
//
// Error result invariants:
//   - never echo the raw upstream body, prompt, or headers.
//   - map OpenAI errors to the stable `code` set defined below.

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import OpenAI from "openai";
import { z } from "zod";
import { dumpMessages, type VerboseLogger } from "../bin/logger.js";
import { type CreatedOpenAIClient, createOpenAIClient, type RequestScope } from "./client.js";

const DEFAULT_NAME = "chat-completions";
const DEFAULT_DESCRIPTION =
  "Invoke OpenAI Chat Completions and return the accumulated assistant message.";
const DEFAULT_CEILING = 4096;
const DEFAULT_TIMEOUT_MS = 60_000;

// --- config ---------------------------------------------------------------

export interface OpenAIChatConfig {
  /** Registered MCP tool name. Default `"chat-completions"`. Must be unique
   *  within an MCP server when multiple instances are registered. */
  name?: string;
  /** Description override. Default is the SDK's built-in summary. */
  description?: string;
  /** OpenAI API key. Required unless `openaiClient` is supplied. */
  apiKey: string;
  /** OpenAI base URL override (Azure / vLLM / Ollama / AI Gateway / mock). */
  baseURL?: string;
  /** Ceiling for `max_tokens`. Default 4096. Doubles as the default
   *  injected when the caller omits `max_tokens` — every upstream call
   *  carries an explicit cap. */
  maxOutputTokensCeiling?: number;
  /** Per-request OpenAI timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
  /** Inject a pre-built OpenAI client (advanced — share a client across
   *  multiple registrations to amortise its setup cost). When supplied,
   *  `apiKey` / `baseURL` / `requestTimeoutMs` are ignored. */
  openaiClient?: OpenAI;
  /** Inject the request scope that pairs with `openaiClient`. Required
   *  only when both `openaiClient` is supplied AND upstream-body
   *  redaction must remain wired. */
  requestScope?: RequestScope;
  /** Optional verbose logger. When enabled, emits `openai-stream-start`,
   *  `openai-stream-end`, and `openai-cancelled` events around the
   *  upstream call. Pairs with the HTTP-level events from
   *  `createOpenAIClient`. */
  logger?: VerboseLogger;
}

// --- input schema ---------------------------------------------------------

export function makeOpenAIChatSchema(ceiling: number) {
  return z
    .object({
      model: z.string().min(1),
      messages: z
        .array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          }),
        )
        .min(1),
      temperature: z.number().min(0).max(2).optional(),
      // Accept omitted OR 0 as "use the configured default"; clamp
      // positive values to the ceiling. Negative values are rejected.
      // Result is always a positive integer ≤ ceiling.
      max_tokens: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .transform((n) => (n === undefined || n === 0 ? ceiling : Math.min(n, ceiling))),
      top_p: z.number().min(0).max(1).optional(),
      stop: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .strict();
}

export type OpenAIChatSchema = ReturnType<typeof makeOpenAIChatSchema>;
export type OpenAIChatInput = z.infer<OpenAIChatSchema>;

export const openAIChatOutputSchema = z
  .object({
    model: z.string(),
    usage: z
      .object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        total_tokens: z.number(),
      })
      .optional(),
    finish_reason: z.string().optional(),
    code: z.string().optional(),
    retryAfter: z.number().optional(),
  })
  .strict();

// --- result shape ---------------------------------------------------------

export type OpenaiUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type OpenAIChatStructured = {
  model: string;
  // Optional fields are omitted entirely (rather than set to `undefined`)
  // so consumers under `exactOptionalPropertyTypes` can spread cleanly.
  usage?: OpenaiUsage;
  finish_reason?: string;
  code?: string;
  retryAfter?: number;
};

export type OpenAIChatResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: OpenAIChatStructured;
  isError: boolean;
};

export type OpenAIChatHandler = (
  rawInput: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<OpenAIChatResult>;

// --- error mapping --------------------------------------------------------

type MappedError = {
  code: string;
  message: string;
  retryAfter?: number;
};

export function mapOpenAIError(err: unknown, requestScope?: RequestScope): MappedError {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;

    if (status === 401 || status === 403) {
      return { code: "auth", message: "Authentication failed" };
    }

    if (status === 429) {
      const headerVal = err.headers?.get?.("retry-after") ?? "";
      const parsed = Number(headerVal);
      const retryAfter = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      return retryAfter !== undefined
        ? { code: "rate_limited", message: "Rate limited by upstream", retryAfter }
        : { code: "rate_limited", message: "Rate limited by upstream" };
    }

    if (status === 400) {
      const apiCode = err.code;
      if (apiCode === "context_length_exceeded") {
        return { code: "context_length", message: "Context length exceeded" };
      }
      if (apiCode === "content_filter" || /content policy|safety/i.test(err.message)) {
        return { code: "content_policy", message: "Content policy rejected" };
      }
      return { code: "bad_request", message: "Bad request" };
    }

    if (typeof status === "number" && status >= 500) {
      const body = requestScope?.getStore()?.upstreamBody;
      return {
        code: "upstream_error",
        message: body ? `Upstream server error: ${body}` : "Upstream server error",
      };
    }

    if (status === undefined) {
      return { code: "upstream_error", message: "Network or connection error" };
    }

    return { code: "bad_request", message: "Bad request" };
  }

  return { code: "upstream_error", message: "Network or unknown error" };
}

// --- handler factory ------------------------------------------------------

export interface OpenAIChatHandlerBundle {
  schema: OpenAIChatSchema;
  handler: OpenAIChatHandler;
  /** Resolved tool name (`config.name ?? "chat-completions"`). */
  name: string;
  /** Resolved description. */
  description: string;
}

export function makeOpenAIChatHandler(config: OpenAIChatConfig): OpenAIChatHandlerBundle {
  const name = config.name ?? DEFAULT_NAME;
  const description = config.description ?? DEFAULT_DESCRIPTION;
  const ceiling = config.maxOutputTokensCeiling ?? DEFAULT_CEILING;
  const schema = makeOpenAIChatSchema(ceiling);

  const { client, requestScope } = resolveClient(config);
  const logger = config.logger;

  const handler: OpenAIChatHandler = async (rawInput, extra = {}) => {
    const input: OpenAIChatInput = schema.parse(rawInput);

    const ac = new AbortController();
    if (extra.signal) {
      if (extra.signal.aborted) {
        ac.abort();
      } else {
        extra.signal.addEventListener("abort", () => ac.abort(), { once: true });
      }
    }

    return requestScope.run({}, () => runOnce(input, client, requestScope, ac, logger));
  };

  return { schema, handler, name, description };
}

export function registerOpenAIChat(server: McpServer, config: OpenAIChatConfig): void {
  const { schema, handler, name, description } = makeOpenAIChatHandler(config);
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema.shape,
      outputSchema: openAIChatOutputSchema.shape,
    },
    handler,
  );
}

// --- transport-agnostic tool descriptor ----------------------------------

export interface ToolDescriptor<C = unknown, B = unknown> {
  provider: string;
  name: string;
  /** Make a handler bundle (schema + handler + names) for one config. */
  makeHandler: (config: C) => B;
  /** Optional CLI sugar: turn plain text into a JSON object the schema accepts. */
  desugar?: (plain: string, opts: { system?: string; model?: string }) => Record<string, unknown>;
}

export const openAIChatTool: ToolDescriptor<OpenAIChatConfig, OpenAIChatHandlerBundle> = {
  provider: "openai",
  name: "chat-completions",
  makeHandler: makeOpenAIChatHandler,
  desugar: (plain, opts) => {
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: plain });
    return opts.model ? { model: opts.model, messages } : { messages };
  },
};

// --- internals ------------------------------------------------------------

function resolveClient(config: OpenAIChatConfig): CreatedOpenAIClient {
  if (config.openaiClient) {
    // Consumer-supplied client: pair with their scope or a fresh empty one.
    // A fresh scope means upstream-body capture stays handler-local even if
    // the same client backs multiple registrations (no cross-tool leakage).
    return {
      client: config.openaiClient,
      requestScope: config.requestScope ?? new AsyncLocalStorage(),
    };
  }
  return createOpenAIClient({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.logger ? { logger: config.logger } : {}),
  });
}

async function runOnce(
  input: OpenAIChatInput,
  client: OpenAI,
  requestScope: RequestScope,
  ac: AbortController,
  logger?: VerboseLogger,
): Promise<OpenAIChatResult> {
  const startedAt = Date.now();
  if (logger?.enabled) {
    logger.log("openai-stream-start", {
      model: input.model,
      messages: dumpMessages(input.messages),
      temperature: input.temperature,
      max_tokens: input.max_tokens,
      top_p: input.top_p,
      stop: input.stop,
      maxRetries: 0,
    });
    if (ac.signal.aborted) {
      logger.log("openai-cancelled", {
        reason: ac.signal.reason ?? "aborted",
        elapsedMs: Date.now() - startedAt,
      });
    } else {
      ac.signal.addEventListener(
        "abort",
        () => {
          logger.log("openai-cancelled", {
            reason: ac.signal.reason ?? "aborted",
            elapsedMs: Date.now() - startedAt,
          });
        },
        { once: true },
      );
    }
  }
  try {
    const stream = await client.chat.completions.create(
      {
        model: input.model,
        messages: input.messages,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        max_tokens: input.max_tokens,
        ...(input.top_p !== undefined ? { top_p: input.top_p } : {}),
        ...(input.stop !== undefined ? { stop: input.stop } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: ac.signal, maxRetries: 0 },
    );

    let accumulated = "";
    let usage: OpenaiUsage | undefined;
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) accumulated += delta;
      const fr = choice?.finish_reason;
      if (fr) finishReason = fr;
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.total_tokens,
        };
      }
    }

    const structuredContent: OpenAIChatStructured = {
      model: input.model,
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
    };

    if (logger?.enabled) {
      logger.log("openai-stream-end", {
        accumulatedText: accumulated,
        finish_reason: finishReason,
        usage,
        elapsedMs: Date.now() - startedAt,
      });
    }

    return {
      content: [{ type: "text", text: accumulated }],
      structuredContent,
      isError: false,
    };
  } catch (err) {
    const mapped = mapOpenAIError(err, requestScope);
    const structuredContent: OpenAIChatStructured = {
      model: input.model,
      code: mapped.code,
      ...(mapped.retryAfter !== undefined ? { retryAfter: mapped.retryAfter } : {}),
    };
    if (logger?.enabled) {
      logger.log("openai-stream-end", {
        accumulatedText: "",
        finish_reason: undefined,
        usage: undefined,
        elapsedMs: Date.now() - startedAt,
        error: { code: mapped.code, message: mapped.message },
      });
    }
    return {
      content: [{ type: "text", text: mapped.message }],
      structuredContent,
      isError: true,
    };
  }
}
