#!/usr/bin/env node
import { spawn } from "node:child_process";

const SKIP_CF = process.env.SKIP_CF_SMOKE === "1";

const runs = [
  { label: "stdio", cmd: "pnpm", args: ["--filter", "@example/stdio", "smoke"] },
  { label: "multi-upstream", cmd: "pnpm", args: ["--filter", "@example/multi-upstream", "smoke"] },
  { label: "vercel", cmd: "bash", args: ["examples/vercel/scripts/smoke.sh"] },
];

if (!SKIP_CF) {
  runs.push({
    label: "cloudflare-workers",
    cmd: "pnpm",
    args: ["--filter", "@example/cloudflare-workers", "smoke"],
  });
}

function run({ label, cmd, args }) {
  return new Promise((resolve) => {
    console.log(`\n===== smoke: ${label} =====`);
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => resolve({ label, code: code ?? 1 }));
  });
}

const results = [];
for (const r of runs) {
  results.push(await run(r));
}

console.log("\n===== examples:smoke summary =====");
let failed = 0;
for (const { label, code } of results) {
  const status = code === 0 ? "PASS" : `FAIL (exit ${code})`;
  console.log(`  ${label}: ${status}`);
  if (code !== 0) failed++;
}

if (failed > 0) {
  console.log("=== FAIL ===");
  process.exit(1);
}
console.log("=== PASS ===");
