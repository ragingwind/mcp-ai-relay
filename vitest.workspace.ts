import { defineWorkspace } from "vitest/config";

// Two test surfaces:
//   • SDK unit tests  — in packages/sdk/, configured by its own vitest.config.ts.
//   • App integration — exercises the Next.js route end-to-end against the
//     workspace-installed `@ragingwind/ai-relay`.
//
// The `tests/setup-env.ts` setup file seeds `process.env` BEFORE the route
// module loads (the route still calls `parseEnv(process.env)` at module
// load — that's app-side concern, not SDK-side).
export default defineWorkspace([
  "./packages/sdk/vitest.config.ts",
  {
    test: {
      name: "integration",
      include: ["tests/integration/**/*.test.ts"],
      environment: "node",
      setupFiles: ["./tests/setup-env.ts"],
    },
  },
]);
