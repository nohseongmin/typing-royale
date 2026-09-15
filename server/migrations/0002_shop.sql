-- 장착 중인 스킨. 기본값은 무료 아이템이다.
ALTER TABLE users ADD COLUMN sound TEXT NOT NULL DEFAULT 'sound:basic';
ALTER TABLE users ADD COLUMN font  TEXT NOT NULL DEFAULT 'font:basic';
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'theme:basic';

-- 산 스킨. 무료 아이템은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS inventory (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

-- 하루에 받은 코인. 파밍을 막으려고 한국 시간 날짜별로 한도를 둔다.
CREATE TABLE IF NOT EXISTS daily_coins (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT    NOT NULL,
  earned  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
