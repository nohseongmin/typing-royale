/**
 * 랭크전 레이팅과 순위표.
 *
 * 한 판에 여러 명이라 다인전 Elo를 쓴다. 모든 상대와 1:1로 붙었다고 치고 기대 승률과 실제 결과의
 * 차이를 더한 뒤 센 상대 수로 나눈다. 둘이 같은 레이팅이면 이긴 쪽 +16, 진 쪽 -16이다.
 *
 * 부계정으로 점수를 밀어주지 못하게 두 경우는 1:1 계산에서 뺀다.
 * - 같은 IP에서 들어온 두 사람(한 사람이 계정 두 개로 붙는 경우. PC방 손님끼리도 서로는 안 주고받지만 다른 사람과는 그대로다)
 * - 오늘 이미 여러 번 레이팅을 주고받은 두 계정
 */

import {kstDay} from "./shop.js";

const K = 32;
const TOP_N = 20;
const PAIR_DAILY_CAP = 3;
export const TIERS = [[1700, "마스터"], [1550, "다이아"], [1400, "플래티넘"], [1250, "골드"], [1100, "실버"], [-Infinity, "브론즈"]];
export const tierOf = rating => TIERS.find(([min]) => rating >= min)[1];

const pairKey = (x, y) => (x < y ? x + ":" + y : y + ":" + x);

/* entries: [{uid, ip, rating, rank}], skip(a, b): 이 둘은 서로 안 센다 → uid별 레이팅 변화 */
export function eloDeltas(entries, skip = () => false) {
  const deltas = new Map();
  for (const a of entries) {
    let sum = 0, counted = 0;
    for (const b of entries) {
      if (a === b || skip(a, b)) continue;
      const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const actual = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;   // 순위 숫자가 작을수록 잘한 것
      sum += actual - expected;
      counted++;
    }
    deltas.set(a.uid, counted ? Math.round(K * sum / counted) : 0);
  }
  return deltas;
}

/* results: [{uid, ip, rank}]. onlyLosses면 레이팅이 깎이는 사람만 반영한다(너무 짧게 끝난 판).
   → uid별 {before, after, delta, tier} */
export async function applyRatings(env, results, {onlyLosses = false} = {}) {
  const applied = new Map();
  if (!env.DB) return applied;
  const seen = new Set(), entries = [];
  for (const r of results) {
    if (!r.uid || seen.has(r.uid)) continue;
    seen.add(r.uid);
    const row = await env.DB.prepare("SELECT rating FROM users WHERE id = ?").bind(r.uid).first();
    if (row) entries.push({uid: r.uid, ip: r.ip, rank: r.rank, rating: row.rating});
  }
  if (entries.length < 2) return applied;

  const day = kstDay(), uids = entries.map(e => e.uid), marks = uids.map(() => "?").join(",");
  const {results: met} = await env.DB.prepare(`SELECT a, b, games FROM ranked_pairs WHERE day = ? AND a IN (${marks}) AND b IN (${marks})`)
    .bind(day, ...uids, ...uids).all();
  const capped = new Set(met.filter(m => m.games >= PAIR_DAILY_CAP).map(m => pairKey(m.a, m.b)));
  const skip = (a, b) => (a.ip && a.ip === b.ip) || capped.has(pairKey(a.uid, b.uid));
  const deltas = eloDeltas(entries, skip);

  const statements = [env.DB.prepare("DELETE FROM ranked_pairs WHERE day < ?").bind(day)];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    if (onlyLosses || skip(a, b)) continue;
    statements.push(env.DB.prepare("INSERT INTO ranked_pairs (day, a, b, games) VALUES (?, ?, ?, 1) ON CONFLICT(day, a, b) DO UPDATE SET games = games + 1")
      .bind(day, Math.min(a.uid, b.uid), Math.max(a.uid, b.uid)));
  }
  for (const e of entries) {
    const delta = deltas.get(e.uid) ?? 0;
    if (onlyLosses && delta >= 0) continue;
    statements.push(env.DB.prepare("UPDATE users SET rating = rating + ?, ranked_games = ranked_games + 1 WHERE id = ?").bind(delta, e.uid));
    applied.set(e.uid, {before: e.rating, after: e.rating + delta, delta, tier: tierOf(e.rating + delta)});
  }
  await env.DB.batch(statements);
  return applied;
}

export async function handleRank(request, env, url, json) {
  if (url.pathname !== "/rank/top") return null;
  if (!env.DB) return json({top: []});
  const {results} = await env.DB.prepare(
    "SELECT nickname, rating, ranked_games FROM users WHERE ranked_games > 0 AND banned = 0 ORDER BY rating DESC, ranked_games DESC LIMIT ?"
  ).bind(TOP_N).all();
  return json({top: results.map(r => ({nickname: r.nickname, rating: r.rating, games: r.ranked_games, tier: tierOf(r.rating)}))});
}
