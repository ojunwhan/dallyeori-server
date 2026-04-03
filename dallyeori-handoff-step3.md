# 달려오리 — 3단계 핸드오프 (새 대화창용)

---

## 인프라 변경 (2026-04-03) — 반영됨

### 도메인
- **dallyeori.com** — Cloudflare Registrar, DNS A `@` / `www` → `43.201.103.166` (**Proxied**)
- **SSL:** Cloudflare **Flexible** (브라우저↔CF HTTPS, CF↔오리진 HTTP)
- **duck.lingora.chat** — 유지 (백도어·개발용 접근)

### 클라이언트
- GitHub: `https://github.com/ojunwhan/dallyeori.git`
- 빌드: 로컬 `npm run build` → 레포에 `dist` 포함 또는 서버에서 pull 후 빌드
- **정적 파일 배포 경로 (STAGING nginx root):** `/var/www/dallyeori/`  
  (`/home/ubuntu/dallyeori-client` 아님 — www-data 권한)

### nginx
- 파일: `/etc/nginx/sites-available/duck.lingora.chat` (이름은 기존 유지 가능)
- `server_name duck.lingora.chat dallyeori.com www.dallyeori.com;`
- `root /var/www/dallyeori;`
- 레포 템플릿: `dallyeori-server/deploy/nginx-dallyeori-frontend.conf`

### 서버 `.env` (값은 서버·콘솔에서만 관리, 레포에 시크릿 커밋 금지)
- `CLIENT_ORIGIN=https://dallyeori.com,https://duck.lingora.chat` — **콤마 구분** CORS (코드 반영됨)
- Google: **DALLYEORI 전용** OAuth 클라이언트 (MONO와 분리). 콘솔에 JS 원본·리디렉션 URI를 **dallyeori.com + duck.lingora.chat** 각각 등록
- 카카오: 기존 앱에 `https://dallyeori.com/api/auth/kakao/callback` 등 필요 URI 추가
- **리디렉트 URI:** 런타임에 `X-Forwarded-Proto` + `Host`로 조합 (`src/auth/oauthOrigin.js`). 콘솔 등록만 맞추면 됨.

### 클라이언트 `.env.production`
- `VITE_API_BASE_URL`, `VITE_SOCKET_URL` — **빈 값 유지** (동일 출처)

### 배포 (서버 예시)
```bash
cd ~/dallyeori   # 클라이언트 클론 경로
git pull
npm ci
npm run build
sudo cp -r dist/* /var/www/dallyeori/
```

---

## 완료 상태 요약

### ✅ 1단계 완료
- OAuth 인증 실연동 (구글 + 카카오)
- dallyeori-server (Node.js + Socket.IO, 포트 3100)
- 실시간 1v1 매칭, 서버 권위 모델
- slot 0/1 양쪽 조종 + 결과 동기화

### ✅ 2-A 완료: MONO 번역 실연동
- MONO server.js에 POST /api/translate 엔드포인트
- GPT-4o, tone(casual/formal), 99개 언어
- AWS PROD 배포 완료 (https://lingora.chat/api/translate)

### ✅ 2-B 완료: AWS STAGING 배포
- dallyeori-server가 STAGING에서 동작 중
- 공개 도메인: **https://dallyeori.com** (및 duck.lingora.chat)

### ⬜ 아직 모킹인 것
- db.js 전체 (전적, 하트, 친구, 채팅, 랭킹) — localStorage 모킹
- 재대전 (startMockRematchRequest) — Socket.IO 실재대전 아직
- IAP, 푸시 알림

---

## AWS STAGING 환경 (확정)

| 항목 | 값 |
|------|-----|
| 인스턴스 | Ubuntu-staging (Lightsail) |
| 퍼블릭 IP | 43.201.103.166 |
| 공식 도메인 | **dallyeori.com**, **www.dallyeori.com** |
| 보조 도메인 | **duck.lingora.chat** |
| SSH | Lightsail 콘솔 등 |
| OS | Ubuntu 24.04.x |
| Node | v20.x |
| Cloudflare | Registrar + Proxy, SSL Flexible |

### PM2 프로세스
| name | port | 비고 |
|------|------|------|
| mono | 3174 | MONO — **절대 건드리지 마** |
| dallyeori | 3100 | 달려오리 게임 서버 |

### 코드 위치
- 서버: `/home/ubuntu/dallyeori-server/`
- GitHub 서버: `https://github.com/ojunwhan/dallyeori-server.git`
- GitHub 클라이언트: `https://github.com/ojunwhan/dallyeori.git`

### .env (STAGING) — 예시 형태만 (실제 시크릿은 서버에만)
```
PORT=3100
CLIENT_ORIGIN=https://dallyeori.com,https://duck.lingora.chat
GOOGLE_CLIENT_ID=<DALLYEORI 전용>
GOOGLE_CLIENT_SECRET=<비밀>
KAKAO_CLIENT_ID=<기존>
KAKAO_CLIENT_SECRET=<기존>
JWT_SECRET=<openssl rand -hex 32>
QR_CLIENT_BASE_URL=https://dallyeori.com
```

### Lightsail / 방화벽
- HTTP 80, HTTPS 443, SSH 22, (선택) 3100

---

## AWS PROD 환경 (MONO)

| 항목 | 값 |
|------|-----|
| 도메인 | lingora.chat |
| 용도 | MONO 프로덕션 전용 |

---

## 프로젝트 구조

```
로컬:
.../dallyeori/           ← 클라이언트 (Vite)
.../dallyeori-server/    ← 게임 서버

STAGING:
/var/www/dallyeori/              ← nginx 정적 (클라이언트 빌드)
/home/ubuntu/dallyeori-server/   ← PM2 dallyeori
/home/ubuntu/mono/               ← PM2 mono :3174
```

### 포트
- 5173: Vite dev (로컬)
- 3100: dallyeori-server
- 3174: MONO

---

## 서버 코드 업데이트 (STAGING)

```bash
cd ~/dallyeori-server
git pull
npm ci --omit=dev
pm2 restart dallyeori --update-env
```

---

## 2-C QR 캐주얼 대전

### ✅ 구현됨
- 서버: `POST /api/qr-match/create`, `GET /qr/:matchCode`, 게스트 JWT, `pairQrRoom`
- 클라이언트: QR 대전, 게스트 부트, 결과 앱 유도
- `QR_CLIENT_BASE_URL` — 보통 `https://dallyeori.com`

---

## 핵심 설계 원칙 (절대 변경 금지)

1. 경기장 안 = 100% 순수 손가락 속도
2. 하트 = 통합 화폐
3. 의무 루틴 없음
4. 오리는 날개를 펼치지 않는다

## 하트 경제 (확정)
- 경주 1판 = 하트 1개 소모
- 승리 시 상대 하트 1개 뺏어옴
- 패배 시 하트 1개 잃음
- 하트 0이면 경주 불가
- 친구 하트 구걸 기능 확정
