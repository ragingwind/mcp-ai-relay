# DEPLOY — mcp-ai-relay

> English: [DEPLOY.md](./DEPLOY.md)

이 런북은 v1 배포의 두 가지 경로를 다룹니다: **Vercel** (관리형 서버리스)
과 **Docker** (셀프 호스팅 컨테이너). 아키텍처 결정은
[`ARCHITECTURE.ko.md`](./ARCHITECTURE.ko.md) (§6 `vercel.json`, §7 환경변수,
§9 보안)에 있습니다. 코딩 규칙은 [`../CLAUDE.md`](../CLAUDE.md)에 있습니다.

---

## 1. 사전 준비물

공통:
- OpenAI (또는 OpenAI 호환) API 키.
- 32바이트 이상 Bearer 토큰: `openssl rand -hex 32`.
- 저장소 클론: `git clone https://github.com/ragingwind/mcp-ai-relay.git`.

**Vercel용**:
- Vercel 계정 (Pro 플랜 권장 — `maxDuration: 300`에 필요).
- OpenAI 프로젝트 2개 (Production + Preview), 각자의 키 보유. 두 프로젝트로
  분리하면 Preview 키 유출이 production 빌링에 영향을 주지 않습니다.
- Vercel CLI: `npm i -g vercel` (또는 `pnpm dlx vercel ...`).

**Docker용**:
- Docker `^24` (Compose v2 플러그인 기본 포함).
- 외부 노출 시 reverse proxy / load balancer (TLS와 long-running 요청
  타임아웃 처리).

**Embed via SDK** (자기 MCP 서버 — Cloudflare Workers, Claude Desktop
직결 stdio, Hono, Express 등 — 안에 기능을 임베드):
- `npm install @ragingwind/ai-relay @modelcontextprotocol/sdk openai`.
- 전체 API + 런타임별 레시피 (Vercel/Next.js, stdio, Cloudflare
  Workers, 다중 업스트림): [`packages/ai-relay/README.md`](../packages/ai-relay/README.md) (영문).
- 아래 운영 절차 (회전 + 트러블슈팅)는 env 레벨에서 그대로 적용 — 배포
  표면은 자기 MCP 서버가 ship 하는 곳.

---

## 2. OpenAI hard usage cap (필수)

**v1에는 rate limiting이나 budget 카운터가 없습니다.** OpenAI hard usage
cap이 `RELAY_AUTH_TOKEN`이 유출됐을 때의 유일한 방어선입니다. Vercel이든
Docker든 릴레이를 외부에 노출하기 전에 반드시 설정하세요.

각 OpenAI 프로젝트 키에 대해:

1. [OpenAI 대시보드 → Settings → Billing → Limits](https://platform.openai.com/account/limits) 열기.
2. 좌상단 selector에서 프로젝트 전환.
3. **Hard limit**을 월 한도로 설정 (예: Preview에는 `$10`).
4. **Soft limit**을 더 낮게 (예: hard의 50%) — 조기 경보 이메일 트리거.

v2에서 릴레이 자체에 rate limiting을 추가하는 계획은
[`ARCHITECTURE.ko.md` §11](./ARCHITECTURE.ko.md#11-v2-백로그)에 있습니다.

---

## 3. Vercel 배포

### 3.1 프로젝트 연결

```bash
vercel link
```

처음에는 **Create new project**, 이후에는 기존 프로젝트 선택.
`vercel link`는 `.vercel/project.json`을 생성 — `.vercel/`이 gitignore에
있는지 확인.

### 3.2 런타임 설정 확인

`vercel.json`은 이미 다음을 고정:

```json
{
  "regions": ["iad1"],
  "functions": { "app/api/**/route.ts": { "maxDuration": 300 } }
}
```

Node 버전은 `package.json`의 `engines.node`(`>=20.0.0 <21.0.0`)로 선택.
라우트도 `runtime = "nodejs"`와 `maxDuration = 300`을 export — 이중
방어용.

배포 후 Vercel 대시보드에서 확인:
- **Settings → General → Node.js Version**: 20.x
- **Functions** 탭: `app/api/[transport]/route.ts`이 `nodejs20.x`,
  `Max Duration: 300s`로 표시
- **Settings → Functions → Region**: iad1
- **Settings → Fluid Compute**: enabled (Pro 기본)

### 3.3 Sensitive 환경변수 등록

**Production과 Preview 두 환경 모두**에 모든 키를 등록. **Sensitive**
플래그 사용 — Vercel은 생성 후 값을 다시 읽을 수 없게 만듭니다 (감사
친화적; 회전은 교체 방식).

| 키 | 필수 | Production | Preview | Sensitive |
|---|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | 업스트림 키 #1 | 업스트림 키 #2 (다른 프로젝트) | ✅ |
| `RELAY_AUTH_TOKEN` | ✅ | 32바이트 이상 random | 32바이트 이상 random (다른 값) | ✅ |
| `OPENAI_BASE_URL` | ❌ | (OpenAI 기본은 생략) | 동일하거나 staging URL | — |
| `MAX_OUTPUT_TOKENS_CEILING` | ❌ | `4096` | `4096` | — |
| `REQUEST_TIMEOUT_MS` | ❌ | `60000` | `60000` | — |

```bash
# Production 비밀
vercel env add OPENAI_API_KEY production --sensitive
vercel env add RELAY_AUTH_TOKEN production --sensitive

# Preview 비밀 (다른 OpenAI 키 + 다른 릴레이 토큰)
vercel env add OPENAI_API_KEY preview --sensitive
vercel env add RELAY_AUTH_TOKEN preview --sensitive

# 선택적 plain 환경변수
vercel env add OPENAI_BASE_URL production    # OpenAI 외 업스트림을 가리킬 때만
vercel env add MAX_OUTPUT_TOKENS_CEILING production
vercel env add REQUEST_TIMEOUT_MS production
```

`vercel env ls`로 확인. Sensitive 플래그는 `Encrypted`로 표시됩니다.

> **Preview 배포는 자동 잠금**. Vercel은 기본적으로 Preview에 Vercel
> Authentication을 적용 — 팀 멤버만 preview URL 접근 가능.
> **Settings → Deployment Protection**에서 확인.

### 3.4 첫 배포

```bash
vercel deploy --prod
```

Vercel이 production URL(`https://<your-project>.vercel.app`) 반환. MCP
엔드포인트는 `/api/mcp`.

### 3.5 검증 체크리스트

- [ ] `vercel deploy --prod` 가 오류 없이 완료.
- [ ] Vercel 대시보드 → **Functions** 에 `app/api/[transport]/route.ts`이
      `nodejs20.x`, region `iad1`, `Max Duration: 300s`로 표시.
- [ ] 스모크 테스트:
      ```bash
      curl -i https://<your-project>.vercel.app/api/mcp \
        -H "Authorization: Bearer $RELAY_AUTH_TOKEN" -X GET
      ```
      HTTP 4xx 기대 (mcp-handler가 bare GET에 응답) — 5xx만 아니면 함수가
      도달했다는 증거. 401이면 bearer가 잘못됨.
- [ ] [`QA-MCP-INSPECTOR.ko.md`](./QA-MCP-INSPECTOR.ko.md)의 수동 절차
      실행. 운영 환경 재검증은 §E에서 (C1, C2, C5 서브셋).
- [ ] OpenAI 대시보드 → **Usage** 에 prod 프로젝트 호출이 기록됨 (올바른
      키가 연결됐다는 증거).

---

## 4. Docker (셀프 호스팅)

릴레이는 저장소 루트에 multi-stage `Dockerfile`을 제공합니다.
`node:20-alpine`(공급망 안정성을 위해 digest pin)을 베이스로 ~70 MB 런타임
이미지를 생성하고, 비-root 사용자(UID 1001)로 실행하며, `/api/mcp`에 대한
Node `fetch` HEALTHCHECK를 포함합니다.

> **베이스 이미지 pin.** `Dockerfile`은 floating
> `node:20-alpine` 태그가 아니라 `node:20-alpine@sha256:...`을 참조합니다.
> digest 갱신은 의도적으로
> (`docker pull node:20-alpine && docker inspect node:20-alpine --format
> '{{.RepoDigests}}'`) — 절대 unpin하지 마세요.

> **타임아웃은 운영자 책임.** Vercel의 300초 함수 타임아웃에 해당하는 게
> 없습니다. reverse proxy / load balancer가 long-running 요청을
> 허용하도록 설정하세요. Vercel과 동등하게 가려면 300초가 합리적인
> 시작값입니다.

### 4.1 Compose (권장)

```bash
cp .env.example .env.local         # OPENAI_API_KEY + RELAY_AUTH_TOKEN 채우기
docker compose up -d               # 첫 실행 시 빌드 후 시작
```

`http://localhost:8787/api/mcp`에서 도달 가능. `restart: unless-stopped`로
재부팅 후에도 계속 실행.

**호스트 포트 오버라이드.** 기본 `8787`은 Cloudflare Wrangler의 remote-MCP
예제와 일치하며, 흔한 Next.js / Node `:3000` 충돌을 피합니다. 다른 포트를
쓰려면:

```bash
HOST_PORT=9876 docker compose up -d   # → http://localhost:9876/api/mcp
```

컨테이너 내부에서는 항상 `3000` 리스닝 — 호스트 측 매핑만 바뀝니다.

**라이프사이클:**

```bash
docker compose up -d                  # 빌드 + 시작 (detached)
docker compose ps                     # 상태 + health
docker compose logs -f relay          # 로그 follow
docker compose down                   # 중지 + 제거
docker compose up -d --build          # Dockerfile / 소스 변경 후 rebuild
```

`compose.yml`은 `env_file:`로 `.env.local`을 읽어 모든 키를 컨테이너의
process env로 전달. raw `docker run`과 동일한 환경변수 계약 (§4.2).

> Compose는 production 런북을 대체하지 않습니다. 다중 호스트 또는 관리형
> 오케스트레이션은 Kubernetes / PaaS를 사용 — `compose.yml`은 단일 호스트
> 셀프 호스팅과 로컬 개발용입니다.

### 4.2 Raw `docker run`

빌드:

```bash
docker build -t mcp-ai-relay .
```

최종 이미지 크기는 200 MB 미만이 정상. 빌드는 실제 비밀이 필요 없습니다 —
`pnpm build`가 빌드 타임 더미 값을 주입.

inline `-e` 플래그로 실행:

```bash
docker run --rm -p 8787:3000 \
  -e OPENAI_API_KEY=sk-... \
  -e RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e OPENAI_BASE_URL=https://your-gateway.example.com/v1 \
  -e MAX_OUTPUT_TOKENS_CEILING=4096 \
  -e REQUEST_TIMEOUT_MS=60000 \
  mcp-ai-relay
```

또는 `--env-file`:

```bash
docker run --rm -p 8787:3000 --env-file .env.production mcp-ai-relay
```

`OPENAI_API_KEY`와 `RELAY_AUTH_TOKEN`은 필수. `OPENAI_BASE_URL`,
`MAX_OUTPUT_TOKENS_CEILING`, `REQUEST_TIMEOUT_MS`는 선택 (기본값은
[`ARCHITECTURE.ko.md` §7](./ARCHITECTURE.ko.md#7-환경변수) 참고).

### 4.3 검증 체크리스트

HEALTHCHECK:

```bash
docker inspect --format '{{.State.Health.Status}}' <container>
```

시작 후 ~30초 내에 `healthy` 기대. 체크는 `GET /api/mcp`를 보내고 5xx가
아닌 응답이면 healthy로 처리 (mcp-handler가 bare GET에 405 반환 — 함수
도달 증거).

스모크 테스트 (기본 포트 8787에서 컨테이너 실행 중일 때):

```bash
pnpm inspect --url=http://localhost:8787/api/mcp --method=tools/list
```

도구 1개 `completion_chat` 기대. PR 전 전체 절차(C1–C6)는
[`QA-MCP-INSPECTOR.ko.md`](./QA-MCP-INSPECTOR.ko.md) 참고.

### 4.4 비밀이 이미지에 박혀 있지 않은지 확인

```bash
docker history mcp-ai-relay --no-trunc | grep -iE 'OPENAI_API_KEY|RELAY_AUTH_TOKEN'
```

`pnpm build`의 더미 값(`build-dummy`, 32×`x`)만 보여야 함 — 실제 자격증명
절대 금지.

---

## 5. 운영

### 5.1 `RELAY_AUTH_TOKEN` 회전

다음 상황에서 실행:
- 토큰 유출 의심.
- 토큰 접근 권한이 있던 팀원이 떠남.
- 정기 회전 (90일 권장).

**Vercel:**

```bash
openssl rand -hex 32                          # 생성
vercel env rm RELAY_AUTH_TOKEN production     # 교체
vercel env add RELAY_AUTH_TOKEN production --sensitive
vercel deploy --prod                          # 적용
```

**Docker:**

1. 새 토큰 생성: `openssl rand -hex 32`.
2. `.env.local` (또는 비밀 매니저) 업데이트.
3. `docker compose up -d --force-recreate` (또는 컨테이너 재시작).

이후 공통:

4. 모든 MCP 클라이언트(Claude Code, Claude Desktop Connectors,
   `.mcp.json` 파일들)의 bearer 토큰 갱신.
5. `pnpm inspect` 또는 MCP Inspector로 새 토큰이 동작하고 옛 토큰이 동작
   **하지 않는지** 확인.
6. 유출 의심 구간 동안의 OpenAI 대시보드 사용량에 이상이 없는지 감사.

> **Vercel: Preview 토큰을 회전한다면 절차를 한 번 더 반복**. Production과
> Preview는 독립된 토큰입니다.

### 5.2 `OPENAI_API_KEY` 회전

§5.1과 동일 (교체 + redeploy / restart). 추가로:

1. **OpenAI 대시보드에서 옛 키 revoke** (그러지 않으면 계속 유효).
2. **새 키에 hard usage cap이 여전히 설정되어 있는지 확인** (cap은
   키별이 아니라 프로젝트별이지만, 새 키가 다른 프로젝트라면 다시 확인).
3. 검증 체크리스트 재실행 (Vercel은 §3.5, Docker는 §4.3).

### 5.3 트러블슈팅

| 증상 | 추정 원인 | 조치 |
|---|---|---|
| 로컬에서 `pnpm build` 실패: `Invalid environment: ...` | 모듈 레벨 `parseEnv(process.env)` 평가; 빌드 타임에 환경변수 누락 | `package.json`의 `build` 스크립트가 `OPENAI_API_KEY`/`RELAY_AUTH_TOKEN`에 더미 값을 주입 — 복원하거나 `.env.local`에 실제 값 설정. |
| Vercel 빌드가 같은 환경변수 오류로 실패 | CI/Vercel에서 동일 문제 | 등록된 키는 빌드 타임에 Vercel이 주입 — `vercel env ls`로 확인. |
| `curl`이 401 + `WWW-Authenticate: Bearer` 반환 | Bearer 토큰 누락 또는 오류 | 클라이언트 헤더와 `RELAY_AUTH_TOKEN` 비교. |
| `tools/call`이 `isError: true, code: "auth"` 반환 | `OPENAI_API_KEY`가 잘못됨 | OpenAI 대시보드에서 키 검증. |
| `tools/call`이 `code: "rate_limited"`, `retryAfter` 반환 | OpenAI rate limit | `retryAfter`초 대기. v2에서 릴레이 측 rate limiting 추가 예정. |
| `maxDuration` 초과 (504 / function timeout) | 긴 생성 또는 tool call에서 멈춤 | `vercel.json`과 라우트 레벨 `maxDuration: 300`이 모두 설정됐는지 확인. Pro 플랜 한도는 300s. |
| Docker 컨테이너가 `unhealthy` 보고 | HEALTHCHECK가 `/api/mcp`에 도달 못함 | 로그 점검: `docker compose logs relay`. 가장 흔한 원인은 필수 환경변수 누락 — 시작 단계에서 fail-fast. |
| OpenAI 대시보드가 잘못된 프로젝트에 사용량 표시 | Preview의 `OPENAI_API_KEY`가 Production에 흘러들어감 (혹은 반대) | §3.3을 신중히 재실행 — 키는 반드시 다른 OpenAI 프로젝트에서 와야 함. |

---

## 6. 비-목표 (v1)

다음은 v1이 아니므로 의도적으로 이 런북에 포함하지 않습니다 (v2 백로그는
[`ARCHITECTURE.ko.md` §11](./ARCHITECTURE.ko.md#11-v2-백로그)):

- Rate limiting (Upstash 등)
- 일별 토큰 / 달러 budget 카운터
- OAuth 2.1
- Sentry / OTel / Axiom observability
- Preview 배포 댓글 봇
- Canary / blue-green 배포
- Kubernetes / Helm 차트
