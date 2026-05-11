#!/usr/bin/env node
// Standalone env pre-flight. Invoke via `pnpm check-env` (which auto-loads
// .env.local via Node's --env-file-if-exists flag). Replicates the runtime
// validation in app/src/env.ts to surface failures without booting the server.

const REQUIRED = ["AI_RELAY_AUTH_TOKEN"];

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  fail([
    "",
    `[mcp-ai-relay] missing required env: ${missing.join(", ")}`,
    "",
    "  Set in .env.local (auto-loaded by pnpm scripts):",
    ...missing.map((k) => `    ${k}=...`),
    "",
    "  Or export in your shell:",
    ...missing.map((k) => `    export ${k}=...`),
    "",
    "  Generate AI_RELAY_AUTH_TOKEN if needed:  openssl rand -hex 32",
    "",
  ]);
}

if (Buffer.byteLength(process.env.AI_RELAY_AUTH_TOKEN, "utf8") < 32) {
  fail([
    "",
    "[mcp-ai-relay] AI_RELAY_AUTH_TOKEN must be at least 32 bytes.",
    "  Regenerate:  openssl rand -hex 32",
    "",
  ]);
}
