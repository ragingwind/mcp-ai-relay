import { defineWorkspace } from "vitest/config";

// Two test surfaces:
//   • SDK unit tests  — in packages/ai-relay/, configured by its own vitest.config.ts.
//   • App integration — exercises the Hono app end-to-end via `app.fetch(req)`
//     against the workspace-installed `ai-relay`.
//
// The `tests/setup-env.ts` setup file seeds `process.env` BEFORE the app
// module loads (the entry still calls `parseEnv(process.env)` at module
// load — that's app-side concern, not SDK-side).
export default defineWorkspace([
  "./packages/ai-relay/vitest.config.ts",
  {
    test: {
      name: "integration",
      include: ["tests/integration/**/*.test.ts"],
      environment: "node",
      setupFiles: ["./tests/setup-env.ts"],
    },
  },
]);
