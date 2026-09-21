/**
 * 코인·상점·스킨. 실제 돈은 받지 않는다(게임물 등급분류 없이 비영리로 운영).
 *
 * 코인은 온라인 대전 결과로만 준다. 연습 모드는 브라우저 안에서만 돌아서 결과를 믿을 수 없다.
 * 아이템 이름·가격은 여기가 기준이고, 클라이언트는 적용 방법(소리·글꼴·색)만 안다.
 */

export const CATALOG = [
  {id: "sound:basic",      slot: "sound", name: "기본 타자음",     price: 0},
  {id: "sound:blue",       slot: "sound", name: "청축 달각달각",   price: 200},
  {id: "sound:red",        slot: "sound", name: "적축 톡톡",       price: 200},
  {id: "sound:typewriter", slot: "sound", name: "옛날 타자기",     price: 350},
  {id: "sound:bubble",     slot: "sound", name: "뽁뽁이",          price: 150},
  {id: "font:basic",       slot: "font",  name: "기본 글꼴",       price: 0},
  {id: "font:jua",         slot: "font",  name: "주아체",          price: 150},
  {id: "font:dohyeon",     slot: "font",  name: "도현체",          price: 150},
  {id: "font:pen",         slot: "font",  name: "나눔손글씨 펜",   price: 250},
  {id: "font:coding",      slot: "font",  name: "나눔고딕 코딩",   price: 200},
  {id: "theme:basic",      slot: "theme", name: "기본 초록",       price: 0},
  {id: "theme:cobalt",     slot: "theme", name: "코발트",          price: 120},
  {id: "theme:violet",     slot: "theme", name: "보라",            price: 120},
  {id: "theme:sunset",     slot: "theme", name: "노을",            price: 120}
];
const ITEMS = new Map(CATALOG.map(item => [item.id, item]));
// SQL에 들어가는 열 이름은 이 표에서만 고른다(요청값을 그대로 넣지 않는다)
const SLOT_COLUMN = {sound: "sound", font: "font", theme: "theme"};

const REWARD_BASE = 10;        // 끝까지 한 판 참가
const REWARD_PER_BEATEN = 5;   // 나보다 먼저 떨어진 사람 한 명마다
const REWARD_WIN = 20;         // 우승
const DAILY_CAP = 600;         // 하루 최대(친구 계정으로 판을 돌리는 파밍 방지)
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const kstDay = () => new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);

export const rewardFor = (rank, players) =>
  REWARD_BASE + Math.max(0, players - rank) * REWARD_PER_BEATEN + (rank === 1 ? REWARD_WIN : 0);

/* results: [{uid, rank, players}] → uid별 {coins, total, capped} */
export async function grantRewards(env, results) {
  const granted = new Map();
  if (!env.DB) return granted;
  const day = kstDay();
  for (const r of results) {
    if (!r.uid || granted.has(r.uid)) continue;   // 한 계정으로 탭 두 개 띄워도 한 번만
    const full = rewardFor(r.rank, r.players);
    // 한도 확인과 지급을 한 배치(트랜잭션)로 한다. 한 계정이 여러 방에서 동시에 끝나도 한도를 넘지 않는다.
    const [, before, , , after] = await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_coins (user_id, day, earned) SELECT ?, ?, 0 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) ON CONFLICT(user_id, day) DO NOTHING").bind(r.uid, day, r.uid),
      env.DB.prepare("SELECT earned FROM daily_coins WHERE user_id = ? AND day = ?").bind(r.uid, day),
      env.DB.prepare("UPDATE users SET coins = coins + MIN(?, ? - (SELECT earned FROM daily_coins WHERE user_id = ? AND day = ?)) WHERE id = ?")
        .bind(full, DAILY_CAP, r.uid, day, r.uid),
      env.DB.prepare("UPDATE daily_coins SET earned = MIN(?, earned + ?) WHERE user_id = ? AND day = ?").bind(DAILY_CAP, full, r.uid, day),
      env.DB.prepare("SELECT coins FROM users WHERE id = ?").bind(r.uid),
      env.DB.prepare("DELETE FROM daily_coins WHERE user_id = ? AND day < ?").bind(r.uid, day)   // 오늘 것만 쓴다. 날마다 한 줄씩 쌓아 두지 않는다
    ]);
    if (!after.results.length) continue; // 판이 끝나기 전에 탈퇴한 계정은 건너뛴다.
    const coins = Math.max(0, Math.min(full, DAILY_CAP - (before.results[0]?.earned || 0)));
    granted.set(r.uid, {coins, total: after.results[0]?.coins ?? 0, capped: coins < full});
  }
  return granted;
}

const readItem = async request => ITEMS.get((await request.json().catch(() => ({}))).item);

/* 상점 경로면 응답을, 아니면 null을 돌려준다. user는 로그인 안 했으면 null. */
export async function handleShop(request, env, url, json, user) {
  if (url.pathname === "/shop" && request.method === "GET") {
    if (!user) return json({items: CATALOG});
    const {results} = await env.DB.prepare("SELECT item_id FROM inventory WHERE user_id = ?").bind(user.id).all();
    return json({
      items: CATALOG, coins: user.coins, owned: results.map(r => r.item_id),
      loadout: {sound: user.sound, font: user.font, theme: user.theme}
    });
  }

  if (url.pathname === "/shop/buy" && request.method === "POST") {
    if (!user) return json({error: "로그인이 필요하다"}, 401);
    const item = await readItem(request);
    if (!item || item.price <= 0) return json({error: "살 수 없는 아이템이다"}, 400);
    // 코인이 충분하고 아직 없을 때만 넣고, 실제로 넣었을 때만 코인을 뺀다.
    // 한 배치(트랜잭션)라서 버튼을 연타해도 두 번 빠지지 않는다.
    const [inserted] = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO inventory (user_id, item_id, acquired_at) SELECT ?, ?, ? " +
        "WHERE (SELECT coins FROM users WHERE id = ?) >= ? " +
        "AND NOT EXISTS (SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?)"
      ).bind(user.id, item.id, Date.now(), user.id, item.price, user.id, item.id),
      env.DB.prepare("UPDATE users SET coins = coins - ? WHERE id = ? AND changes() > 0").bind(item.price, user.id)
    ]);
    if (!inserted.meta.changes) {
      const owned = await env.DB.prepare("SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?").bind(user.id, item.id).first();
      return json({error: owned ? "이미 가지고 있다" : "코인이 모자란다"}, 400);
    }
    const fresh = await env.DB.prepare("SELECT coins FROM users WHERE id = ?").bind(user.id).first();
    return json({ok: true, item: item.id, coins: fresh.coins});
  }

  if (url.pathname === "/shop/equip" && request.method === "POST") {
    if (!user) return json({error: "로그인이 필요하다"}, 401);
    const item = await readItem(request);
    if (!item) return json({error: "없는 아이템이다"}, 400);
    if (item.price > 0) {
      const owned = await env.DB.prepare("SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?").bind(user.id, item.id).first();
      if (!owned) return json({error: "먼저 사야 한다"}, 403);
    }
    await env.DB.prepare(`UPDATE users SET ${SLOT_COLUMN[item.slot]} = ? WHERE id = ?`).bind(item.id, user.id).run();
    return json({ok: true, slot: item.slot, item: item.id});
  }

  return null;
}
