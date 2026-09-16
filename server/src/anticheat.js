/**
 * 사람 속도 검사. 서버는 키 입력을 못 보니 "이 문장을 이 시간 안에 끝내는 게 가능한가"만 본다.
 *
 * 기준은 넉넉하게 1800타/분(초당 30타). 한컴 짧은글 고수도 순간 속도로 넘기 힘든 값이라
 * 사람은 안 걸리고, 문장을 한 번에 채워 넣는 스크립트는 걸린다.
 */

export const MAX_STROKES_PER_SEC = 30;
export const MIN_SENTENCE_MS = 1000;   // 문장이 비어 있게 신고돼도 이보다 빨리는 못 끝낸다
export const SUSPECT_STRIKES = 3;      // 이만큼 걸리면 그 판은 코인·레이팅에서 뺀다

const DOUBLE_JUNG = new Set([9, 10, 11, 14, 15, 16, 19]);          // ㅘㅙㅚㅝㅞㅟㅢ
const DOUBLE_JONG = new Set([3, 5, 6, 9, 10, 11, 12, 13, 14, 15, 18]); // ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄ

/* 두벌식으로 치는 키 수. 클라이언트 타수 계산과 같은 규칙이다. */
export function strokes(str) {
  let n = 0;
  for (const ch of String(str)) {
    const c = ch.charCodeAt(0) - 0xAC00;
    if (c < 0 || c > 11171) { n += 1; continue; }
    const jong = c % 28, jung = Math.floor(c / 28) % 21;
    n += 1 + (DOUBLE_JUNG.has(jung) ? 2 : 1) + (jong ? (DOUBLE_JONG.has(jong) ? 2 : 1) : 0);
  }
  return n;
}

/* 이 문장을 사람이 끝낼 수 있는 가장 짧은 시간 */
export const minSentenceMs = lineStrokes => Math.max(MIN_SENTENCE_MS, lineStrokes / MAX_STROKES_PER_SEC * 1000);
