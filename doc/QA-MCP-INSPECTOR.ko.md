# QA — MCP 검증

> English: [QA-MCP-INSPECTOR.md](./QA-MCP-INSPECTOR.md)

이것이 v1의 **유일한 검증 절차**입니다. 모든 PR 머지 전에 한 번, 모든
production 배포 후에 한 번 실행하세요. v1은 UI가 없기 때문에
(`CLAUDE.md` §3에 따라 `evidence-mode: none`) 자동 브라우저 증거가
없습니다. MCP Inspector가 실제 OpenAI API 호출에 대한 end-to-end 검증의
가장 가까운 대체재입니다.

두 가지 방식:

- **자동 스모크** — `pnpm verify`가 C1, C2, C5를 ~10초 안에 커버. 대부분의
  PR에 사용.
- **수동 5-시나리오** — C4(클램프) 또는 C6(취소)이 범위에 들어올 때, 그리고
  모든 production 배포 후에 필요.

**시간 예산**: 환경 세팅이 끝난 뒤 수동 절차는 ~3분.

> **Playwright 등 자동화 시나리오와 주기적 production health check** 는
> [`ARCHITECTURE.ko.md` §11](./ARCHITECTURE.ko.md#11-v2-백로그) 참고 — 둘
> 다 v2 후보.

---

## 자동 스모크 (`pnpm verify` / `pnpm inspect`)

두 스크립트가 실행 중인 `pnpm dev`에 대해 스모크 흐름을 래핑합니다. 두 번째
터미널에서 실행하세요.

### `pnpm verify` — 자동 3-시나리오 스모크

```bash
# 터미널 1
pnpm dev

# 터미널 2
pnpm verify
```

JSON-RPC를 `/api/mcp`에 직접 보내고 **C1, C2, C5** — 클라이언트에서 단언
가능한 세 시나리오 — 의 PASS/FAIL 보고. PR에 그대로 붙여넣을 수 있는
evidence-record 블록 출력. 1회당 ~$0.0001 (`gpt-4o-mini` 한 번 호출).

입력 (env-only — `verify.mjs`는 플래그를 파싱하지 않음):

| env | 기본값 | 용도 |
|---|---|---|
| `MCP_URL`      | `http://localhost:3000/api/mcp` | 엔드포인트 |
| `VERIFY_MODEL` | `gpt-4o-mini`                   | C2 happy-path 모델 |

`RELAY_AUTH_TOKEN`은 `.env.local`에서 읽음.

C4(클램프)와 C6(취소)는 클라이언트에서 단언할 수 없음 — 이 둘은 아래 수동
5-시나리오로 fall through. Production 측 재검증(§E)도 수동: 이 스크립트는
로컬 전용.

### `pnpm inspect` — 단발 호출

`npx @modelcontextprotocol/inspector --cli`를 래핑하여 Inspector UI 없이
도구 호출 1회를 수행. 프롬프트 반복 작업이나 비-기본 엔드포인트/모델/도구를
가리킬 때 유용.

```bash
pnpm inspect                                  # tools/call → completion_chat ("ping")
pnpm inspect --method=tools/list              # 등록된 도구만
pnpm inspect --message="안녕"                 # 사용자 메시지 커스텀
pnpm inspect --url=http://localhost:3001/api/mcp --model=gpt-4o
pnpm inspect --tool=other_tool --message="..."
```

플래그 (우선순위: `--flag=` > `process.env` > `.env.local` > 기본):

| 플래그 | env | 기본값 |
|---|---|---|
| `--url=`     | `MCP_URL`     | `http://localhost:3000/api/mcp` |
| `--token=`   | `RELAY_AUTH_TOKEN` (`.env.local`에서도 읽음) | — |
| `--tool=`    | `MCP_TOOL`    | `completion_chat` |
| `--model=`   | `MCP_MODEL`   | `gpt-4o-mini` |
| `--message=` | `MCP_MESSAGE` | `ping` |
| `--method=`  | —             | `tools/call` (또는 `tools/list`) |

---

## 수동 절차

`pnpm verify`는 클라이언트에서 단언 가능한 부분(C1, C2, C5)만 커버합니다.
C4(클램프), C6(취소), production 재검증을 위해서는 아래 수동 절차로 fall
through (섹션 A–E).

## A. 준비

1. `.env.local`에 **개인 dev OpenAI 키**(production 키 아님)와 원하는
   `RELAY_AUTH_TOKEN`(32바이트 이상) 채우기:
   ```bash
   OPENAI_API_KEY=sk-...
   RELAY_AUTH_TOKEN=$(openssl rand -hex 32)
   ```
   `.env.local`은 gitignore — 값은 절대 커밋 금지.

2. 개발 서버 시작:
   ```bash
   pnpm dev
   ```
   서버는 `http://localhost:3000`에서 listening. MCP 엔드포인트는
   `http://localhost:3000/api/mcp`.

3. **워밍업** (Inspector 첫 연결이 Next.js의 라우트 JIT 컴파일 때문에
   타임아웃되는 것을 방지):
   ```bash
   curl -i "http://localhost:3000/api/mcp" \
     -H "Authorization: Bearer $RELAY_AUTH_TOKEN" \
     -X GET
   ```
   HTTP 4xx 기대 (mcp-handler가 bare GET에 응답). 5xx만 아니면 함수가
   도달했다는 증거.

---

## B. Inspector 연결

1. 별도 터미널에서 Inspector 시작:
   ```bash
   npx @modelcontextprotocol/inspector
   ```
   Inspector가 stdout에 **Proxy Session Token**을 출력 — 이 터미널을 띄워
   놓을 것.

2. 브라우저가 자동 열림. Inspector UI에서:
   - **Transport**: Streamable HTTP
   - **URL**: `http://localhost:3000/api/mcp`
   - **Header**: `Authorization: Bearer <RELAY_AUTH_TOKEN>` (`.env.local`의
     값을 붙여넣기)
   - **Proxy Session Token**: Inspector 터미널의 토큰을 붙여넣기
     (`CLAUDE.md` §9 — frequently forgotten)

3. **Connect** 클릭. 연결 성공과 **Tools** 탭에 도구 1개
   `completion_chat`이 보이기를 기대.

---

## C. 검증 시나리오

PR 머지 전에 5개 모두 PASS여야 합니다.

| # | 시나리오 | 단계 | 기대 결과 |
|---|---|---|---|
| **C1** | 도구 목록 | Inspector에서 **Tools** 탭으로 전환 | `completion_chat` 1개가 입력 스키마(model, messages, temperature, max_tokens, top_p, stop)와 함께 표시 |
| **C2** | Happy path | `completion_chat`에서 **Run Tool** 클릭. 입력: `model: gpt-4o-mini`, `messages: [{role: "user", content: "ping"}]` | 응답이 `result.content[0].text`에 누적 텍스트 포함. `result.structuredContent.usage.total_tokens > 0`. `result.isError`는 `false`. |
| **C4** | max_tokens 클램프 | C2와 동일하되 `max_tokens: 999999` (`MAX_OUTPUT_TOKENS_CEILING`보다 훨씬 큼) | 응답 성공; 값이 업스트림 호출 전에 `MAX_OUTPUT_TOKENS_CEILING`(기본 4096)로 조용히 클램프됨. 오류 없음. |
| **C5** | Bearer 거부 | Inspector에서 **Disconnect**, Header를 `Authorization: Bearer wrong-token`으로 변경, **Connect** | HTTP 401 + `WWW-Authenticate: Bearer` 헤더로 연결 실패. 올바른 토큰으로 재연결해 계속 진행. |
| **C6** | 취소 (수동) | C2를 긴 프롬프트(예: "Write a 500-word essay about sourdough")로 실행. 스트림 도중 Inspector에서 **Disconnect** | 서버 로그에 SDK 호출 abort 표시; OpenAI usage 페이지(~1분 뒤 새로고침)에 전체 출력 비용이 안 보임. (시각적 확인이 부정확 — 수동 관찰만.) |

---

## D. 증거 기록

절차 완료 후 PR 감사 추적용으로 결과를 기록. 컨벤션은
`$STATE_DIR/manual-mcp-inspector.log`에 작성 (또는 동등한 텍스트를 PR
댓글에 첨부).

**템플릿**:

```
MCP Inspector verification — <YYYY-MM-DD HH:MM TZ>
Verifier:  <이름 / 핸들>
Branch:    <브랜치 이름>
Commit:    <git rev-parse --short HEAD>
Endpoint:  http://localhost:3000/api/mcp  (또는 production URL — doc/DEPLOY.ko.md §3 참고)

C1 tools/list                — PASS / FAIL  <한줄 메모>
C2 completion_chat happy path    — PASS / FAIL  usage: {prompt_tokens: N, completion_tokens: N, total_tokens: N}
C4 max_tokens clamp          — PASS / FAIL  <한줄 메모>
C5 wrong bearer 401          — PASS / FAIL  <한줄 메모>
C6 cancellation              — PASS / FAIL  <한줄 메모>

Notes:
- <플래그할 만한 이상사항>
```

시나리오가 실패하면, PR에 첨부하기 전에 응답 발췌에서 비밀 마스킹
(`OPENAI_API_KEY`, `RELAY_AUTH_TOKEN`, 전체 프롬프트 본문 — 메타데이터만,
`CLAUDE.md` §4에 따라).

---

## E. Production 배포 후

[`doc/DEPLOY.ko.md` §3.5 검증 체크리스트](./DEPLOY.ko.md#35-검증-체크리스트)
실행 후, **C1, C2, C5**를 production URL
(`https://<project>.vercel.app/api/mcp`)에 대해 **production**
`RELAY_AUTH_TOKEN`과 prod에 발급된 `OPENAI_API_KEY`로 재실행.

C4와 C6은 로컬 전용 (클램프 동작은 두 환경 모두 동일하고, 취소 관찰은
production에서 확인하기 어려움).

---

## F. 비-목표

- **자동 Inspector 시나리오** (Inspector를 spawning하는 Playwright) — v2
  후보; v1은 수동 루프 유지 — Inspector 자체가 디버깅 UI이지 CI surface가
  아님.
- **주기적 production health check** (cron / 모니터링) — v2 후보
  (observability의 일부 — [`ARCHITECTURE.ko.md` §11](./ARCHITECTURE.ko.md#11-v2-백로그)
  참고).
- **호출 단위 사용량 단언** — Inspector는 호출별 `usage`를 보여주지만 절차
  자체는 특정 토큰 카운트를 강제하지 않음 (모델 동작이 가변).

---

## 참고

- [`ARCHITECTURE.ko.md` §10](./ARCHITECTURE.ko.md#10-테스트-전략-v1) — 테스트 전략 (수동 E2E 레이어)
- [`CLAUDE.md` §3](../CLAUDE.md#3-verify-commands) — 증거 정책 (`evidence-mode: none`)
- [`CLAUDE.md` §7](../CLAUDE.md#7-testing--what-goes-where) — 테스트 매트릭스 (마지막 행이 이 절차)
- [`CLAUDE.md` §9](../CLAUDE.md#9-frequently-forgotten-items) — Proxy Session Token
- [`doc/DEPLOY.ko.md` §3](./DEPLOY.ko.md#3-vercel-배포) — Vercel 배포 (이 절차는 §3.5에서 참조됨)
- [`doc/DEPLOY.ko.md` §4](./DEPLOY.ko.md#4-docker-셀프-호스팅) — Docker 배포 (스모크는 `pnpm inspect` 사용)
