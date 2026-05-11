// Bun smoke is byte-for-byte identical to Node smoke. Duplicated rather than
// imported so each runtime fixture is self-contained — a future maintainer
// can drop a runtime cell without untangling a shared file.
//
// See ../README.md for the rationale.

const { fetch: originalFetch } = globalThis;
const SENTINEL = "smoke-bun:should-not-be-called";

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
const ALLOWED_GLOBALS = new Set(["__zod_globalConfig", "__zod_globalRegistry"]);
const newKeys = [...afterKeys].filter((k) => !beforeKeys.has(k) && !ALLOWED_GLOBALS.has(k));
assert(
  newKeys.length === 0,
  `no new globalThis keys (allowed-zod ignored; unexpected: ${JSON.stringify(newKeys)})`,
);

assert(setTimeout === setTimeoutBefore, "setTimeout identity preserved");
assert(setInterval === setIntervalBefore, "setInterval identity preserved");
assert(fetchInvoked === false, "globalThis.fetch never invoked during import");

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

assert(auth.verifyBearer("a", "a") === true, "verifyBearer('a','a') === true");
assert(auth.verifyBearer("a", "b") === false, "verifyBearer('a','b') === false");
assert(auth.verifyBearer("", "a") === false, "verifyBearer('','a') === false");

if (failures > 0) {
  console.error(`smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log("smoke: all checks passed");
