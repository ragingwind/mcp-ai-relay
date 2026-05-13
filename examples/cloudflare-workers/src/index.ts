// @ts-nocheck — illustrative sketch.
//
// Cloudflare Workers MCP server using @cloudflare/agents.
//
// This sketch shows how `registerOpenAIChat` plugs into a Workers MCP
// stack built on the `agents/mcp` framework. The framework handles the
// Streamable HTTP transport, session state via Durable Objects, and
// routing — we just register tools in `init()`.
//
// **Why @ts-nocheck**: the `agents` package API is still evolving
// (mid-2026). Its export shape and `McpAgent` lifecycle methods may
// shift between minor versions. The PIN your project uses determines
// the exact import paths and method names; treat the code below as a
// pattern, not a copy-paste-ready file. The KEY takeaway is the
// `registerOpenAIChat(this.server, ...)` call in `init()` — that is
// where this SDK plugs in, regardless of which Workers MCP framework
// you adopt.
//
// For production: enable `compatibility_flags = ["nodejs_compat"]` in
// wrangler.toml so AsyncLocalStorage (used by the SDK for
// upstream-error redaction) is available. Without it the request still
// succeeds; only the redacted error-body snippet is dropped.
//
// Reference: https://developers.cloudflare.com/agents/model-context-protocol/

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { verifyBearer } from "ai-relay";
import { registerOpenAIChat } from "ai-relay/openai";

interface Env {
  AI_RELAY_API_KEY: string;
  AI_RELAY_BASE_URL?: string;
  AI_RELAY_AUTH_TOKEN: string;
  AI_RELAY_MODEL: string;
  MCP_OBJECT: DurableObjectNamespace;
}

export class OpenAIRelay extends McpAgent<Env> {
  server = new McpServer({
    name: "openai-relay-worker",
    version: "0.1.0",
  });

  async init() {
    registerOpenAIChat(this.server, {
      apiKey: this.env.AI_RELAY_API_KEY,
      model: this.env.AI_RELAY_MODEL,
      ...(this.env.AI_RELAY_BASE_URL ? { baseURL: this.env.AI_RELAY_BASE_URL } : {}),
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Bearer gate: identical pattern to the Hono relay (`app/src/index.ts`).
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!verifyBearer(token, env.AI_RELAY_AUTH_TOKEN)) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }

    return OpenAIRelay.serveSSE("/sse").fetch(request, env, ctx);
  },
};
