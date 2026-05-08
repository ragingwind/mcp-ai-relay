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
  it("P1: env with AI_RELAY_API_KEY → single provider, defaults applied, id=openai_chat", () => {
    const cfg = loadConfig({ env: { AI_RELAY_API_KEY: "k" } });
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

  it("P2: reads AI_RELAY_BASE_URL, AI_RELAY_MAX_OUTPUT_TOKENS, AI_RELAY_REQUEST_TIMEOUT_MS from env", () => {
    const cfg = loadConfig({
      env: {
        AI_RELAY_API_KEY: "k",
        AI_RELAY_BASE_URL: "https://my.example.com/v1",
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

  it("D1: legacy OPENAI_API_KEY is ignored (no fallback) — env without AI_RELAY_API_KEY throws", () => {
    const err = expectThrow(() => loadConfig({ env: { OPENAI_API_KEY: "legacy" } }));
    expect(err.message).toContain("no providers resolved");
  });

  it("D2: legacy OPENAI_BASE_URL is not read when AI_RELAY_API_KEY is present", () => {
    const cfg = loadConfig({
      env: {
        AI_RELAY_API_KEY: "k",
        OPENAI_BASE_URL: "https://legacy.example.com/v1",
      },
    });
    expect(cfg.providers[0]?.baseURL).toBeUndefined();
  });
});

describe("loadConfig — file-based multi-provider", () => {
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
    expect(cfg.providers[0]?.id).toBe("openai_chat");
    expect(cfg.providers[0]?.apiKey).toBe("k1");
    expect(cfg.providers[1]?.id).toBe("azure_chat");
    expect(cfg.providers[1]?.baseURL).toBe("https://azure.example.com/v1");
  });

  it("D1: non-existent file path → error contains the path", () => {
    const missing = join(scratchDir, "does-not-exist.json");
    const err = expectThrow(() => loadConfig({ file: missing }));
    expect(err.message).toContain(missing);
  });

  it("D2: malformed JSON file → 'Invalid config file' error, no value echo", () => {
    const sentinel = "secret-leak-sentinel-xyz";
    const file = writeFile("bad.json", `{ "providers": [ ${sentinel} `);
    const err = expectThrow(() => loadConfig({ file }));
    expect(err.message).toContain("Invalid config file");
    expect(err.message).not.toContain(sentinel);
  });

  it("D3: file missing 'providers' array → Zod error mentions failing path", () => {
    const file = writeFile("empty.json", "{}");
    const err = expectThrow(() => loadConfig({ file }));
    expect(err.message).toContain("providers");
  });
});

describe("loadConfig — args overrides", () => {
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

  it("P2: args > env — when both define maxOutputTokens, args wins", () => {
    const cfg = loadConfig({
      env: { AI_RELAY_API_KEY: "env-key", AI_RELAY_MAX_OUTPUT_TOKENS: "1000" },
      args: { provider: "openai", capability: "chat", maxOutputTokens: 8192 },
    });
    const p = cfg.providers[0];
    if (!p) throw new Error("provider missing");
    expect(p.maxOutputTokens).toBe(8192);
    expect(p.apiKey).toBe("env-key");
  });

  it("P3: explicit args.id overrides default <provider>_<capability>", () => {
    const cfg = loadConfig({
      args: { provider: "openai", capability: "chat", apiKey: "k", id: "my_custom_id" },
    });
    expect(cfg.providers[0]?.id).toBe("my_custom_id");
  });
});

describe("loadConfig — file + args merge", () => {
  it("P1: file with one openai provider + args.maxOutputTokens → args wins for matched provider", () => {
    const file = writeFile(
      "file-args-merge.json",
      JSON.stringify({
        providers: [
          {
            provider: "openai",
            capability: "chat",
            apiKey: "file-key",
            maxOutputTokens: 1000,
          },
        ],
      }),
    );
    const cfg = loadConfig({
      file,
      args: { provider: "openai", capability: "chat", maxOutputTokens: 8192 },
    });
    expect(cfg.providers).toHaveLength(1);
    const p = cfg.providers[0];
    if (!p) throw new Error("provider missing");
    expect(p.maxOutputTokens).toBe(8192);
    expect(p.apiKey).toBe("file-key");
  });

  it("P2: args.id overrides file provider id when provider+capability match", () => {
    const file = writeFile(
      "file-args-id.json",
      JSON.stringify({
        providers: [
          {
            id: "from_file",
            provider: "openai",
            capability: "chat",
            apiKey: "k",
          },
        ],
      }),
    );
    const cfg = loadConfig({
      file,
      args: { provider: "openai", capability: "chat", id: "from_args" },
    });
    expect(cfg.providers[0]?.id).toBe("from_args");
  });

  it("N1: args.provider does not match any file provider → file unchanged, no throw", () => {
    const file = writeFile(
      "file-args-mismatch.json",
      JSON.stringify({
        providers: [
          {
            provider: "openai",
            capability: "chat",
            apiKey: "file-key",
            maxOutputTokens: 1234,
          },
        ],
      }),
    );
    const cfg = loadConfig({
      file,
      args: { provider: "openai", capability: "chat" },
    });
    expect(cfg.providers[0]?.maxOutputTokens).toBe(1234);
    expect(cfg.providers[0]?.apiKey).toBe("file-key");
  });
});

describe("loadConfig — error paths", () => {
  it("D1: empty source → 'no providers resolved' error", () => {
    const err = expectThrow(() => loadConfig({}));
    expect(err.message).toContain("no providers resolved");
  });
});

describe("loadConfig — secret redaction", () => {
  it("D1: apiKey value never appears in error message", () => {
    const sentinel = "leak-marker-apikey-1234567890";
    const err = expectThrow(() =>
      loadConfig({
        env: { WRONG_KEY: sentinel },
        args: { provider: "openai", capability: "chat" },
      }),
    );
    expect(err.message).not.toContain(sentinel);
  });

  it("D2: empty-string apiKey rejected; the failing input is not echoed", () => {
    const sentinel = "another-leak-marker-9999";
    const err = expectThrow(() =>
      loadConfig({
        args: { provider: "openai", capability: "chat", apiKey: "" },
        env: { AI_RELAY_BASE_URL: sentinel },
      }),
    );
    expect(err.message).not.toContain(sentinel);
  });
});
