# mcp-ai-relay

> OpenAI Chat Completions (및 OpenAI 호환 업스트림)을 Model Context Protocol 도구로 노출하는 MCP 릴레이입니다.

> English: [README.md](./README.md)

`mcp-ai-relay`를 사용하면 모든 [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
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
| `npx ai-relay` | 없음 (단발) | 없음 | 빠른 테스트, 스크립팅, CI 스모크 |
| SDK (`ai-relay`) | 호출자 선택 (stdio / HTTP / Workers) | npm | 커스텀 MCP 서버에 임베드 |
| App (`./app`, Next.js) | HTTP | `git clone` (Vercel/Node에 셀프 호스트) | 개인 또는 팀 HTTP 엔드포인트 |
| Docker (로컬 빌드) | HTTP | 이 저장소에서 `docker build` | 지금 컨테이너 배포; 퍼블리시 이미지는 [#57](https://github.com/ragingwind/mcp-ai-relay/issues/57)에서 추가 예정 |

---

## 빠른 시작 — 단발 CLI

```bash
AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini "ping"

AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini \
  '{"messages":[{"role":"user","content":"ping"}]}'

echo "explain TLS in 2 sentences" \
  | AI_RELAY_API_KEY=sk-... npx ai-relay openai chat -m gpt-4o-mini -s "be terse"
```

`-m/--model`은 필수입니다. 입력은 위치 인자이거나 stdin으로 파이프되며 (정확히
하나 — XOR 관계). 평문 위치 인자는 `{messages:[…]}` 배열이 되고, JSON 리터럴
(`{` / `[`)은 그대로 전달됩니다.

---

## 빠른 시작 — Docker (로컬 빌드)

```bash
docker build -t mcp-ai-relay .

docker run -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  mcp-ai-relay
```

이제 MCP 엔드포인트는 `http://localhost:8787/api/mcp`에서 제공됩니다.
`docker compose up`을 선호한다면 저장소 루트의 `compose.yml`도 사용 가능합니다.

> [#57](https://github.com/ragingwind/mcp-ai-relay/issues/57)이 머지되면
> `docker build` 단계는 `ghcr.io/ragingwind/ai-relay`에서 pull로 대체됩니다.
> 그때까지는 로컬 빌드로 진행하세요.

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
| `RELAY_AUTH_TOKEN` | `./app` 라우트용 HTTP bearer (서버 전용) | 예 (앱) | — |

---

## v0.1에서 마이그레이션

| 이전 | 새 이름 | 출처 |
|---|---|---|
| `mcp-ai-relay` (bin) | `ai-relay` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `mcp-ai-relay --openai-completion` (stdio) | `ai-relay openai chat -m … "…"` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `--tool-name <id>` | (제거됨; 기본 도구 이름은 `openai_chat`) | [#55](https://github.com/ragingwind/mcp-ai-relay/issues/55) + [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `completion_chat` (기본 도구 이름) | `openai_chat` | [#55](https://github.com/ragingwind/mcp-ai-relay/issues/55) |
| `OPENAI_API_KEY` | `AI_RELAY_API_KEY` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `OPENAI_BASE_URL` | `AI_RELAY_BASE_URL` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `MAX_OUTPUT_TOKENS_CEILING` | `AI_RELAY_MAX_OUTPUT_TOKENS` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |
| `REQUEST_TIMEOUT_MS` | `AI_RELAY_REQUEST_TIMEOUT_MS` | [#56](https://github.com/ragingwind/mcp-ai-relay/issues/56) |

---

## 상태

**v0.1.0** (npm SDK) / **v1 릴레이 앱** — 도구 1개 `openai_chat`,
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
cp .env.example .env.local        # fill AI_RELAY_API_KEY + RELAY_AUTH_TOKEN
pnpm dev                          # http://localhost:3000/api/mcp
pnpm test                         # vitest
```

`.env.local`이 없거나 `RELAY_AUTH_TOKEN`이 비어 있으면 `pnpm dev`는 실행을
거부하고 조치 안내를 출력합니다. 모든 빌드/테스트/검증 명령은
[`CLAUDE.md` §3 — Verify Commands](./CLAUDE.md#3-verify-commands)에서
확인할 수 있습니다.

---

## 라이선스

MIT — [LICENSE](./LICENSE) 참고.
