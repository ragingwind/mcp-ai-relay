# Vercel deployment (community-supported)

The official deploy path for `ai-relay` is the Docker image at
`ghcr.io/ragingwind/ai-relay` (see `doc/DEPLOY.md`). This directory keeps
a Vercel deployment recipe for users who prefer that surface.

## What is here

`vercel.json` — the original Vercel project configuration the relay
shipped before it became framework-agnostic. The interesting parts:

- `regions: ["iad1"]` — keep latency low to OpenAI's primary region
- `functions["app/api/**/route.ts"].maxDuration: 300` — 5-minute hard
  cap for streaming completions

## How to use it

`ai-relay` is not a Next.js project, so you cannot deploy this
repository directly to Vercel. Instead, build a thin Next.js
project that consumes the published `ai-relay` SDK:

```bash
mkdir my-relay && cd my-relay
pnpm init
pnpm add next react react-dom ai-relay mcp-handler @modelcontextprotocol/sdk openai zod
mkdir -p app/api/[transport]
```

`app/api/[transport]/route.ts`:

```ts
import { verifyBearer, loadConfig } from "ai-relay";
import { registerOpenAIChat } from "ai-relay/openai";
import { createMcpHandler, withMcpAuth } from "mcp-handler";

// loadConfig reads AI_RELAY_API_KEY + AI_RELAY_MODEL + optional sampling env vars.
const config = loadConfig({ env: process.env });
const provider = config.providers[0]!;

const handler = createMcpHandler(
  (server) =>
    registerOpenAIChat(server, {
      apiKey: provider.apiKey,
      model: provider.model,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
      ...(provider.max_tokens !== undefined ? { max_tokens: provider.max_tokens } : {}),
      ...(provider.top_p !== undefined ? { top_p: provider.top_p } : {}),
      ...(provider.stop !== undefined ? { stop: provider.stop } : {}),
      ...(provider.requestTimeoutMs ? { requestTimeoutMs: provider.requestTimeoutMs } : {}),
    }),
  {},
  { basePath: "/api" },
);

const wrapped = withMcpAuth(
  handler,
  (_req, token) =>
    verifyBearer(token, process.env.AI_RELAY_AUTH_TOKEN!)
      ? { token: token as string, clientId: "shared", scopes: ["openai:chat"] }
      : undefined,
  { required: true, requiredScopes: ["openai:chat"] },
);

export { wrapped as GET, wrapped as POST, wrapped as DELETE };
```

Copy this directory's `vercel.json` to your project root, then deploy:

```bash
vercel deploy --prod
```

Set `AI_RELAY_API_KEY`, `AI_RELAY_AUTH_TOKEN`, and `AI_RELAY_MODEL` as Vercel
environment variables before the first deploy. Optional sampling overrides
(`AI_RELAY_TEMPERATURE`, `AI_RELAY_MAX_TOKENS`, `AI_RELAY_TOP_P`,
`AI_RELAY_STOP`) are forwarded to every upstream call when set.

## Verification

Run the committed smoke test from the repo root:

```bash
bash examples/vercel/scripts/smoke.sh
```

It validates that `vercel.json` parses as JSON and that this README
neither references dropped env-var or package names from the pre-SDK
era nor drifts away from the current SDK surface (`ai-relay`,
`ai-relay/openai`, `registerOpenAIChat`, `verifyBearer`, `loadConfig`).
The exact dropped-name list lives in `scripts/smoke.sh`. Ends with
`=== PASS ===`.

## Why this is community-supported

The Vercel target is not covered by this repository's CI or
release pipeline — the canonical artifact is the multi-arch container
image. Treat this directory as a reference; report issues but expect
PRs to take longer.
