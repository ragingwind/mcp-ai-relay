// Integration test for the published-tarball install path of the
// `ai-relay` bin. Packs the SDK, installs it into a temp dir, and
// runs the bin against a local HTTP server that mimics the OpenAI
// Chat Completions endpoint (MSW cannot intercept requests issued
// from a spawned child process).

import { execFileSync, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..", "..");

interface RecordedRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface MockServer {
  url: string;
  baseURL: string;
  requests: RecordedRequest[];
  setResponse(handler: (req: RecordedRequest) => { status: number; body: string }): void;
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const recorded: RecordedRequest[] = [];
  let responder: (req: RecordedRequest) => { status: number; body: string } = () => ({
    status: 200,
    body: defaultSseBody("ok"),
  });

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const recordedReq: RecordedRequest = {
        authorization: req.headers.authorization,
        body,
      };
      recorded.push(recordedReq);
      const out = responder(recordedReq);
      res.statusCode = out.status;
      if (out.status === 200) {
        res.setHeader("content-type", "text/event-stream");
        res.end(out.body);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(out.body);
      }
    });
  });

  await new Promise<void>((resolveListen) => {
    httpServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    baseURL: `${url}/v1`,
    requests: recorded,
    setResponse(h) {
      responder = h;
    },
    async close() {
      await new Promise<void>((r, j) => httpServer.close((e) => (e ? j(e) : r())));
    },
  };
}

function defaultSseBody(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runBin(
  args: readonly string[],
  opts: { env?: Record<string, string | undefined>; input?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolveProm, reject) => {
    const spawnOpts: SpawnOptions = {
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    };
    const child = spawn(binPath, [...args], spawnOpts);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolveProm({ status: code, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

let scratchDir: string | null = null;
let binPath: string;
let mock: MockServer;

beforeAll(async () => {
  for (const name of readdirSync(SDK_DIR)) {
    if (name.endsWith(".tgz")) rmSync(join(SDK_DIR, name));
  }
  execFileSync("npm", ["pack"], { cwd: SDK_DIR, stdio: "pipe" });
  const tarballs = readdirSync(SDK_DIR).filter((f) => f.endsWith(".tgz"));
  const firstTarball = tarballs[0];
  if (tarballs.length !== 1 || !firstTarball) {
    throw new Error(
      `Expected 1 tarball after npm pack, got ${tarballs.length}: ${tarballs.join(", ")}`,
    );
  }
  const tarball = join(SDK_DIR, firstTarball);

  scratchDir = mkdtempSync(join(tmpdir(), "ai-relay-bin-"));
  writeFileSync(
    join(scratchDir, "package.json"),
    JSON.stringify({ name: "bin-tarball-test", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: scratchDir,
    stdio: "pipe",
  });
  binPath = join(scratchDir, "node_modules", ".bin", "ai-relay");
  if (!existsSync(binPath)) {
    throw new Error(`bin not present at ${binPath} after install`);
  }
  rmSync(tarball);

  mock = await startMockServer();
}, 180_000);

afterAll(async () => {
  if (mock) await mock.close();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("ai-relay bin — installed tarball", () => {
  it("S1: positional plain text → exit 0 + JSON on stdout", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("hello world") }));

    const r = await runBin(["openai", "chat", "-m", "gpt-4o-mini", "ping"], {
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toBe("hello world");
    expect(out.structuredContent.model).toBe("gpt-4o-mini");
  });

  it("S2: missing -m → exit 2; no upstream call", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));

    const r = await runBin(["openai", "chat", "ping"], {
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--model is required");
    expect(mock.requests).toHaveLength(0);
  });

  it("S3: stdin JSON path → upstream sees the parsed messages", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));

    const r = await runBin(["openai", "chat", "-m", "gpt-4o-mini"], {
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      input: '{"messages":[{"role":"user","content":"ping"}]}',
    });
    expect(r.status).toBe(0);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body).toMatchObject({
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("S4: --env file value wins over process env", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));
    if (!scratchDir) throw new Error("scratchDir missing");
    const envFile = join(scratchDir, "local.env");
    writeFileSync(envFile, `AI_RELAY_API_KEY=filekey\nAI_RELAY_BASE_URL=${mock.baseURL}\n`);

    const r = await runBin(["openai", "chat", "-m", "gpt-4o-mini", "--env", envFile, "hi"], {
      env: { AI_RELAY_API_KEY: "systemkey" },
    });
    expect(r.status).toBe(0);
    expect(mock.requests[0]?.authorization).toBe("Bearer filekey");
  });

  it("S5: --version prints SDK version", async () => {
    const r = await runBin(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
