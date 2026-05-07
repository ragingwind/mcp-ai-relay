// MCP route entry point — Vercel/Next.js deployment.
//
// Consumes the SDK's framework-agnostic primitives (`registerOpenAIChat`,
// `verifyBearer`) and wires them into mcp-handler's Next.js adapter. All
// environment reading happens here, at the deployment-specific boundary —
// `lib/` modules stay portable.
//
// Wiring layers, outermost first:
//   1. `withMcpAuth(handler, ...)` — bearer-token gate. Unauthenticated
//      requests get 401 + `WWW-Authenticate: Bearer ...` automatically.
//   2. `createMcpHandler((server) => registerOpenAIChat(server, ...))` —
//      registers the `completion_chat` tool on each request boundary.
//
// Vercel-specific exports (kept here, NOT in the SDK):
//   • `runtime = "nodejs"` — Edge runtime would hit the 25 s TTFB cap and
//     break streaming chat completions.
//   • `maxDuration = 300` — defense in depth with vercel.json.

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyBearer } from "../../../lib/auth.js";
import { parseEnv } from "../../../lib/env.js";
import { registerOpenAIChat } from "../../../lib/openai/chat.js";

const env = parseEnv(process.env);

const handler = createMcpHandler(
  (server) => {
    registerOpenAIChat(server, {
      apiKey: env.OPENAI_API_KEY,
      ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
      maxOutputTokensCeiling: env.MAX_OUTPUT_TOKENS_CEILING,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    });
  },
  {},
  {
    // mcp-handler matches against the URL pathname starting from `basePath`.
    // Our route lives at `app/api/[transport]/route.ts` so Next.js serves
    // `/api/<transport>` (e.g. `/api/mcp`); matching `basePath: "/api"`
    // is required for mcp-handler to accept the request.
    basePath: "/api",
  },
);

const wrapped = withMcpAuth(
  handler,
  (_req, token) => {
    if (!verifyBearer(token, env.RELAY_AUTH_TOKEN)) return undefined;
    // `token` is the validated bearer; echoing it back to the SDK lets
    // downstream handlers attribute calls without re-parsing the header.
    return { token: token as string, clientId: "shared-secret", scopes: ["openai:chat"] };
  },
  {
    required: true,
    requiredScopes: ["openai:chat"],
  },
);

export const runtime = "nodejs";
export const maxDuration = 300;

export { wrapped as GET, wrapped as POST, wrapped as DELETE };
