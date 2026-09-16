-- 랭크전. 레이팅은 계정 만들 때부터 1000으로 있다. 한 판이라도 한 사람만 순위표에 올린다.
ALTER TABLE users ADD COLUMN ranked_games INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS users_rating ON users(rating DESC) WHERE ranked_games > 0;
