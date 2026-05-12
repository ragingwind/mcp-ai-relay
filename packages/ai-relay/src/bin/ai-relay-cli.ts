#!/usr/bin/env node
// `ai-relay-cli <provider> <tool> [flags] [input]` — one-shot CLI relay.
// Prints a single tool result as JSON to stdout, then exits.

import { run } from "./run.js";

run(process.argv.slice(2), {
  stdin: process.stdin,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
}).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
    process.exit(1);
  },
);
