// Hono entry point — the MCP relay HTTP server.
//
// Consumes the framework-agnostic primitives published as `ai-relay`
// and wires them into mcp-handler. mcp-handler v1.1+ is Web-Request native
// (`(request: Request) => Promise<Response>`), so Hono's `c.req.raw` (a
// standard `Request`) hands off cleanly to the wrapped handler — no shim
// needed.
//
// Wiring layers, outermost first:
//   1. Hono app — exposes `/healthz` (liveness, no auth) and `/api/mcp`.
//   2. `withMcpAuth(handler, ...)` — bearer-token gate at `/api/mcp`.
//      Unauthenticated requests get 401 + `WWW-Authenticate: Bearer ...`
//      automatically.
//   3. `createMcpHandler((server) => registerOpenAIChat(server, ...))` —
//      registers the `openai_chat` tool on each request boundary.
//
// `app` is exported so integration tests can call `app.fetch(request)`
// without booting an actual HTTP listener. The `import.meta.url` guard
// at the bottom only starts `serve(...)` when this file is executed
// directly (not when imported by tests or other modules).

import { serve } from "@hono/node-server";
import { verifyBearer } from "ai-relay";
import { registerOpenAIChat } from "ai-relay/openai";
import { Hono } from "hono";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { parseEnv } from "./env.js";

const env = parseEnv(process.env);

const handler = createMcpHandler(
  (server) => {
    registerOpenAIChat(server, {
      apiKey: env.AI_RELAY_API_KEY,
      ...(env.AI_RELAY_BASE_URL ? { baseURL: env.AI_RELAY_BASE_URL } : {}),
      maxOutputTokensCeiling: env.AI_RELAY_MAX_OUTPUT_TOKENS,
      requestTimeoutMs: env.AI_RELAY_REQUEST_TIMEOUT_MS,
    });
  },
  {},
  {
    // mcp-handler matches against the URL pathname starting from `basePath`.
    // Our route lives at `/api/mcp` so matching `basePath: "/api"` is required
    // for mcp-handler to accept the request.
    basePath: "/api",
  },
);

const wrapped = withMcpAuth(
  handler,
  (_req, token) => {
    if (!verifyBearer(token, env.AI_RELAY_AUTH_TOKEN)) return undefined;
    // `token` is the validated bearer; echoing it back to the SDK lets
    // downstream handlers attribute calls without re-parsing the header.
    return { token: token as string, clientId: "shared-secret", scopes: ["openai:chat"] };
  },
  {
    required: true,
    requiredScopes: ["openai:chat"],
  },
);

export const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

// Single MCP route — accept all standard methods and delegate to the
// mcp-handler wrapped handler. We use Hono's `app.all` so the same
// adapter handles GET (SSE upgrade), POST (Streamable HTTP), and DELETE
// (session teardown) per the MCP transport contract.
app.all("/api/mcp", (c) => wrapped(c.req.raw));

// Start the listener only when this file is executed directly (e.g.
// `node dist/index.js` or `tsx watch src/index.ts`). Tests that import
// `app` get the handler without binding a port.
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  serve({ fetch: app.fetch, port: env.AI_RELAY_PORT }, (info) => {
    // Single-line startup log — no secrets, only port + endpoint.
    console.log(`mcp-ai-relay listening on http://localhost:${info.port}/api/mcp`);
  });
}
