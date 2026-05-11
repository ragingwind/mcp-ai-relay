// Canonical smoke test for the published `ai-relay` tarball.
//
// Runs from inside a temp dir where `npm install <tarball>` has been
// executed. The matrix workflow re-runs this on every (runtime × node)
// cell; the local `pnpm test:runtime` runs it once.
//
// Assertions:
//   1. globalThis has no new keys after importing any of the public subpaths
//      (proves the SDK has no side-effects at import time).
//   2. `setTimeout` / `setInterval` are not patched.
//   3. `globalThis.fetch` is never called during import (we install a
//      throwing stub before the imports).
//   4. Each subpath exposes the documented named exports.

const { fetch: originalFetch } = globalThis;
const SENTINEL = "smoke-node:should-not-be-called";

let fetchInvoked = false;
globalThis.fetch = () => {
  fetchInvoked = true;
  throw new Error(SENTINEL);
};

const beforeKeys = new Set(Object.keys(globalThis));
const setTimeoutBefore = setTimeout;
const setIntervalBefore = setInterval;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`OK:   ${msg}`);
  }
}

const root = await import("ai-relay");
const env = await import("ai-relay/env");
const auth = await import("ai-relay/auth");
const openai = await import("ai-relay/openai");

const afterKeys = new Set(Object.keys(globalThis));
// Zod v4 attaches `__zod_globalConfig` and `__zod_globalRegistry` to
// globalThis at import time. These are zod-owned, not added by `ai-relay`
// itself, and the runtime contract is that nothing in our SDK creates new
// globals — so we allowlist exactly the zod ones and assert everything else
// is empty.
const ALLOWED_GLOBALS = new Set(["__zod_globalConfig", "__zod_globalRegistry"]);
const newKeys = [...afterKeys].filter((k) => !beforeKeys.has(k) && !ALLOWED_GLOBALS.has(k));
assert(
  newKeys.length === 0,
  `no new globalThis keys (allowed-zod ignored; unexpected: ${JSON.stringify(newKeys)})`,
);

assert(setTimeout === setTimeoutBefore, "setTimeout identity preserved");
assert(setInterval === setIntervalBefore, "setInterval identity preserved");
assert(fetchInvoked === false, "globalThis.fetch never invoked during import");

// Restore so subsequent code in the smoke can call fetch if it wants to.
globalThis.fetch = originalFetch;

assert(typeof root.verifyBearer === "function", "ai-relay exports verifyBearer");
assert(typeof root.loadConfig === "function", "ai-relay exports loadConfig");
assert(typeof env.loadConfig === "function", "ai-relay/env exports loadConfig");
assert(typeof auth.verifyBearer === "function", "ai-relay/auth exports verifyBearer");
assert(
  typeof openai.registerOpenAIChat === "function",
  "ai-relay/openai exports registerOpenAIChat",
);
assert(
  typeof openai.makeOpenAIChatHandler === "function",
  "ai-relay/openai exports makeOpenAIChatHandler",
);
assert(typeof openai.mapOpenAIError === "function", "ai-relay/openai exports mapOpenAIError");

// Functional sanity: verifyBearer is constant-time but still produces correct boolean.
assert(auth.verifyBearer("a", "a") === true, "verifyBearer('a','a') === true");
assert(auth.verifyBearer("a", "b") === false, "verifyBearer('a','b') === false");
assert(auth.verifyBearer("", "a") === false, "verifyBearer('','a') === false");

if (failures > 0) {
  console.error(`smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log("smoke: all checks passed");
