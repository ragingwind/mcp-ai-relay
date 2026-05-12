// MCP stdio server library function. The argv-parsing entrypoint lives
// in `ai-relay.ts`; this module exposes a pure starter that takes a
// resolved api-type + config and connects the stdio transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OpenAIChatConfig } from "../openai/index.js";
import type { VerboseLogger } from "./logger.js";
import { type ApiType, registry } from "./registry.js";

export interface StartMcpServerOptions {
  apiType: ApiType;
  config: OpenAIChatConfig;
  version: string;
  logger?: VerboseLogger;
}

export async function startMcpServer(opts: StartMcpServerOptions): Promise<void> {
  const server = new McpServer({ name: "ai-relay", version: opts.version });
  registry[opts.apiType].registerMcp(server, opts.config);

  const logger = opts.logger;
  const transport = new StdioServerTransport();

  if (logger?.enabled) {
    logger.log("mcp-server-ready", {
      apiType: opts.apiType,
      version: opts.version,
    });
    instrumentTransport(transport, logger);
  }

  await server.connect(transport);
}

// Wrap the transport's `onmessage` (set by McpServer.connect) and `send`
// so we observe every JSON-RPC message in both directions. The wrapper
// is installed AFTER `server.connect()` is the natural order, but here
// the SDK sets `onmessage` only inside `connect()`. Pattern: defer the
// install via a property setter so we always wrap the latest framework
// handler, no matter when McpServer assigns it.
function instrumentTransport(transport: StdioServerTransport, logger: VerboseLogger): void {
  let frameworkOnMessage: ((message: unknown) => void) | undefined;

  // Define a getter/setter that captures whatever the framework installs
  // and replaces it with a wrapper that logs first.
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get() {
      return frameworkOnMessage;
    },
    set(handler: (message: unknown) => void) {
      frameworkOnMessage = (message: unknown) => {
        try {
          logger.log("mcp-rpc-in", summariseRpcMessage(message));
        } catch {
          /* logging never blocks delivery */
        }
        handler(message);
      };
    },
  });

  // Wrap `send` to log outgoing responses/notifications.
  const originalSend = transport.send.bind(transport);
  transport.send = async (message) => {
    try {
      logger.log("mcp-rpc-out", summariseRpcMessage(message));
    } catch {
      /* logging never blocks delivery */
    }
    return originalSend(message);
  };
}

function summariseRpcMessage(message: unknown): Record<string, unknown> {
  if (message === null || typeof message !== "object") {
    return { kind: "non-object", value: String(message) };
  }
  const m = message as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("jsonrpc" in m) out.jsonrpc = m.jsonrpc;
  if ("id" in m) out.id = m.id;
  if ("method" in m) out.method = m.method;
  if ("params" in m) out.params = summariseParams(m.params);
  if ("result" in m) {
    out.hasResult = true;
    out.resultSummary = summariseResult(m.result);
  }
  if ("error" in m) {
    out.hasError = true;
    out.errorSummary = summariseError(m.error);
  }
  return out;
}

function summariseParams(params: unknown): unknown {
  if (params === null || typeof params !== "object") return params;
  const p = params as Record<string, unknown>;
  // tools/call: { name, arguments: { model, messages, ... } }
  if (typeof p.name === "string" && p.arguments !== undefined) {
    return {
      name: p.name,
      arguments: summariseArguments(p.arguments),
    };
  }
  return p;
}

function summariseArguments(args: unknown): unknown {
  if (args === null || typeof args !== "object") return args;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (k === "messages" && Array.isArray(v)) {
      out.messages = v.map((m) => {
        const msg = m as { role?: unknown; content?: unknown };
        const content = msg.content;
        if (typeof content === "string") {
          return { role: msg.role, chars: content.length };
        }
        return { role: msg.role, chars: 0, kind: typeof content };
      });
    } else {
      out[k] = v;
    }
  }
  return out;
}

function summariseResult(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== "object") {
    return { value: String(result) };
  }
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("content" in r && Array.isArray(r.content)) {
    let totalChars = 0;
    for (const c of r.content as Array<{ text?: unknown }>) {
      if (typeof c?.text === "string") totalChars += c.text.length;
    }
    out.contentChars = totalChars;
  }
  if ("structuredContent" in r && r.structuredContent && typeof r.structuredContent === "object") {
    const sc = r.structuredContent as Record<string, unknown>;
    out.structuredContent = {
      model: sc.model,
      finish_reason: sc.finish_reason,
      code: sc.code,
      usage: sc.usage,
    };
  }
  if ("isError" in r) out.isError = r.isError;
  if ("tools" in r && Array.isArray(r.tools)) {
    out.toolCount = r.tools.length;
    out.toolNames = (r.tools as Array<{ name?: unknown }>).map((t) => t?.name);
  }
  if ("protocolVersion" in r) out.protocolVersion = r.protocolVersion;
  if ("serverInfo" in r) out.serverInfo = r.serverInfo;
  return out;
}

function summariseError(error: unknown): unknown {
  if (error === null || typeof error !== "object") return error;
  const e = error as Record<string, unknown>;
  return { code: e.code, message: e.message };
}
