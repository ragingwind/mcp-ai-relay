import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "sdk",
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    environment: "node",
    pool: "threads",
  },
});
