# ARCHITECTURE — mcp-ai-relay

> English: [ARCHITECTURE.md](./ARCHITECTURE.md)

OpenAI Chat Completions API를 MCP (Model Context Protocol) 도구로 노출하는
릴레이 서버입니다. Vercel(관리형 서버리스) 또는 Docker 컨테이너(셀프
호스팅)로 배포 가능합니다. Claude Code 같은 MCP 호스트가 호출하면 이 서버는
OpenAI를 호출해 응답을 그대로 호스트에 돌려줍니다.

이 문서는 v1 아키텍처의 단일 진실 원천(SSOT)입니다. 배경 리서치, 트레이드
오프, 검토했던 대안은 [참고 자료](#참고-자료)의 출처를 보세요.

---

## 1. 핵심 결정 (v1)

| # | 결정 | 근거 (요약) |
|---|---|---|
| D1 | **Next.js 15+ App Router** + 단일 라우트 | Vercel 공식 `mcp-handler` 템플릿 레이아웃과 OAuth 메타데이터 라우트 예제와 일치 |
| D2 | **OpenAI Chat Completions API만 사용** (`/v1/chat/completions`) | 가장 보편적이고 안정적. Responses API, embeddings, image 도구는 v2 |
| D3 | **Bearer 공유 비밀 인증** (`withMcpAuth`) | 단일 사용자 / 소규모 가정. OAuth 2.1은 v2 |
| D4 | **단순한 아키텍처** — observability, rate limiting, 외부 KV 없음 | observability는 나중. rate limiting과 budget cap은 v2 |
| D5 | **Node.js 20.x + Fluid Compute, region `iad1`** | mcp-handler의 공식 런타임. Edge는 25초 TTFB 한계와 호환성 이슈로 제외 |
| D6 | **Streamable HTTP 트랜스포트만** (SSE 비활성) | Stateless. Redis 의존성 회피 |
| D7 | **OpenAI 스트림은 서버에서 누적해 단일 `CallToolResult`로 반환** | MCP `tools/call`은 단일 결과만 반환. 토큰 단위 스트리밍 채널 없음 |

---

## 2. 시스템 다이어그램

```
┌──────────────────────┐                ┌─────────────────────────────┐                 ┌───────────────────┐
│  MCP Host            │  Streamable    │  Relay  (Node 20.x)         │  HTTPS/SSE      │  OpenAI API       │
│  (Claude Code, etc.) │  HTTP + Bearer │  Vercel Function or Docker  │  stream:true    │  /v1/chat/        │
│                      │ ─────────────► │  /api/[transport]/route.ts  │ ─────────────► │  completions      │
│                      │                │   ├─ withMcpAuth(bearer)    │                 │                   │
│                      │ ◄───────────── │   ├─ mcp-handler            │ ◄───────────── │                   │
│                      │  CallToolResult│   │   └─ completion_chat    │  delta chunks   │                   │
└──────────────────────┘                │   └─ accumulate stream      │                 └───────────────────┘
                                        │       → single text content │
                                        └─────────────────────────────┘
                                                     │
                                                     ▼
                                          OPENAI_API_KEY
                                          RELAY_AUTH_TOKEN
```

---

## 3. 요청 흐름 (happy path)

1. MCP 호스트가 `Authorization: Bearer <RELAY_AUTH_TOKEN>` + `tools/call`
   JSON-RPC 메시지를 `POST /api/mcp`로 전송.
2. `withMcpAuth`가 헤더 토큰을 환경변수 `RELAY_AUTH_TOKEN`과 timing-safe로
   비교.
3. `mcp-handler`가 JSON-RPC를 파싱하고 `completion_chat` 도구 핸들러 호출.
4. 도구 핸들러는 zod로 입력 검증 → 서버 정책 `max_tokens` ceiling 적용 →
   `openai` SDK의 `chat.completions.create({ stream: true, ... })` 호출
   (`AbortController` 부착).
5. 업스트림 스트림을 async iterator(`for await (const chunk of stream)`)로
   누적.
6. 누적 텍스트와 `usage` 메타데이터를 `CallToolResult`로 직렬화:
   ```ts
   {
     content: [{ type: "text", text: "<accumulated assistant message>" }],
     structuredContent: { model, usage: { prompt_tokens, completion_tokens, total_tokens } },
     isError: false
   }
   ```
7. MCP 호스트의 클라이언트 LLM이 결과를 컨텍스트에 병합.

### 취소 / 연결 끊김
- MCP `notifications/cancelled` → `AbortController.abort()` → OpenAI 요청
  종료(토큰 과금 중단).
- HTTP 클라이언트가 끊으면 Next.js가 `request.signal`을 abort → 동일 경로로
  전파.

### 오류 매핑
| 업스트림 | 응답 |
|---|---|
| 401/403 (auth) | `isError: true`, `code: "auth"` |
| 429 (rate limit) | `isError: true`, `code: "rate_limited"`, `retryAfter` |
| 400 `context_length_exceeded` | `isError: true`, `code: "context_length"` |
| 400 content policy | `isError: true`, `code: "content_policy"` |
| 5xx / network | `isError: true`, `code: "upstream_error"` |
| 기타 4xx | `isError: true`, `code: "bad_request"` |

비스트리밍 경로는 SDK 기본 retry(2회)를 사용. **스트리밍 경로는
`maxRetries: 0`** (스트림 중 retry는 출력 중복을 야기).

---

## 4. MCP 도구 정의

### `completion_chat`

OpenAI Chat Completions를 한 번 호출하고 누적된 텍스트를 반환합니다.

**입력 스키마 (Zod)**

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `model` | `string` | ✅ | 업스트림 Chat Completions 엔드포인트로 그대로 전달 |
| `messages` | `Array<{role: "system"|"user"|"assistant", content: string}>` | ✅ | OpenAI Chat 형태 |
| `temperature` | `number` (0~2) | ❌ | OpenAI 기본값 적용 |
| `max_tokens` | `number` (1~`MAX_OUTPUT_TOKENS_CEILING`, 기본 4096) | ❌ | 서버 ceiling으로 클램프 |
| `top_p` | `number` (0~1) | ❌ | |
| `stop` | `string | string[]` | ❌ | |

**출력 스키마**

```ts
{
  content: [{ type: "text", text: string }],
  structuredContent: {
    model: string,
    usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number },
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call"
  }
}
```

**비고**:
- `tool_choice` / `tools` 파라미터는 v1에서 미지원 — tool call은 전달되지
  않음.
- 응답에 function/tool call이 포함되면 텍스트로 직렬화하지 않음. 대신
  `finish_reason: "tool_calls"`를 노출해 호스트 LLM이 판단하도록.

---

## 5. 디렉토리 구조

```
mcp-ai-relay/                              # 저장소 루트 — Next.js 릴레이 앱
├── app/
│   └── api/
│       └── [transport]/
│           └── route.ts                # MCP 진입점 — SDK 패키지 import
├── packages/
│   └── sdk/                            # ai-relay (publishable)
│       ├── src/
│       │   ├── index.ts                # 공개 re-export (auth)
│       │   ├── auth.ts                 # verifyBearer (portable, node:crypto 불필요)
│       │   ├── env.ts                  # parseEnv (opt-in subpath)
│       │   └── openai/
│       │       ├── index.ts            # provider re-export
│       │       ├── chat.ts             # registerOpenAIChat + makeOpenAIChatHandler
│       │       └── client.ts           # createOpenAIClient 팩토리
│       ├── tests/
│       │   ├── setup-env.ts
│       │   └── unit/
│       │       ├── auth.test.ts
│       │       ├── chat.test.ts
│       │       ├── env.test.ts
│       │       └── multi-registration.test.ts
│       ├── package.json                # exports map + peerDeps + tsc 빌드
│       ├── tsconfig.json               # 루트 extends (typecheck 모드)
│       ├── tsconfig.build.json         # npm consumer용 dist/ 생성
│       └── vitest.config.ts
├── tests/
│   ├── setup-env.ts                    # 라우트 테스트용 process.env 시드
│   └── integration/
│       └── route.test.ts               # 라우트를 Web Request → Response로 직접 호출
├── scripts/
│   ├── verify.mjs                      # pnpm dev 대상 자동 C1/C2/C5 스모크
│   ├── mcp-inspect.mjs                 # MCP Inspector CLI 래핑 — 단발 tools/call
│   └── check-dev-env.mjs               # pnpm dev 사전 env 체크
├── doc/
│   ├── ARCHITECTURE.md                 # 영문 SSOT
│   ├── ARCHITECTURE.ko.md              # 이 문서
│   ├── DEPLOY.md                       # Vercel + Docker 런북 (영문)
│   ├── DEPLOY.ko.md                    # Vercel + Docker 런북 (한국어)
│   ├── QA-MCP-INSPECTOR.md             # 수동 검증 절차 (영문)
│   └── QA-MCP-INSPECTOR.ko.md          # 수동 검증 절차 (한국어)
├── CLAUDE.md                           # AI 에이전트 협업 가이드
├── Dockerfile                          # multi-stage, node:20-alpine digest pin
├── compose.yml                         # 단일 호스트 셀프 호스팅 런처
├── vercel.json                         # maxDuration: 300, region: iad1 고정
├── pnpm-workspace.yaml                 # workspace에 packages/* 등록
├── package.json                        # ai-relay (workspace:*) 의존
├── tsconfig.json
├── biome.json
├── vitest.workspace.ts                 # SDK unit + integration 프로젝트
├── next.config.ts                      # transpilePackages: [ai-relay]
├── .env.example
└── .gitignore
```

---

## 6. 기술 스택 (확정)

| 분야 | 선택 |
|---|---|
| Framework | Next.js `^15` (App Router) |
| MCP handler | `mcp-handler@^1.1` |
| MCP SDK | `@modelcontextprotocol/sdk@^1.26` |
| Validation | `zod@^3` |
| OpenAI SDK | `openai@^6` |
| Runtime | Node.js `20.x` + Fluid Compute |
| Language | TypeScript strict, NodeNext ESM, `verbatimModuleSyntax: true` |
| Package manager | pnpm `^9` (`packageManager` 필드로 고정) |
| Lint/Format | Biome `^2` |
| Test | vitest + msw (HTTP 경계에서 mock) |
| Deployment | Vercel Pro, region `iad1`, `maxDuration: 300` |
| SDK 빌드 | `tsc -p tsconfig.build.json` → `packages/ai-relay/dist/`; ESM, peerDeps는 `@modelcontextprotocol/sdk` + `openai`(optional) |

### `vercel.json`
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["iad1"],
  "functions": {
    "app/api/**/route.ts": {
      "maxDuration": 300,
      "runtime": "nodejs20.x"
    }
  }
}
```

### `tsconfig.json` 핵심
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

---

## 7. 환경변수

| 키 | 필수 | 비밀 | 설명 |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | Sensitive | OpenAI API 키. Production/Preview용 키 분리 권장. |
| `OPENAI_BASE_URL` | ❌ | Plain | OpenAI SDK base URL 오버라이드. 기본: SDK 내장. Azure OpenAI / vLLM/Ollama 게이트웨이 / 로컬 mock으로 향하게 할 때 사용. |
| `RELAY_AUTH_TOKEN` | ✅ | Sensitive | MCP 호스트가 보내는 Bearer 토큰. 32바이트 이상 random. |
| `MAX_OUTPUT_TOKENS_CEILING` | ❌ | Plain | 정수. 기본 `4096`. 호출자 값을 덮어씀. |
| `REQUEST_TIMEOUT_MS` | ❌ | Plain | 정수. 기본 `60000`. OpenAI 호출 타임아웃. |

`.env.example`에는 키 이름만 기록하고 값은 절대 커밋 금지. 비밀은 Vercel
대시보드에서 Sensitive 플래그로 등록.

---

## 8. 인증 (v1)

```ts
// lib/auth.ts (개념)
import { timingSafeEqual } from "node:crypto";

export function verifyToken(req: Request, bearerToken: string | undefined) {
  if (!bearerToken) return undefined;            // 미인증
  const expected = process.env.RELAY_AUTH_TOKEN;
  if (!expected) return undefined;                // fail-closed
  const a = Buffer.from(bearerToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return undefined;
  if (!timingSafeEqual(a, b)) return undefined;
  return { clientId: "shared-secret", scopes: ["openai:chat"] };
}
```

라우트 핸들러는
`withMcpAuth(handler, verifyToken, { required: true, requiredScopes: ["openai:chat"] })`로
래핑. 미인증 요청에 대해서는 `mcp-handler`가 자동으로 401 +
`WWW-Authenticate` + `/.well-known/oauth-protected-resource` 헤더를 반환.

> v2에서 OAuth 2.1로 진화할 때 `verifyToken`만 교체하면 됨 — 라우트
> 시그니처는 그대로.

---

## 9. 보안 — v1 최소 셋

- 응답/로그/오류 메시지에 `OPENAI_API_KEY`를 절대 노출하지 않는다.
- Bearer 토큰은 항상 `timingSafeEqual`로 비교한다.
- 모든 도구 입력은 zod로 엄격하게 검증한다 (`.strict()` 사용).
- `max_tokens`는 호출자 값을 받지만 서버 ceiling으로 클램프한다.
- `console` 로그는 메타데이터(model, token count, latency, status)만
  포함한다. **prompt/response 본문은 절대 로그에 남기지 않는다.**
- Preview 배포는 기본적으로 Vercel Authentication으로 보호된다.

### v1 미포함 (의도적)
- Rate limiting (Upstash 등)
- 일별 토큰/달러 budget 카운터
- OAuth 2.1
- 외부 observability (Sentry, OTel, Axiom)
- 호출자별 사용량 추적

위 항목들은 §11에 v2 후보로 정리.

---

## 10. 테스트 전략 (v1)

| 레이어 | 도구 | 범위 |
|---|---|---|
| Unit (SDK) | vitest + msw, `packages/ai-relay/` 안에서 실행 | `verifyBearer`, `parseEnv`, `registerOpenAIChat` 팩토리 — 입력 검증, max_tokens 클램프, 오류 매핑 |
| Multi-registration | vitest + msw, 실제 `McpServer` | 같은 server에 다른 `name` + `apiKey` + `baseURL`로 여러 번 등록 — 각 핸들러가 자기 업스트림으로 라우팅, 상호 영향 없음 |
| Integration | vitest, 라우트를 Web `Request`/`Response`로 직접 호출 | Bearer auth (있음/없음/잘못됨), MCP `tools/list` / `tools/call` JSON-RPC 흐름 |
| Manual E2E | MCP Inspector | 로컬에서 `pnpm dev` → `npx @modelcontextprotocol/inspector` → Streamable HTTP, `http://localhost:3000/api/mcp` 연결 |

원칙: **OpenAI HTTP 경계에서만 mock** (MSW). SDK 모듈 자체를 mock하지 말 것
— SDK 업그레이드를 놓칠 위험이 너무 큼.

---

## 11. v2+ 백로그

- **Responses API 지원** (`openai_responses` 도구 추가)
- **Embeddings / image** 도구
- **OAuth 2.1** 인증 (`withMcpAuth`의 토큰 검증기 교체)
- **Rate limiting** — Upstash Ratelimit (Edge Middleware, IP + 토큰 2단)
- **Budget cap** — Upstash Redis 일별 토큰/달러 카운터
- **Observability** — `@vercel/otel` traces + Pino NDJSON 로그 + (선택)
  Sentry
- **Progress notifications** — `_meta.progressToken` 처리, 진행 메시지 발행
- **Tools/function-calling pass-through** — `tool_calls` 결과를
  `structuredContent`로 직렬화

---

## 참고 자료

### MCP 사양 / SDK
- [MCP Specification 2025-11-25 (overview)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Spec — Server: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Spec — Basic: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Spec — Utility: Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [MCP Spec — Utility: Cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)
- [MCP Spec — Authorization (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP Inspector docs](https://modelcontextprotocol.io/legacy/tools/inspector)
- [MCP Inspector repo](https://github.com/modelcontextprotocol/inspector)

### Vercel mcp-handler
- [npm: mcp-handler](https://www.npmjs.com/package/mcp-handler)
- [github.com/vercel/mcp-handler](https://github.com/vercel/mcp-handler)
- [Vercel docs — Deploy MCP servers to Vercel](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Vercel blog — Building efficient MCP servers](https://vercel.com/blog/building-efficient-mcp-servers)
- [Vercel template — MCP with Next.js](https://vercel.com/templates/next.js/model-context-protocol-mcp-with-next-js)

### Vercel 플랫폼
- [Vercel — Functions Limits](https://vercel.com/docs/functions/limitations)
- [Vercel — Configuring Maximum Duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel — Fluid compute](https://vercel.com/docs/fluid-compute)
- [Vercel — Runtimes](https://vercel.com/docs/functions/runtimes)
- [Vercel — Configuring regions](https://vercel.com/docs/functions/configuring-functions/region)
- [Vercel — Environment Variables](https://vercel.com/docs/environment-variables)
- [Vercel — Sensitive Environment Variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
- [Vercel — Bypass body size limit](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
- [Vercel — Package Managers](https://vercel.com/docs/package-managers)
- [Vercel KB — April 2026 Security Incident](https://vercel.com/kb/bulletin/vercel-april-2026-security-incident)
- [Vercel — Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)

### OpenAI
- [openai-node README](https://github.com/openai/openai-node)
- [openai npm metadata](https://registry.npmjs.org/openai/latest)
- [OpenAI — Migrate to Responses](https://platform.openai.com/docs/guides/migrate-to-responses)
- [OpenAI — API Deprecations](https://developers.openai.com/api/docs/deprecations)
- [OpenAI — Rate Limits Guide](https://developers.openai.com/api/docs/guides/rate-limits)

### Claude Code / Claude Desktop
- [Claude Code — MCP docs (`claude mcp add`, scopes, `.mcp.json`)](https://code.claude.com/docs/en/mcp)
- [Claude — Custom Integrations via Remote MCP (Connectors UI)](https://support.claude.com/en/articles/11175166-getting-started-with-custom-integrations-using-remote-mcp)

### 도구 / 라이브러리
- [Zod](https://zod.dev/)
- [Biome](https://biomejs.dev/)
- [Vitest](https://vitest.dev/)
- [MSW](https://mswjs.io/)
