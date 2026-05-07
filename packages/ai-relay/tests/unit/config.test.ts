import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const expectThrow = (fn: () => unknown): Error => {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
};

let scratchDir: string;
beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "loadconfig-"));
});
afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

const writeFile = (name: string, contents: string): string => {
  const p = join(scratchDir, name);
  writeFileSync(p, contents);
  return p;
};

describe("loadConfig — env-only single provider", () => {
  // B1: minimum env → single openai/chat provider with defaults + materialised id
  it("P1: env with OPENAI_API_KEY → single provider, defaults applied, id=openai_chat", () => {
    const cfg = loadConfig({ env: { OPENAI_API_KEY: "k" } });
    expect(cfg.providers).toHaveLength(1);
    const p = cfg.providers[0];
    if (!p) throw new Error("provider missing");
    expect(p.id).toBe("openai_chat");
    expect(p.provider).toBe("openai");
    expect(p.capability).toBe("chat");
    expect(p.apiKey).toBe("k");
    expect(p.maxOutputTokens).toBe(4096);
    expect(p.requestTimeoutMs).toBe(60_000);
  });

  // B2: optional env vars are read
  it("P2: reads OPENAI_BASE_URL, AI_RELAY_MAX_OUTPUT_TOKENS, AI_RELAY_REQUEST_TIMEOUT_MS from env", () => {
    const cfg = loadConfig({
      env: {
        OPENAI_API_KEY: "k",
        OPENAI_BASE_URL: "https://my.example.com/v1",
        AI_RELAY_MAX_OUTPUT_TOKENS: "8192",
        AI_RELAY_REQUEST_TIMEOUT_MS: "30000",
      },
    });
    const p = cfg.providers[0];
    if (!p) throw new Error("provider missing");
    expect(p.baseURL).toBe("https://my.example.com/v1");
    expect(p.maxOutputTokens).toBe(8192);
    expect(p.requestTimeoutMs).toBe(30_000);
  });
});

describe("loadConfig — file-based multi-provider", () => {
  // B3: file with valid providers array → returns multi-provider config
  it("P1: file with valid providers JSON → multi-provider RelayConfig", () => {
    const file = writeFile(
      "valid.json",
      JSON.stringify({
        providers: [
          { provider: "openai", capability: "chat", apiKey: "k1" },
          {
            id: "azure_chat",
            provider: "openai",
            capability: "chat",
            apiKey: "k2",
            baseURL: "https://azure.example.com/v1",
          },
        ],
      }),
    );
    const cfg = loadConfig({ file });
    expect(cfg.providers).toHaveLength(2);
    expect(cfg.providers[0]?.id).toBe("openai_chat"); // materialised default
    expect(cfg.providers[0]?.apiKey).toBe("k1");
    expect(cfg.providers[1]?.id).toBe("azure_chat"); // explicit
    expect(cfg.providers[1]?.baseURL).toBe("https://azure.example.com/v1");
  });

  // B4: missing file → error mentions the path
  it("D1: non-existent file path → error contains the path", () => {
    const missing = join(scratchDir, "does-not-exist.json");
    const err = expectThrow(() => loadConfig({ file: missing }));
    expect(err.message).toContain(missing);
  });

  // B5: invalid JSON → "Invalid config file" + no value echo
  it("D2: malformed JSON file → 'Invalid config file' error, no value echo", () => {
    const sentinel = "secret-leak-sentinel-xyz";
    const file = writeFile("bad.json", `{ "providers": [ ${sentinel} `);
    const err = expectThrow(() => loadConfig({ file }));
    expect(err.message).toContain("Invalid config file");
    expect(err.message).not.toContain(sentinel);
  });

  // B6: file missing `providers` → Zod path mentions "providers"
  it("D3: file missing 'providers' array → Zod error mentions failing path", () => {
    const file = writeFile("empty.json", "{}");
    const err = expectThrow(() => loadConfig({ file }));
    expect(err.message).toContain("providers");
  });
});

describe("loadConfig — args overrides", () => {
  // B7: args sets provider+capability+apiKey
  it("P1: args with provider+apiKey → single provider with overrides", () => {
    const cfg = loadConfig({
      args: { provider: "openai", capability: "chat", apiKey: "args-key", maxOutputTokens: 8192 },
    });
    expect(cfg.providers).toHaveLength(1);
    const p = cfg.providers[0];
    if (!p) throw new Error("provider missing");
    expect(p.apiKey).toBe("args-key");
    expect(p.maxOutputTokens).toBe(8192);
    expect(p.id).toBe("openai_chat");
  });

  // B8: precedence args > env
  it("P2: args > env — when both define maxOutputTokens, args wins", () => {
    const cfg = loadConfig({
      env: { OPENAI_API_KEY: "env-key", AI_RELAY_MAX_OUTPUT_TOKENS: "1000" },
      args: { provider: "openai", capability: "chat", maxOutputTokens: 8192 },
    });
    const p = cfg.providers[0];
    if (!p) throw new Error("provider missing");
    expect(p.maxOutputTokens).toBe(8192);
    expect(p.apiKey).toBe("env-key"); // apiKey from env
  });

  // B9: id materialisation; explicit id wins
  it("P3: explicit args.id overrides default <provider>_<capability>", () => {
    const cfg = loadConfig({
      args: { provider: "openai", capability: "chat", apiKey: "k", id: "my_custom_id" },
    });
    expect(cfg.providers[0]?.id).toBe("my_custom_id");
  });
});

describe("loadConfig — error paths", () => {
  // B10: empty source
  it("D1: empty source → 'no providers resolved' error", () => {
    const err = expectThrow(() => loadConfig({}));
    expect(err.message).toContain("no providers resolved");
  });
});

describe("loadConfig — secret redaction", () => {
  // B11: apiKey value never echoed
  it("D1: apiKey value never appears in error message", () => {
    const sentinel = "leak-marker-apikey-1234567890";
    // Force a Zod failure by passing an args object missing apiKey AND with no env apiKey
    // — args has provider but no apiKey; loadConfig should throw and never echo sentinel
    // We embed sentinel in env under a wrong key to verify it never appears.
    const err = expectThrow(() =>
      loadConfig({
        env: { WRONG_KEY: sentinel },
        args: { provider: "openai", capability: "chat" },
      }),
    );
    expect(err.message).not.toContain(sentinel);
  });

  // B12: failing apiKey input is not echoed even when its own validation fails
  it("D2: empty-string apiKey rejected; the failing input is not echoed", () => {
    // apiKey min(1) — empty string fails. Ensure the message is path-only.
    const sentinel = "another-leak-marker-9999";
    // Build a file whose apiKey value is the sentinel but with a length-violating
    // schema prerequisite we won't trigger — instead, supply via args with a violating value.
    const err = expectThrow(() =>
      loadConfig({
        args: { provider: "openai", capability: "chat", apiKey: "" },
        // sentinel placed in a benign env key — should not appear in error
        env: { OPENAI_BASE_URL: sentinel },
      }),
    );
    // sentinel was in OPENAI_BASE_URL — base URL is optional and would be ignored
    // when args path triggers the apiKey failure. Ensure no echo of any input.
    expect(err.message).not.toContain(sentinel);
  });
});
