# mcp-ai-relay

> English: [README.md](./README.md)

OpenAI Chat Completions API를 [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
도구로 노출하는 릴레이입니다. Claude Code 또는 Claude Desktop 같은 MCP
호스트에 이 릴레이를 등록하면 호스트의 LLM이 OpenAI 모델을 도구처럼 호출할
수 있습니다.

```
[ MCP 호스트 (Claude Code, Claude Desktop, ...) ]  --bearer-->  [ 이 릴레이 ]  --API key-->  [ OpenAI / 호환 업스트림 ]
```

소비 방식은 세 가지:

1. **`npx` + MCP 호스트 설정** — 설치 없음, stdio 트랜스포트. 개인 사용이나
   빠른 실험에 적합.
2. **HTTP 서버로 실행** — Docker 셀프 호스팅 또는 Vercel 관리형. 팀 공용
   엔드포인트나 외부 노출이 필요할 때.
3. **SDK를 자기 MCP 서버에 임베드** — 가장 큰 제어권. 커스텀 로직, 다중
   업스트림 등록, 또는 비-Node 런타임이 필요할 때.

npm 패키지 이름은
[`ai-relay`](https://www.npmjs.com/package/ai-relay)
입니다. 아래에서 한 가지를 골라 진행하세요.

---

## 1. 빠른 시작 — npx (설치 없음)

`npx`가 npm에서 직접 릴레이를 stdio MCP 서버로 띄우게 합니다. 클론도, 빌드도,
호스팅할 서버도 필요 없습니다.

### 사전 준비물

- **Node.js 20+** (`npx` 용)
- **OpenAI API 키** (`sk-...`)

### 패키지 동작 검증

터미널에서 — `sk-...` 자리에 실제 키를 넣으세요:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | OPENAI_API_KEY=sk-... npx -y ai-relay --openai-completion
```

기대 결과: 한 줄짜리 JSON-RPC 응답에 `"name":"completion_chat"`이 포함됩니다.
이게 보이면 MCP 호스트에 등록할 준비가 끝난 것입니다.

### Claude Desktop에 등록

1. `claude_desktop_config.json` 을 엽니다. 경로는 OS 별:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
2. 아래 `mcpServers` 항목을 추가합니다. 파일이 비어 있으면 스니펫 전체가
   파일 내용입니다. 다른 서버가 이미 등록돼 있다면 `"openai-relay"` 키만
   기존 `"mcpServers"` 객체에 병합하세요.

```json
{
  "mcpServers": {
    "openai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "--openai-completion"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

3. **Claude Desktop을 완전히 종료** (macOS는 ⌘Q — 창만 닫는 것으로는 부족)
   하고 다시 엽니다.
4. 새 채팅에서 도구 / 커넥터 아이콘을 클릭합니다. `openai-relay` 아래에
   `completion_chat`이 보여야 합니다. 예: *"completion_chat 도구로
   gpt-4o-mini 모델을 사용해 이 페이지를 요약해줘"* — Claude가 도구를
   호출합니다.

### Claude Code에 등록

프로젝트 디렉토리에서:

```bash
claude mcp add openai-relay \
  -e OPENAI_API_KEY=sk-... \
  -- npx -y ai-relay --openai-completion
```

또는 `.mcp.json` 에 직접 작성:

```json
{
  "mcpServers": {
    "openai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "--openai-completion"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

`claude mcp list`로 등록 확인.

### 노출되는 것

호스트 LLM이 호출할 수 있는 MCP 도구 1개 (`completion_chat`):

| 입력 | 타입 | 필수 |
|---|---|---|
| `model` | `string` (예: `gpt-4o-mini`) | ✅ |
| `messages` | `Array<{role, content}>` | ✅ |
| `temperature` | `number` (0~2) | |
| `max_tokens` | `number` (서버 ceiling으로 클램프, 기본 4096) | |
| `top_p` | `number` (0~1) | |
| `stop` | `string \| string[]` | |

응답: 누적된 어시스턴트 메시지 텍스트 + 토큰 사용량.

### CLI 옵션 (전체)

```
npx -y ai-relay <provider-flag> [--name <name>] [--description <desc>]

Provider flags (정확히 1개 필수, 호출당 1개 도구):
  --openai-completion   OpenAI Chat Completions
                        Required env: OPENAI_API_KEY
                        Optional env: OPENAI_BASE_URL,
                                      OPENAI_MAX_OUTPUT_TOKENS_CEILING,
                                      OPENAI_REQUEST_TIMEOUT_MS

Options:
  --name <name>         등록할 MCP 도구 이름 오버라이드
                        (기본: completion_chat)
  --description <desc>  도구 description 오버라이드
  --help, -h            usage 출력
  --version, -V         SDK 버전 출력
```

`OPENAI_BASE_URL`은 같은 CLI를 OpenAI 호환 엔드포인트 — Azure OpenAI, vLLM,
Ollama, OpenRouter, Vercel AI Gateway(OpenAI 모드) — 어디든 가리키게 합니다.

### 한 서버에 여러 업스트림

CLI는 호출당 도구 1개를 ship 합니다. 한 MCP 서버가 OpenAI + Azure + 로컬
Ollama를 세 개의 별개 이름을 가진 도구로 호스팅하길 원한다면, SDK API를
직접 사용하세요 — [multi-upstream 예제](./examples/multi-upstream/)와
[`packages/ai-relay/README.md`](./packages/ai-relay/README.md) 참고.

---

## 2. HTTP 서버로 실행 (Docker Compose)

팀 공용 엔드포인트를 두거나 OpenAI 키를 개별 노트북이 아닌 서버에 보관하고
싶다면, 릴레이를 HTTP 서비스로 띄웁니다.

```bash
git clone https://github.com/ragingwind/mcp-ai-relay.git
cd mcp-ai-relay
cp .env.example .env.local
# OPENAI_API_KEY 와 RELAY_AUTH_TOKEN (32바이트 이상 — `openssl rand -hex 32`) 채우기
docker compose up -d
```

이제 MCP 엔드포인트는 `http://localhost:8787/api/mcp` 입니다. 종료는
`docker compose down`. 호스트 포트는 `HOST_PORT=... docker compose up -d`로
변경 가능.

MCP 호스트에서 연결:

```bash
claude mcp add --transport http openai-relay \
  http://localhost:8787/api/mcp \
  --header "Authorization: Bearer <RELAY_AUTH_TOKEN>"
```

Vercel 서버리스, raw `docker run`, 운영 절차(토큰 회전, 트러블슈팅, OpenAI
usage cap)는 [`doc/DEPLOY.md`](./doc/DEPLOY.md) 참고.

---

## 3. SDK를 자기 MCP 서버에 임베드

커스텀 MCP 서버(Cloudflare Workers, Hono/Express, 자기 Next.js 라우트 등)를
직접 만든다면 SDK 패키지가 import 표면입니다:

```bash
npm install ai-relay @modelcontextprotocol/sdk openai
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, { apiKey: process.env.OPENAI_API_KEY! });
```

`registerOpenAIChat`은 closure로 격리되므로 같은 서버가 여러 업스트림
(OpenAI + Azure + 로컬 LLM, …)을 별개의 이름을 가진 도구로 호스팅할 수
있습니다. 전체 API 레퍼런스:
[`packages/ai-relay/README.md`](./packages/ai-relay/README.md) (영문).

[`examples/`](./examples/) 의 실행 가능 예제:

| 예제 | 용도 |
|---|---|
| [`stdio/`](./examples/stdio/) | 단일 도구 stdio launcher (npx CLI와 동일 모양, 코드 기반) |
| [`multi-upstream/`](./examples/multi-upstream/) | 한 서버, 여러 업스트림 (OpenAI + Azure + 로컬 LLM) — C7 다중 등록 시나리오 |
| [`cloudflare-workers/`](./examples/cloudflare-workers/) | `agents/mcp` 프레임워크 기반 Workers MCP |

---

## 상태

**v0.1.0** (npm SDK) / **v1 릴레이 앱** — 도구 1개 `completion_chat`,
Bearer 토큰 인증, Streamable HTTP 트랜스포트. v2 백로그(Responses API,
OAuth 2.1, rate limiting, budget caps, observability)는
[`doc/ARCHITECTURE.ko.md` §11](./doc/ARCHITECTURE.ko.md#11-v2-백로그)에
정리.

---

## 기여하기

로컬 개발에는 Node.js 20.x + pnpm 9가 필요합니다:

```bash
pnpm install
cp .env.example .env.local        # OPENAI_API_KEY + RELAY_AUTH_TOKEN 채우기
pnpm dev                          # http://localhost:3000/api/mcp
pnpm test                         # vitest
```

`.env.local` 이 없거나 두 필수 값이 비어 있으면 `pnpm dev`는 실행을 거부하고
조치 안내를 출력합니다. 모든 빌드/테스트/검증 명령은
[`CLAUDE.md` §3 — Verify Commands](./CLAUDE.md#3-verify-commands) 에서
확인할 수 있습니다.

---

## 문서

| 주제 | 문서 |
|---|---|
| SDK API + 레시피 | [`packages/ai-relay/README.md`](./packages/ai-relay/README.md) (영문) |
| 아키텍처, 의사결정, 참고문헌 | [`doc/ARCHITECTURE.ko.md`](./doc/ARCHITECTURE.ko.md) |
| 배포 런북 (Vercel + Docker, 운영) | [`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) |
| 수동 검증 (PR 전 / 배포 후) | [`doc/QA-MCP-INSPECTOR.ko.md`](./doc/QA-MCP-INSPECTOR.ko.md) |
| AI 에이전트 협업 가이드 | [`CLAUDE.md`](./CLAUDE.md) |

---

## 라이선스

MIT — [LICENSE](./LICENSE) 참고.
