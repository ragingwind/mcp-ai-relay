# ai-relay

> OpenAI Chat Completions(및 OpenAI 호환 업스트림)를 Model Context Protocol 도구로 노출하는 MCP 릴레이입니다.

> English: [README.md](./README.md)

---

## Quick reference

**1. 단발 CLI** — 셸에서 모델 호출:

```bash
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini "ping"
```

**2. stdio MCP** — Claude Desktop / Claude Code / Cursor에 등록:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "openai"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

**3. Docker HTTP** — MCP HTTP 엔드포인트 셀프 호스팅:

```bash
docker run -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  ghcr.io/ragingwind/ai-relay:latest
```

**4. SDK** — 직접 만든 MCP 서버에 임베드:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, { apiKey: process.env.AI_RELAY_API_KEY! });
await server.connect(new StdioServerTransport());
```

---

## 1. 단발 CLI

호출 형식: `ai-relay-cli <provider> <tool> [flags] [input]`. 현재 `<provider>`는 `openai`, `<tool>`은 `chat-completions`. 모델은 JSON 입력 → `-m` 플래그 → `AI_RELAY_MODEL` 순으로 해결됩니다. 입력은 위치 인자 또는 stdin 파이프 둘 중 하나(XOR); 평문은 `{messages:[{role:"user",content:…}]}` 배열로 감싸지고, JSON 리터럴(`{` / `[`)은 그대로 전달됩니다.

```bash
# JSON 입력 (payload에 모델 포함)
npx ai-relay-cli openai chat-completions \
  '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'

# stdin + 시스템 프롬프트
echo "explain TLS in 2 sentences" \
  | npx ai-relay-cli openai chat-completions -m gpt-4o-mini -s "be terse"

# Azure OpenAI / vLLM / Ollama / AI Gateway 같은 OpenAI 호환 엔드포인트
npx ai-relay-cli openai chat-completions -m gpt-4o-mini \
  --api-key sk-... --base-url https://my-azure.openai.azure.com/v1 "ping"
```

전체 플래그는 `npx ai-relay-cli --help`. `-v` / `--verbose` (또는 `AI_RELAY_VERBOSE=1`)로 각 단계를 stderr로 추적; 시크릿은 마스킹되고 stdout JSON은 오염되지 않습니다.

---

## 2. stdio MCP 서버

자식 프로세스를 spawn해 stdin/stdout으로 JSON-RPC를 주고받는 모든 호스트(Claude Desktop, Claude Code, Cursor, 프로젝트 로컬 `.mcp.json`)에 `ai-relay`를 등록합니다. `sk-...`만 본인 키로 바꾸면 끝.

OpenAI 호환 엔드포인트를 가리키려면 `env` 블록에 `AI_RELAY_BASE_URL` 추가:

```json
"env": {
  "AI_RELAY_API_KEY": "sk-...",
  "AI_RELAY_BASE_URL": "https://my-azure.openai.azure.com/v1"
}
```

`--api-key`, `--base-url`, `--max-tokens`, `--timeout`, `--env <path>` 플래그도 받습니다. 전체 목록은 `npx ai-relay --help`.

---

## 3. Docker HTTP 서버

컨테이너는 `http://localhost:8787/api/mcp`에서 MCP를 제공 (Bearer 인증: `AI_RELAY_AUTH_TOKEN`), `http://localhost:8787/healthz`에서 liveness probe를 제공합니다. 이미지는 멀티 아키텍처(amd64 + arm64), `ghcr.io/ragingwind/ai-relay:latest`.

Docker Compose:

```bash
docker compose up                            # 퍼블리시된 이미지 사용
docker compose -f compose.dev.yml up --build # 로컬 빌드
```

Hono 앱을 Vercel이나 다른 환경에 셀프 호스트하려면 [`examples/vercel/`](./examples/vercel/) 참고.

---

## 4. SDK 임베드

위는 stdio 변형입니다. 같은 `registerOpenAIChat`이 HTTP(Hono / Node)와 Cloudflare Workers에서도 동작합니다. 실행 가능한 예제:

- [`examples/stdio/`](./examples/stdio/) — stdio MCP 서버
- [`examples/multi-upstream/`](./examples/multi-upstream/) — 한 서버에 여러 OpenAI 호환 업스트림
- [`examples/cloudflare-workers/`](./examples/cloudflare-workers/) — Workers
- [`examples/vercel/`](./examples/vercel/) — Hono 앱의 Vercel 배포

SDK API 레퍼런스: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md).

---

## 환경 변수

| 변수 | 필수 | 기본값 |
|---|---|---|
| `AI_RELAY_API_KEY` | 예 | — |
| `AI_RELAY_BASE_URL` | 아니오 | OpenAI 기본 |
| `AI_RELAY_MODEL` | 아니오 (CLI 전용) | — |
| `AI_RELAY_MAX_OUTPUT_TOKENS` | 아니오 | 4096 |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | 아니오 | 60000 |
| `AI_RELAY_AUTH_TOKEN` | 예 (Docker / HTTP 앱) | — |
| `AI_RELAY_PORT` | 아니오 (HTTP 앱) | 8787 |

---

## 문서

- SDK API + 레시피: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md)
- 아키텍처: [`doc/ARCHITECTURE.ko.md`](./doc/ARCHITECTURE.ko.md) ([English](./doc/ARCHITECTURE.md))
- 배포 런북: [`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) ([English](./doc/DEPLOY.md))

## 라이선스

MIT — [LICENSE](./LICENSE) 참고.
