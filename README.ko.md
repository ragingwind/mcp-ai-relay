# mcp-ai-relay

> English: [README.md](./README.md)

OpenAI Chat Completions API를 [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
도구로 노출하는 릴레이 서버입니다. Claude Code 같은 MCP 호스트에 이 서버를
등록하면 호스트의 LLM이 OpenAI 모델을 도구처럼 호출할 수 있습니다.

```
[ MCP 호스트 (Claude Code) ]  --bearer-->  [ 이 릴레이 ]  --API key-->  [ OpenAI / 호환 업스트림 ]
```

**Vercel** (관리형 서버리스) 또는 **Docker 컨테이너** (셀프 호스팅)로 실행
가능합니다.

---

## 빠른 시작 (Docker Compose)

로컬이나 단일 호스트에서 가장 빠르게 띄우는 방법:

```bash
git clone https://github.com/ragingwind/mcp-ai-relay.git
cd mcp-ai-relay
cp .env.example .env.local
# OPENAI_API_KEY 와 RELAY_AUTH_TOKEN(32바이트 이상 — `openssl rand -hex 32`) 채우기
docker compose up -d
```

이제 MCP 엔드포인트는 `http://localhost:8787/api/mcp` 입니다. 종료는
`docker compose down`. 호스트 포트를 바꾸려면
`HOST_PORT=... docker compose up -d`.

다른 배포 경로(Vercel 서버리스, raw `docker run`, 운영 절차 전반)는
[`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) 참고.

---

## 상태

**v1 (현재)** — 도구 1개 `completion_chat`, Bearer 토큰 인증, Streamable
HTTP 트랜스포트. v2 백로그(Responses API, OAuth 2.1, rate limiting,
budget caps, observability)는
[`doc/ARCHITECTURE.ko.md` §11](./doc/ARCHITECTURE.ko.md#11-v2-백로그)에
정리되어 있습니다.

---

## 도구: `completion_chat`

OpenAI Chat Completions를 한 번 호출하고 누적된 응답 텍스트를 반환합니다.

| 입력 | 타입 | 필수 |
|---|---|---|
| `model` | `string` | ✅ |
| `messages` | `Array<{role, content}>` | ✅ |
| `temperature` | `number` (0~2) | |
| `max_tokens` | `number` (서버 ceiling으로 클램프) | |
| `top_p` | `number` (0~1) | |
| `stop` | `string \| string[]` | |

응답: 누적 텍스트 + `usage` 메타데이터. 전체 스키마는
[`doc/ARCHITECTURE.ko.md` §4](./doc/ARCHITECTURE.ko.md#4-mcp-도구-정의)에
있습니다.

---

## Claude Code에서 사용

```bash
claude mcp add --transport http openai-relay \
  http://localhost:8787/api/mcp \
  --header "Authorization: Bearer <RELAY_AUTH_TOKEN>"
```

또는 `.mcp.json`에 직접 등록:

```json
{
  "mcpServers": {
    "openai-relay": {
      "type": "http",
      "url": "${RELAY_URL:-http://localhost:8787/api/mcp}",
      "headers": { "Authorization": "Bearer ${RELAY_AUTH_TOKEN}" }
    }
  }
}
```

> **Claude Desktop**은 원격 MCP 서버를 UI의 **Settings → Connectors**에서
> 등록합니다 (Pro/Max 요금제 한정). `claude_desktop_config.json`이 아닙니다.

---

## 자기 MCP 서버에 임베드

이 릴레이 앱을 그대로 띄우는 대신 자기 MCP 서버(Vercel/Next.js,
Cloudflare Workers, Claude Desktop 직결용 stdio, Hono 등)에
`completion_chat` 기능만 심고 싶다면 두 가지 경로가 있습니다:

**Zero-config (코드 없이) — `npx`**

Claude Desktop의 `claude_desktop_config.json`에 바로 등록:

```json
{
  "mcpServers": {
    "openai-relay": {
      "command": "npx",
      "args": ["-y", "@ragingwind/ai-relay", "--openai-completion"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

**라이브러리 API (전체 제어권)**

```bash
npm install @ragingwind/ai-relay @modelcontextprotocol/sdk openai
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "@ragingwind/ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, { apiKey: process.env.OPENAI_API_KEY! });
```

`registerOpenAIChat`은 closure로 격리되므로, 같은 서버가 여러 업스트림
(OpenAI proper + Azure + 로컬 vLLM, …)을 별개의 이름을 가진 도구로
호스팅할 수 있습니다. 전체 API 레퍼런스:
[`packages/sdk/README.md`](./packages/sdk/README.md) (영문).

[`examples/`](./examples/) 의 실행 가능 예제:

| 예제 | 용도 |
|---|---|
| [`stdio/`](./examples/stdio/) | Claude Desktop 직결용 단일 도구 stdio launcher |
| [`multi-upstream/`](./examples/multi-upstream/) | 한 서버에 여러 업스트림 등록 (OpenAI + Azure + 로컬 LLM) — C7 다중 등록 시나리오 |
| [`cloudflare-workers/`](./examples/cloudflare-workers/) | `agents/mcp` 프레임워크 기반 Workers MCP |

---

## 기여하기

로컬 개발에는 Node.js 20.x + pnpm 9가 필요합니다:

```bash
pnpm install
cp .env.example .env.local        # OPENAI_API_KEY + RELAY_AUTH_TOKEN 채우기
pnpm dev                          # http://localhost:3000/api/mcp
pnpm test                         # vitest
```

`.env.local`이 없거나 두 필수 값이 비어 있으면 `pnpm dev`는 실행을 거부하고
조치 안내를 출력합니다. 모든 빌드/테스트/검증 명령은
[`CLAUDE.md` §3 — Verify Commands](./CLAUDE.md#3-verify-commands)에서 확인할
수 있습니다.

---

## 문서

| 주제 | 문서 |
|---|---|
| 아키텍처, 의사결정, 참고문헌 | [`doc/ARCHITECTURE.ko.md`](./doc/ARCHITECTURE.ko.md) |
| 배포 런북 (Vercel + Docker, 운영) | [`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) |
| 수동 검증 (PR 전 / 배포 후) | [`doc/QA-MCP-INSPECTOR.ko.md`](./doc/QA-MCP-INSPECTOR.ko.md) |
| AI 에이전트 협업 가이드 | [`CLAUDE.md`](./CLAUDE.md) |

---

## 라이선스

MIT — [LICENSE](./LICENSE) 참고.
