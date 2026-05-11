import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sdk",
    // Both unit and integration. Integration tests (e.g. bin-tarball)
    // spawn npm pack + npm install in a temp dir and exercise the
    // installed bin end-to-end, catching packaging regressions that
    // unit tests can't see.
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/cli/**/*.test.ts",
    ],
    setupFiles: ["./tests/setup-env.ts"],
    environment: "node",
    pool: "threads",
    // The bin-tarball integration test runs `npm pack` + `npm install`
    // (network-bound for peer deps) and may take 60-120 s on a cold
    // npm cache. Per-test `beforeAll` already declares its own
    // 180 s timeout; the file-level timeout is a defensive ceiling.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
