// Seeds process.env with minimal valid values BEFORE lib/env.ts loads in tests.
// `??=` so an externally provided value (CI secret) is not overwritten.
process.env.AI_RELAY_API_KEY ??= "test-ai-relay-api-key";
process.env.AI_RELAY_AUTH_TOKEN ??= "x".repeat(32);
