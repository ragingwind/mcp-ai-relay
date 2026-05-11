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

`ai-relay` is no longer a Next.js project, so you cannot deploy
this repository directly to Vercel. Instead, build a thin Next.js
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

const config = loadConfig(process.env);

const handler = createMcpHandler(
  (server) => registerOpenAIChat(server, config),
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

Set `AI_RELAY_API_KEY` and `AI_RELAY_AUTH_TOKEN` as Vercel
environment variables before the first deploy.

## Why this is community-supported

The Vercel target is no longer covered by this repository's CI or
release pipeline — the canonical artifact is the multi-arch container
image. Treat this directory as a reference; report issues but expect
PRs to take longer.
