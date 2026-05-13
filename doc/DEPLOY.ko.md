# DEPLOY — mcp-ai-relay

> English: [DEPLOY.md](./DEPLOY.md)

이 런북은 v1 배포를 다룹니다. 정본 표면은 **Docker**
(`ghcr.io/ragingwind/ai-relay`, 멀티 아키텍처 amd64/arm64) 입니다.
**Vercel** 레시피는 [`examples/vercel/`](../examples/vercel/) 에 있으며
커뮤니티가 지원합니다(이 경로에 대한 first-party CI는 없음). 아키텍처
결정은 [`ARCHITECTURE.ko.md`](./ARCHITECTURE.ko.md) (§5 디렉터리,
§6 컨테이너 릴리스, §7 환경변수, §9 보안)에 있습니다. 코딩 규칙은
[`../CLAUDE.md`](../CLAUDE.md)에 있습니다.

---

## 1. 사전 준비물

공통:
- OpenAI (또는 OpenAI 호환) API 키.
- 32바이트 이상 Bearer 토큰: `openssl rand -hex 32`.
- 저장소 클론: `git clone https://github.com/ragingwind/mcp-ai-relay.git`.

**Docker용** (canonical):
- Docker `^24` (Compose v2 플러그인 기본 포함).
- 외부 노출 시 reverse proxy / load balancer (TLS와 long-running 요청
  타임아웃 처리).
- 다중 키 격리: 환경별로 분리된 OpenAI 프로젝트(Production + Staging)와
  §2의 hard usage cap 설정.

**Vercel용** (커뮤니티 지원, [`examples/vercel/README.md`](../examples/vercel/README.md) 참고):
- Vercel 계정 (Pro 플랜 권장 — `maxDuration: 300`에 필요).
- npm의 `ai-relay`를 소비하는 별도 Next.js 프로젝트 — 이 저장소는 Next.js
  앱이 아님.
- OpenAI 프로젝트 2개 (Production + Preview), 각자의 키 보유.
- Vercel CLI: `npm i -g vercel` (또는 `pnpm dlx vercel ...`).

**Embed via SDK** (자기 MCP 서버 — Cloudflare Workers, Claude Desktop
직결 stdio, Hono, Express 등 — 안에 기능을 임베드):
- `npm install ai-relay @modelcontextprotocol/sdk openai`.
- 전체 API + 런타임별 레시피 (Vercel/Next.js, stdio, Cloudflare
  Workers, 다중 업스트림): [`packages/ai-relay/README.md`](../packages/ai-relay/README.md) (영문).
- 아래 운영 절차 (회전 + 트러블슈팅)는 env 레벨에서 그대로 적용 — 배포
  표면은 자기 MCP 서버가 ship 하는 곳.

---

## 2. OpenAI hard usage cap (필수)

**v1에는 rate limiting이나 budget 카운터가 없습니다.** OpenAI hard usage
cap이 `AI_RELAY_AUTH_TOKEN`이 유출됐을 때의 유일한 방어선입니다. Docker든
Vercel이든 릴레이를 외부에 노출하기 전에 반드시 설정하세요.

각 OpenAI 프로젝트 키에 대해:

1. [OpenAI 대시보드 → Settings → Billing → Limits](https://platform.openai.com/account/limits) 열기.
2. 좌상단 selector에서 프로젝트 전환.
3. **Hard limit**을 월 한도로 설정 (예: Preview에는 `$10`).
4. **Soft limit**을 더 낮게 (예: hard의 50%) — 조기 경보 이메일 트리거.

v2에서 릴레이 자체에 rate limiting을 추가하는 계획은
[`ARCHITECTURE.ko.md` §11](./ARCHITECTURE.ko.md#11-v2-백로그)에 있습니다.

---

## 3. Docker (canonical)

정본 산출물은 멀티 아키텍처 Docker 이미지
`ghcr.io/ragingwind/ai-relay` (amd64 + arm64) 이며,
[`.github/workflows/release-app.yml`](../.github/workflows/release-app.yml)
이 매 `v*` 태그마다 빌드해 푸시합니다.

이미지는 `node:20-alpine` 런타임(공급망 안정성을 위해 digest pin)이며,
Hono 서버를 비-root 사용자(UID 1001)로 실행하고, `/healthz`에 대한 Node
`fetch` HEALTHCHECK를 포함합니다.

> **타임아웃은 운영자 책임.** reverse proxy / load balancer가
> long-running 요청을 허용하도록 설정하세요. 300초가 합리적인 시작값
> (Vercel 함수 한도와 동등성을 맞추는 값).

### 3.1 첫 ghcr 설정 (메인테이너, 1회)

포크를 클론하거나 워크플로를 새 저장소로 이식한 직후:

1. **Settings → Actions → General → Workflow permissions**: "Read and
   write permissions" + "Allow GitHub Actions to create and approve
   pull requests" 선택.
2. 첫 태그 컷 — 예: `git tag v0.2.0-rc.0 && git push --tags`.
3. `release-app` 워크플로 실행; **Actions → release-app** 에서 확인.
4. 첫 푸시가 들어가면 **Settings → Packages → ai-relay** 가 나타남;
   익명 `docker pull` 을 허용하려면 visibility 를 **Public** 으로 변경.
   기본은 Private (조직 멤버만).

### 3.2 Compose (권장)

```bash
cp .env.example .env.local         # AI_RELAY_API_KEY + AI_RELAY_AUTH_TOKEN 채우기
docker compose up -d               # ghcr 이미지 pull + 시작
```

릴레이는 `http://localhost:8787/api/mcp` 에서 도달 가능. liveness 엔드포인트는
`http://localhost:8787/healthz`. `restart: unless-stopped` 로 재부팅 후에도
계속 실행.

**호스트 포트 오버라이드:**

```bash
HOST_PORT=9876 docker compose up -d   # → http://localhost:9876/api/mcp
```

컨테이너는 내부적으로 항상 `8787` 리스닝 (`AI_RELAY_PORT` 기본값과 일치)
— 호스트 측 매핑만 바뀝니다.

**로컬 빌드 경로 (개발):**

```bash
docker compose -f compose.dev.yml up --build
```

저장소의 `app/Dockerfile`을 사용. 서버를 로컬에서 반복 작업할 때 유용;
production 사용자는 발행된 이미지를 pull 해야 합니다.

**라이프사이클:**

```bash
docker compose up -d                  # pull + 시작 (detached)
docker compose ps                     # 상태 + health
docker compose logs -f relay          # 로그 follow
docker compose down                   # 중지 + 제거
docker compose pull && docker compose up -d   # 최신 태그로 업데이트
```

`compose.yml`은 `env_file:`로 `.env.local`을 읽어 모든 키를 컨테이너의
process env로 전달. raw `docker run`과 동일한 환경변수 계약 (§3.3).

> Compose는 production 런북을 대체하지 않습니다. 다중 호스트 또는 관리형
> 오케스트레이션은 Kubernetes / PaaS를 사용 — `compose.yml`은 단일 호스트
> 셀프 호스팅과 로컬 개발용입니다.

### 3.3 Raw `docker run`

```bash
docker run --rm -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e AI_RELAY_MODEL=gpt-4o-mini \
  -e AI_RELAY_BASE_URL=https://your-gateway.example.com/v1 \
  -e AI_RELAY_TEMPERATURE=0.7 \
  -e AI_RELAY_MAX_TOKENS=4096 \
  -e AI_RELAY_REQUEST_TIMEOUT_MS=60000 \
  ghcr.io/ragingwind/ai-relay:latest
```

또는 `--env-file`:

```bash
docker run --rm -p 8787:8787 --env-file .env.production ghcr.io/ragingwind/ai-relay:latest
```

`AI_RELAY_API_KEY`, `AI_RELAY_AUTH_TOKEN`, `AI_RELAY_MODEL` 은 필수. 나머지
키 (`AI_RELAY_PORT`, `AI_RELAY_TEMPERATURE`, `AI_RELAY_TOP_P`, `AI_RELAY_STOP`
포함)는 선택 — 기본값은 [`ARCHITECTURE.ko.md` §7](./ARCHITECTURE.ko.md#7-환경변수)
참고.

> 호출자 측 MCP 도구 입력은 `model` / sampling 파라미터를 받지 않습니다.
> 위의 `AI_RELAY_*` env 변수로 서버 인스턴스 단위로 구성하세요.
> `AI_RELAY_MAX_TOKENS` 는 매 업스트림 호출에 그대로 전달됩니다.

### 3.4 검증 체크리스트

**배포 전에 `pnpm docker:smoke`를 실행해** 빌드 정합성, 런타임 헬스,
distroless 불변 조건(셸 없음, non-root uid 65532), 이미지 크기 예산을
확인합니다. 회귀가 발생하면 하네스가 non-zero 종료 — 어설션 카탈로그와
환경변수(이미지 태그, 크기 예산, 멀티아치 opt-in)는
[`app/scripts/README.md`](../app/scripts/README.md) 참고.

- [ ] `docker compose up -d` (또는 `docker run`) 가 오류 없이 시작.
- [ ] HEALTHCHECK 가 시작 후 ~30초 이내 healthy 보고:
      ```bash
      docker inspect --format '{{.State.Health.Status}}' <container>
      ```
      체크는 `GET /healthz` 를 보내고 `200 ok` 면 0 으로 종료.
- [ ] Liveness:
      ```bash
      curl -i http://localhost:8787/healthz
      ```
      `HTTP/1.1 200 OK` + 본문 `ok` 기대.
- [ ] Bearer 필수:
      ```bash
      curl -i http://localhost:8787/api/mcp
      ```
      `HTTP/1.1 401` + `WWW-Authenticate: Bearer ...` 헤더 기대.
- [ ] 도구 목록:
      ```bash
      pnpm inspect --url=http://localhost:8787/api/mcp --method=tools/list
      ```
      도구 1개 `chat-completions` 기대. PR 전 전체 절차(C1–C6)는
      [`QA-MCP-INSPECTOR.ko.md`](./QA-MCP-INSPECTOR.ko.md) 참고.
- [ ] OpenAI 대시보드 → **Usage** 에 prod 프로젝트 호출이 기록됨 (올바른
      키가 연결됐다는 증거).

### 3.5 비밀이 이미지에 박혀 있지 않은지 확인

```bash
docker history ghcr.io/ragingwind/ai-relay:latest --no-trunc \
  | grep -iE 'AI_RELAY_API_KEY|AI_RELAY_AUTH_TOKEN'
```

아무것도 안 나와야 함 — 이미지 빌드는 실제 자격증명을 절대 읽지 않고,
런타임 값은 `env_file` / `-e` 로만 주입됩니다.

---

## 4. Vercel (커뮤니티 지원)

이 저장소는 Next.js 앱이 아닙니다. Vercel에 배포하려면 npm의
`ai-relay`를 소비하는 얇은 Next.js 프로젝트를 만드세요. 레시피는
[`examples/vercel/README.md`](../examples/vercel/README.md) 에 있습니다 —
해당 디렉터리의 `vercel.json` 을 자기 프로젝트로 복사하고 README의 템플릿
라우트 핸들러를 따르세요.

Vercel 타깃은 이 저장소의 CI나 릴리스 파이프라인에서 다루지 않습니다.
참조용 배포로 간주하세요.

---

## 5. 운영

### 5.1 `AI_RELAY_AUTH_TOKEN` 회전

다음 상황에서 실행:
- 토큰 유출 의심.
- 토큰 접근 권한이 있던 팀원이 떠남.
- 정기 회전 (90일 권장).

**Docker:**

1. 새 토큰 생성: `openssl rand -hex 32`.
2. `.env.local` (또는 비밀 매니저) 업데이트.
3. `docker compose up -d --force-recreate` (또는 컨테이너 재시작).

**Vercel (커뮤니티 레시피):**

```bash
openssl rand -hex 32                              # 생성
vercel env rm AI_RELAY_AUTH_TOKEN production      # 교체
vercel env add AI_RELAY_AUTH_TOKEN production --sensitive
vercel deploy --prod                              # 적용
```

이후 공통:

4. 모든 MCP 클라이언트(Claude Code, Claude Desktop Connectors,
   `.mcp.json` 파일들)의 bearer 토큰 갱신.
5. `pnpm inspect` 또는 MCP Inspector로 새 토큰이 동작하고 옛 토큰이 동작
   **하지 않는지** 확인.
6. 유출 의심 구간 동안의 OpenAI 대시보드 사용량에 이상이 없는지 감사.

> **Vercel: Preview 토큰을 회전한다면 절차를 한 번 더 반복**. Production과
> Preview는 독립된 토큰입니다.

### 5.2 `AI_RELAY_API_KEY` 회전

§5.1과 동일 (교체 + redeploy / restart). 추가로:

1. **OpenAI 대시보드에서 옛 키 revoke** (그러지 않으면 계속 유효).
2. **새 키에 hard usage cap이 여전히 설정되어 있는지 확인** (cap은
   키별).
3. 검증 체크리스트 재실행 (Docker는 §3.4; Vercel 레시피의 체크리스트는
   `examples/vercel/README.md` 안에 있음).

### 5.3 트러블슈팅

| 증상 | 추정 원인 | 조치 |
|---|---|---|
| `pnpm dev`가 `Invalid environment: ...` 로 실패 | `parseEnv(process.env)` 가 env 를 거절; 인증 토큰 누락 또는 짧음 | `.env.local` 에 `AI_RELAY_API_KEY` 와 32바이트 `AI_RELAY_AUTH_TOKEN` 둘 다 있는지 확인. |
| 컨테이너가 시작 즉시 종료 | 위와 동일 (이미지 내부) | `docker compose logs relay` — env 오류 메시지가 실패 키를 명시 (값은 노출하지 않음). |
| `curl`이 401 + `WWW-Authenticate: Bearer` 반환 | Bearer 토큰 누락 또는 오류 | 클라이언트 헤더와 `AI_RELAY_AUTH_TOKEN` 비교. |
| `tools/call`이 `isError: true, code: "auth"` 반환 | `AI_RELAY_API_KEY`가 잘못됨 | OpenAI 대시보드에서 키 검증. |
| `tools/call`이 `code: "rate_limited"`, `retryAfter` 반환 | OpenAI rate limit | `retryAfter`초 대기. v2에서 릴레이 측 rate limiting 추가 예정. |
| 긴 요청이 업스트림 프록시에서 끊김 (504) | reverse proxy 타임아웃이 모델 응답 시간보다 짧음 | 프록시의 read/idle 타임아웃을 올리기 — 300초가 Vercel 최대 함수 시간과 동등성 타깃. |
| Docker 컨테이너가 `unhealthy` 보고 | HEALTHCHECK가 `/healthz`에 도달 못함 | 로그 점검: `docker compose logs relay`. 가장 흔한 원인은 필수 환경변수 누락 — 시작 단계에서 fail-fast. |
| `docker pull`이 `denied` 반환 | ghcr 패키지가 private 이고 인증되지 않음 | `docker login ghcr.io -u <user>` 를 PAT (`read:packages` scope) 와 함께 실행, 또는 메인테이너가 Settings → Packages → ai-relay → Public 으로 전환. |
| OpenAI 대시보드가 잘못된 프로젝트에 사용량 표시 | 한 환경의 `AI_RELAY_API_KEY` 가 다른 환경으로 흘러들어감 | 환경별로 분리된 OpenAI 프로젝트 키를 사용 (Production / Staging / Preview). |

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
