# ai-relay

> OpenAI Chat Completions (및 OpenAI 호환 업스트림)을 Model Context Protocol 도구로 노출하는 MCP 릴레이입니다.

> English: [README.md](./README.md)

`ai-relay`를 사용하면 모든 [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
호스트가 OpenAI 호환 채팅 모델을 도구처럼 호출할 수 있습니다. 동일한 SDK가
서로 교체 가능한 4개의 사용 표면을 제공하므로 — 배포 방식에 맞는 것을 고르세요.

```
MCP host  ──►  ai-relay  ──►  OpenAI-compatible API
              (CLI | SDK | App | Docker)
```

---

## 사용 표면

| 표면 | 전송 | 설치 | 사용 시점 |
|---|---|---|---|
| `npx ai-relay-cli <provider> <tool> [flags] [input]` | 없음 (단발) | 없음 | 빠른 테스트, 스크립팅, CI 스모크 |
| `npx ai-relay <provider>` | stdio MCP | 없음 | Claude Desktop / Claude Code / Cursor 직접 등록 |
| SDK (`ai-relay`) | 호출자 선택 (stdio / HTTP / Workers) | npm | 커스텀 MCP 서버에 임베드 |
| App (`./app`, Hono) | HTTP | `git clone` (Node에 셀프 호스트) | 개인 또는 팀 HTTP 엔드포인트 |
| Docker (`ghcr.io/ragingwind/ai-relay`) | HTTP | `docker run` (빌드 없음) | 컨테이너 배포, 멀티 아키텍처 (amd64/arm64) |

---

## 빠른 시작 — 단발 CLI (`ai-relay-cli`)

```bash
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini "ping"

# 모델을 JSON 입력에 포함시켜도 됩니다
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions \
  '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'

# …또는 환경변수로
AI_RELAY_API_KEY=sk-... AI_RELAY_MODEL=gpt-4o-mini \
  npx ai-relay-cli openai chat-completions "ping"

echo "explain TLS in 2 sentences" \
  | AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini -s "be terse"

# 환경변수 없이 플래그로 API 키 직접 전달:
npx ai-relay-cli openai chat-completions -m gpt-4o-mini --api-key sk-... "ping"

# Azure OpenAI / vLLM / Ollama / AI Gateway 등 OpenAI 호환 엔드포인트 지정:
AI_RELAY_API_KEY=sk-... npx ai-relay-cli openai chat-completions -m gpt-4o-mini \
  --base-url https://my-azure.openai.azure.com/v1 \
  "ping"
```

호출 형식은 `ai-relay-cli <provider> <tool> [flags] [input]`입니다.
현재 provider는 `openai` 하나이며 `chat-completions` 도구를 노출합니다.
향후 `anthropic`(`messages`), 추가 OpenAI `responses` 등이 레지스트리에
편입될 예정입니다. 입력은 위치 인자이거나 stdin으로 파이프되며
(정확히 하나 — XOR 관계). 평문 위치 인자는 `{messages:[…]}` 배열이 되고,
JSON 리터럴 (`{` / `[`)은 그대로 전달됩니다.

모델 해결 순서(먼저 발견된 값이 우선): JSON 입력의 `model` 필드 →
`-m`/`--model <id>` 플래그 → `AI_RELAY_MODEL` 환경변수.

**디버깅:** `-v` / `--verbose` 플래그(또는 `AI_RELAY_VERBOSE=1` 환경
변수)를 사용하면 각 단계(`argv`, `parsed-flags`, `env-snapshot`,
`loaded-config`, `openai-request`, `result` 등)가 stderr로 추적됩니다.
시크릿과 응답 본문은 자동으로 마스킹되며, stdout JSON 채널은 절대 오염되지
않습니다.

---

## 빠른 시작 — stdio MCP 서버 (`ai-relay <provider>`)

Claude Desktop, Claude Code, Cursor 등 자식 프로세스를 spawn해 stdin/stdout으로
JSON-RPC를 주고받는 MCP 호스트에 직접 등록할 때 사용합니다.

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

`ai-relay <provider>` 형태로 실행해 stdio MCP 서버 모드로 동작합니다
(현재 지원되는 provider는 `openai` 하나이며 `chat-completions` 도구를
노출). 단발 셸 호출에는 `ai-relay-cli <provider> <tool> -m <model> "…"`를
사용합니다.

Azure OpenAI / vLLM / Ollama / AI Gateway 같은 OpenAI 호환 엔드포인트를
가리키려면 `env` 블록에 `"AI_RELAY_BASE_URL"`을 추가:

```json
"env": {
  "AI_RELAY_API_KEY": "sk-...",
  "AI_RELAY_BASE_URL": "https://my-azure.openai.azure.com/v1"
}
```

MCP 서버는 플래그(`--api-key`, `--base-url`,
`--max-tokens`, `--timeout`, `--env <path>`)도 받습니다. 전체 목록은
`npx ai-relay --help`.

---

## 빠른 시작 — Docker

```bash
docker run -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  ghcr.io/ragingwind/ai-relay:latest
```

MCP 엔드포인트는 `http://localhost:8787/api/mcp`에서, 라이브니스 체크는
`http://localhost:8787/healthz`에서 제공됩니다. 이미지는 멀티 아키텍처
(amd64 + arm64)이며, 모든 `v*` 태그에서
[`release-app` 워크플로우](./.github/workflows/release-app.yml)가 자동
빌드해 푸시합니다.

`docker compose up`은 `compose.yml`(퍼블리시된 이미지를 pull)로 동작합니다.
로컬 빌드 개발은 `compose.dev.yml`을 사용하세요:

```bash
docker compose -f compose.dev.yml up --build
```

---

## 빠른 시작 — SDK 임베드

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, { apiKey: process.env.AI_RELAY_API_KEY! });
await server.connect(new StdioServerTransport());
```

실행 가능한 전체 버전은 [`examples/stdio/`](./examples/stdio/),
[`examples/multi-upstream/`](./examples/multi-upstream/),
[`examples/cloudflare-workers/`](./examples/cloudflare-workers/)에 있습니다.

---

## 환경 변수

| 변수 | 범위 | 필수 | 기본값 |
|---|---|---|---|
| `AI_RELAY_API_KEY` | 업스트림 자격 증명 (CLI + 앱) | 예 (CLI + 앱) | — |
| `AI_RELAY_BASE_URL` | 업스트림 엔드포인트 오버라이드 | 아니오 | SDK 기본값 |
| `AI_RELAY_MAX_OUTPUT_TOKENS` | 요청당 `max_tokens` ceiling | 아니오 | 4096 |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | 업스트림 HTTP 타임아웃 | 아니오 | 60000 |
| `AI_RELAY_AUTH_TOKEN` | `./app` 라우트용 HTTP bearer (서버 전용) | 예 (앱) | — |
| `AI_RELAY_PORT` | Hono 서버 바인드 포트 | 아니오 (앱) | 8787 |

---

## v0.1에서 마이그레이션

| 이전 | 새 이름 | 출처 |
|---|---|---|
| `mcp-ai-relay` (bin) | `ai-relay` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `mcp-ai-relay --openai-completion` (stdio) | `ai-relay openai chat -m … "…"` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `--tool-name <id>` | (제거됨; 기본 도구 이름은 `chat-completions`) | [#55](https://github.com/ragingwind/mcp-ai-relay/issues/55) + [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `completion_chat` / `openai_chat` (기본 도구 이름) | `chat-completions` | [#55](https://github.com/ragingwind/mcp-ai-relay/issues/55) |
| `OPENAI_API_KEY` | `AI_RELAY_API_KEY` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `OPENAI_BASE_URL` | `AI_RELAY_BASE_URL` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `MAX_OUTPUT_TOKENS_CEILING` | `AI_RELAY_MAX_OUTPUT_TOKENS` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `REQUEST_TIMEOUT_MS` | `AI_RELAY_REQUEST_TIMEOUT_MS` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `RELAY_AUTH_TOKEN` | `AI_RELAY_AUTH_TOKEN` | [#57](https://github.com/ragingwind/mcp-ai-relay/issues/57) |
| `docker build .` (Next.js, 포트 3000) | `docker run ghcr.io/ragingwind/ai-relay` (Hono, 포트 8787) | [#57](https://github.com/ragingwind/mcp-ai-relay/issues/57) |

---

## 상태

**v0.5.0** (npm SDK) / **v1 릴레이 앱** — 도구 1개 `chat-completions`,
Bearer 토큰 인증, Streamable HTTP 트랜스포트. v2 백로그(Responses API,
OAuth 2.1, rate limiting, budget caps, observability)는
[`doc/ARCHITECTURE.ko.md` §11](./doc/ARCHITECTURE.ko.md#11-v2-백로그)에
정리되어 있습니다.

---

## 문서

| 주제 | 문서 |
|---|---|
| SDK API + CLI + 레시피 | [`packages/ai-relay/README.md`](./packages/ai-relay/README.md) (영문) |
| 아키텍처, 의사결정, 참고문헌 | [`doc/ARCHITECTURE.ko.md`](./doc/ARCHITECTURE.ko.md) |
| 배포 런북 (Vercel + Docker, 운영) | [`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) |
| AI 에이전트 협업 가이드 | [`CLAUDE.md`](./CLAUDE.md) |

다른 언어 / 관련 문서 (영문이 정본):
[`README.md`](./README.md) ·
[`doc/ARCHITECTURE.ko.md`](./doc/ARCHITECTURE.ko.md) ·
[`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) ·
[`doc/QA-MCP-INSPECTOR.ko.md`](./doc/QA-MCP-INSPECTOR.ko.md).

---

## 기여하기

로컬 개발에는 Node.js 20.x + pnpm 9가 필요합니다:

```bash
pnpm install
cp .env.example .env.local        # fill AI_RELAY_API_KEY + AI_RELAY_AUTH_TOKEN
pnpm dev                          # http://localhost:8787/api/mcp
pnpm test                         # vitest
```

`.env.local`이 없거나 `AI_RELAY_AUTH_TOKEN`이 비어 있으면 `pnpm dev`는 실행을
거부하고 조치 안내를 출력합니다. 모든 빌드/테스트/검증 명령은
[`CLAUDE.md` §3 — Verify Commands](./CLAUDE.md#3-verify-commands)에서
확인할 수 있습니다.

---

## 라이선스

MIT — [LICENSE](./LICENSE) 참고.
