-- 공개 전 보안 정리.

-- 기존 워커와 롤백의 호환성을 위해 oauth_states는 남겨 둔다.
-- 새 워커는 로그인 state를 서명으로 검증하므로 이 표에 쓰지 않는다.

-- 로그인 직후 주소 # 뒤에 싣는 1분짜리 교환권. 세션 표에 pending=1로 둔다
ALTER TABLE sessions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

-- 닉네임 중복 방지. 대소문자·공백을 무시한 열쇠로 비교한다(예전 계정은 이름을 바꿀 때 채워진다)
ALTER TABLE users ADD COLUMN nick_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_nick_key ON users(nick_key);

-- 제재. 1이면 로그인해도 게스트처럼 다뤄지고 순위표에서 빠진다
ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;

-- 같은 두 계정이 오늘 레이팅을 주고받은 판 수(부계정 밀어주기 방지). a < b
CREATE TABLE IF NOT EXISTS ranked_pairs (
  day   TEXT    NOT NULL,
  a     INTEGER NOT NULL,
  b     INTEGER NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, a, b)
);
