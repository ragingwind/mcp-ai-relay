#!/usr/bin/env node
import { run } from "./run.js";

run(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
    process.exit(1);
  },
);
