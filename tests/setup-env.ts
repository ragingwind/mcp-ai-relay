// Clear leaked upstream envs so MSW handlers and mock-openai fixtures
// reliably intercept. Without this, a developer who has OPENAI_BASE_URL /
// OPENAI_API_KEY exported in their shell will see the OpenAI SDK target
// the leaked URL and MSW handlers will stop firing.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;

// Seeds process.env with minimal valid values BEFORE the integration
// test imports the app module (which calls `parseEnv(process.env)` at
// module load). `??=` so an externally provided value (CI secret) is not
// overwritten.
process.env.AI_RELAY_API_KEY ??= "test-ai-relay-api-key";
process.env.AI_RELAY_AUTH_TOKEN ??= "x".repeat(32);
process.env.AI_RELAY_MODEL ??= "gpt-4o-mini";
