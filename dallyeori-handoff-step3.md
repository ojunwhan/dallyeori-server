# 달려오리 — 3단계 핸드오프 (새 대화창용)

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
- 외부 접근 확인됨: http://duck.lingora.chat:3100/health → {"ok":true}

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
| 도메인 | **duck.lingora.chat** |
| SSH | 브라우저 터미널 (Lightsail 콘솔) |
| OS | Ubuntu 24.04.4 LTS |
| Node | v20.20.0 |
| Git | 2.43.0 |

### PM2 프로세스
| id | name | port | 비고 |
|----|------|------|------|
| 0 | mono | 3174 | MONO 서비스 — 절대 건드리지 마 |
| 1 | dallyeori | 3100 | 달려오리 게임 서버 |

### 코드 위치
- 서버: `/home/ubuntu/dallyeori-server/`
- GitHub: `https://github.com/ojunwhan/dallyeori-server.git` (Public)

### .env (STAGING)
```
PORT=3100
CLIENT_ORIGIN=http://duck.lingora.chat:3100
GOOGLE_CLIENT_ID=<Google Cloud>
GOOGLE_CLIENT_SECRET=<Google Cloud>
GOOGLE_CALLBACK_URL=http://duck.lingora.chat:3100/api/auth/google/callback
KAKAO_CLIENT_ID=<Kakao Developers>
KAKAO_CLIENT_SECRET=<Kakao Developers>
KAKAO_CALLBACK_URL=http://duck.lingora.chat:3100/api/auth/kakao/callback
JWT_SECRET=<openssl rand -hex 32>
QR_CLIENT_BASE_URL=<QR 스캔 시 열릴 프론트 베이스 URL; 비우면 CLIENT_ORIGIN>
```

### Lightsail 방화벽 (STAGING)
| Application | Protocol | Port | Restricted to |
|------------|----------|------|---------------|
| SSH | TCP | 22 | Any IPv4 |
| HTTP | TCP | 80 | Any IPv4 |
| HTTPS | TCP | 443 | Any IPv4 |
| Custom | TCP | 3100 | Any IPv4 |

### DNS (Cloudflare)
- `duck.lingora.chat` → A → 43.201.103.166 (DNS only, 프록시 OFF)

### OAuth 콜백 URL (등록 완료)
**Google Cloud Console:**
- 승인된 JavaScript 원본: `http://duck.lingora.chat:3100`
- 승인된 리디렉션 URI: `http://duck.lingora.chat:3100/api/auth/google/callback`

**Kakao Developers:**
- Redirect URI: `http://duck.lingora.chat:3100/api/auth/kakao/callback`

---

## AWS PROD 환경

| 항목 | 값 |
|------|-----|
| 인스턴스 | Ubuntu-2 (Lightsail) |
| 퍼블릭 IP | 15.164.59.178 |
| 도메인 | lingora.chat |
| 용도 | MONO 프로덕션 전용 |
| GitHub Actions | deploy.yml → feature/hospital-plastic-surgery push 시 자동 배포 |

---

## 프로젝트 구조

```
로컬:
C:\Users\USER\Desktop\dallyeori\          ← 클라이언트 (Vanilla JS + Canvas 2D, Vite)
C:\Users\USER\Desktop\dallyeori\dallyeori-server\  ← 게임 서버
C:\Users\USER\Desktop\MONO\               ← MONO 번역 서비스 (별도 프로젝트)

STAGING 서버:
/home/ubuntu/mono/              ← MONO (PM2: mono, 포트 3174)
/home/ubuntu/dallyeori-server/  ← 달려오리 (PM2: dallyeori, 포트 3100)
```

### .env 파일 위치
- `dallyeori/.env` — 클라이언트 (VITE_* 변수)
- `dallyeori/dallyeori-server/.env` — 게임 서버 (로컬)
- `/home/ubuntu/dallyeori-server/.env` — 게임 서버 (STAGING)
- `MONO/.env` — MONO 서버

### 포트
- 5173: Vite dev server (달려오리 클라이언트, 로컬)
- 3100: dallyeori-server (게임 서버)
- 3174: MONO 서버

---

## 서버 코드 업데이트 방법 (STAGING)

```bash
ssh 접속 후:
cd ~/dallyeori-server
git pull
npm ci --omit=dev
pm2 restart dallyeori --update-env
```

---

## 다음 단계: 2-C QR 캐주얼 대전

- 네이티브 앱 유저가 QR 생성 → 상대 스캔 → PWA로 가입 없이 바로 경주
- MONO의 QR+PWA 구조 활용
- duck.lingora.chat:3100 기반으로 구현
- 프롬프트: cursor-prompt-phase6-step2.md 참고

---

## 핵심 설계 원칙 (절대 변경 금지)

1. 경기장 안 = 100% 순수 손가락 속도. 외부 요소 개입 없음
2. 하트 = 통합 화폐. 복잡한 구조 배제
3. 의무 루틴 없음 (먹이주기, 관리 등 피로 유발 요소 전부 배제)
4. 오리는 날개를 펼치지 않는다 (달려야 한다, 날지 않는다)

## 하트 경제 (확정)
- 경주 1판 = 하트 1개 소모
- 승리 시 상대 하트 1개 뺏어옴 (실질 무료)
- 패배 시 하트 1개 잃음
- 하트 0이면 경주 불가 → 광고/IAP/친구에게 하트 요청으로 충전
- 친구 하트 구걸 기능 확정 (푸시 알림, 하루 요청 횟수 제한)
