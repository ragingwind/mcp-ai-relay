import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const config = JSON.parse(await readFile("vercel.json", "utf8"));
  assert(config.$schema === "https://openapi.vercel.sh/vercel.json", "vercel.json schema changed");
  assert(Array.isArray(config.regions), "vercel.json regions must be an array");
  assert(config.regions.includes("iad1"), "vercel.json must keep the iad1 region");
  assert(
    config.functions?.["app/api/**/route.ts"]?.maxDuration === 300,
    "vercel.json must keep the app/api route maxDuration at 300",
  );

  const readme = await readFile("README.md", "utf8");
  for (const snippet of [
    "community-supported",
    "no longer a Next.js project",
    "pnpm add next react react-dom ai-relay",
    "createMcpHandler",
    "vercel deploy --prod",
    "AI_RELAY_API_KEY",
    "AI_RELAY_AUTH_TOKEN",
    "maxDuration: 300",
  ]) {
    assert(readme.includes(snippet), `README.md is missing: ${snippet}`);
  }

  console.log("=== PASS ===");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
