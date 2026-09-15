-- 계정. 카카오에서는 회원번호만 받고 닉네임은 게임 안에서 정한다.
-- (닉네임 동의항목은 비즈 앱 전환이 필요할 수 있어서 기대하지 않는다)
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kakao_id    TEXT    NOT NULL UNIQUE,
  nickname    TEXT    NOT NULL,
  coins       INTEGER NOT NULL DEFAULT 0,
  rating      INTEGER NOT NULL DEFAULT 1000,
  created_at  INTEGER NOT NULL
);

-- 세션 토큰은 해시만 저장한다. DB가 새도 토큰을 그대로 쓸 수 없다.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- 카카오 로그인 CSRF 방지용 state. 한 번 쓰면 지운다.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT    PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
