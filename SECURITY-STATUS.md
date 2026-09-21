# 공개 전 보안 상태 — 2026-09-21

상태: 공개 배포 보류. 이 문서는 모든 취약점이 제거됐다는 보증이 아니다.
현재 수정은 `fix/prelaunch-security` 브랜치에 있으며 운영 DB 마이그레이션·Worker 배포·Pages 전환은 이번 작업에서 실행하지 않았다.

## 이번에 직접 확인한 결과

- `server/`의 `npm test`: 13개 통과. 실제 마이그레이션 SQL을 인메모리 SQLite에 적용하고 외래키·배치 트랜잭션을 활성화했다. 이 테스트는 원격 D1 동시성 시험을 대신하지 않는다.
- 탈퇴한 사용자의 보상 처리가 다른 사용자를 중단시키지 않음, 일일 코인 한도, 조기 종료 랭크전의 상대별 일일 횟수 보호.
- OAuth 단계별 요청 제한과 오류 리다이렉트, 외부 Origin 거절, 잘못된 JSON 형태와 2KB 초과 본문 거절, 알 수 없는 상점 경로의 DB 접근 차단.
- IPv6 /64 단위 제한과 같은 IP가 이미 가득 찬 방을 피하는 매칭.
- 닉네임 정규화·흔한 합성어 오탐 완화·운영자 사칭 방지.
- `wrangler deploy --dry-run` 성공. 배포 도구는 고정된 Wrangler 4.134.0.
- `npm audit`: 알려진 취약점 0건(91 dependencies). 미공개 취약점과 애플리케이션 로직 문제는 이 결과에 포함되지 않는다.
- 공식 Node 배포본 22.23.2의 SHA-256을 공식 SHASUMS256과 대조한 뒤 해당 런타임에서 테스트·로컬 Worker·dry-run을 실행했다. PC의 기본 Node 22.20.0 자체는 교체하지 않았다.
- 로컬 브라우저 2개: 방 생성, 초대 링크, 닉네임, 준비, 카운트다운, 20초 탈락 및 최종 결과 확인. 콘솔 오류 없음. 실제 IME 타이핑과 카카오 실계정 로그인까지 검증한 것은 아니다.
- 로컬 정적 응답의 CSP, nosniff, Referrer-Policy 확인.
- GitHub Dependabot alerts 및 automated security fixes 활성화 확인.

## 기존 수정과 이어서 보완한 내용

기존 작업의 독립 출처 전환, 단기 OAuth 교환권, 세션 제한, 계정 삭제, 문장 풀 검사, 로비 시간 제한, 의존성 고정은 보존했다. 보상 중단, OAuth 제한, JSON 검증, IPv6 제한, 매칭 재시도, 만료 세션, 닉네임 오탐, 중복 버튼 실행 문제를 보완했다. 요청 메타데이터의 로그 수집을 끄고 OAuth 오류 응답 본문을 로그에 남기지 않도록 했다.

## 남은 공개 판단 항목

1. **가용성:** Worker 안에서 429를 반환해도 호출 자체는 발생한다. 공개 workers.dev의 무료 요청 한도 소진을 애플리케이션 제한만으로 완전히 방지할 수 없다. 일반 WebSocket과 타이머가 방을 활성 상태로 유지하는 문제도 남아 있다. 로비 Hibernation 전환과 Worker 진입 전 보호 정책을 검토해야 한다. 유료 플랜으로 자동 전환하거나 결제를 설정하지 않았다.
2. **경쟁 공정성:** 완료 신고는 서버 진행도 99.9% 이상일 때만 처리하고, 온라인 공격 발수는 서버가 계산하도록 보완했다. 그래도 서버가 문장 배정·오염 상태를 전부 소유하지 않으며 피격 적용은 클라이언트 화면에 의존한다. 랭크전 공개 전 서버 권한으로 게임 상태를 옮기는 작업이 필요하다.
3. **랭크 정산 동시성:** 정산을 전역 Matchmaker의 `blockConcurrencyWhile`로 직렬화해 상대별 횟수의 읽기/쓰기 경쟁을 막았다. 테스트 더블에서 동시 4회 요청 중 3회만 레이팅이 변함을 확인했다. 실제 Durable Object 재시작·장애·정산 중 단절까지 검증한 것은 아니다.
4. **인증 실통합:** 카카오 설정 상태를 확인하고 정상 로그인·실패·로그아웃·계정 삭제를 비운영 계정으로 검증해야 한다. 기존 검토 결과만으로 통과 처리하지 않았다.
5. **운영 전환:** 원격 스키마 상태 확인 → 마이그레이션 → Worker → 실제 헤더/웹소켓/인증 검증 → Pages 전환 순서를 지킨다. GitHub 저장소는 조회 당시 이미 public이었다. 저장소 공개 여부는 변경하지 않았다.

## 공식 확인 자료

- Node 보안 공지: https://nodejs.org/en/blog/vulnerability
- Node 22.23.2 체크섬: https://nodejs.org/dist/v22.23.2/SHASUMS256.txt
- Wrangler 보안 권고: https://github.com/cloudflare/workers-sdk/security/advisories
- Workers 한도: https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects 과금과 한도: https://developers.cloudflare.com/durable-objects/platform/pricing/
