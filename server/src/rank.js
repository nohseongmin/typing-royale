/**
 * 랭크전 레이팅과 순위표.
 *
 * 한 판에 여러 명이라 다인전 Elo를 쓴다. 모든 상대와 1:1로 붙었다고 치고 기대 승률과 실제 결과의
 * 차이를 더한 뒤 (인원-1)로 나눈다. 둘이 같은 레이팅이면 이긴 쪽 +16, 진 쪽 -16이다.
 */

const K = 32;
const TOP_N = 20;
export const TIERS = [[1700, "마스터"], [1550, "다이아"], [1400, "플래티넘"], [1250, "골드"], [1100, "실버"], [-Infinity, "브론즈"]];
export const tierOf = rating => TIERS.find(([min]) => rating >= min)[1];

/* entries: [{uid, rating, rank}] → uid별 레이팅 변화 */
export function eloDeltas(entries) {
  const deltas = new Map();
  if (entries.length < 2) return deltas;
  for (const a of entries) {
    let sum = 0;
    for (const b of entries) {
      if (a === b) continue;
      const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const actual = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;   // 순위 숫자가 작을수록 잘한 것
      sum += actual - expected;
    }
    deltas.set(a.uid, Math.round(K * sum / (entries.length - 1)));
  }
  return deltas;
}

/* results: [{uid, rank, departed}]. onlyLosses면 레이팅이 깎이는 사람만 반영한다(너무 짧게 끝난 판).
   → uid별 {before, after, delta, tier} */
export async function applyRatings(env, results, {onlyLosses = false} = {}) {
  const applied = new Map();
  if (!env.DB) return applied;
  const seen = new Set(), entries = [];
  for (const r of results) {
    if (!r.uid || seen.has(r.uid)) continue;
    seen.add(r.uid);
    const row = await env.DB.prepare("SELECT rating FROM users WHERE id = ?").bind(r.uid).first();
    if (row) entries.push({uid: r.uid, rank: r.rank, rating: row.rating});
  }
  const deltas = eloDeltas(entries);
  const statements = [];
  for (const e of entries) {
    const delta = deltas.get(e.uid) ?? 0;
    if (onlyLosses && delta >= 0) continue;
    statements.push(env.DB.prepare("UPDATE users SET rating = rating + ?, ranked_games = ranked_games + 1 WHERE id = ?").bind(delta, e.uid));
    applied.set(e.uid, {before: e.rating, after: e.rating + delta, delta, tier: tierOf(e.rating + delta)});
  }
  if (statements.length) await env.DB.batch(statements);
  return applied;
}

export async function handleRank(request, env, url, json) {
  if (url.pathname !== "/rank/top") return null;
  if (!env.DB) return json({top: []});
  const {results} = await env.DB.prepare(
    "SELECT nickname, rating, ranked_games FROM users WHERE ranked_games > 0 ORDER BY rating DESC, ranked_games DESC LIMIT ?"
  ).bind(TOP_N).all();
  return json({top: results.map(r => ({nickname: r.nickname, rating: r.rating, games: r.ranked_games, tier: tierOf(r.rating)}))});
}
