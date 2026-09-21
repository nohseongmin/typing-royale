/**
 * 사람 속도·문장 검사. 서버는 키 입력을 못 보니 두 가지만 본다.
 * 1) 상대 화면에 중계할 "지금 치는 문장"이 진짜 문장 풀에서 나온 것인가
 * 2) 지금까지 끝낸 문장들을 사람이 이 시간 안에 칠 수 있었나
 *
 * 속도 기준은 넉넉하게 1800타/분(초당 30타). 한컴 짧은글 고수도 한 판 내내 유지하기 힘든 값이라
 * 사람은 안 걸리고, 문장을 한 번에 채워 넣는 스크립트는 걸린다.
 */

import "../../public/pool.js";   // globalThis.TR_POOL (클라이언트와 같은 파일)

export const MAX_STROKES_PER_SEC = 30;
export const PACE_SLACK_STROKES = 80;   // 렉으로 완료 신고가 몰려 와도 걸리지 않게 문장 하나만큼 봐준다
export const SUSPECT_STRIKES = 3;       // 이만큼 걸리면 그 판은 코인에서 빼고 랭크전은 꼴찌로 친다

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

/* 공격은 어절 안 글자 섞기, 이웃 어절 바꾸기, 신조어 끼워넣기뿐이다.
   그래서 신조어를 빼고 어절마다 글자를 정렬해 모으면 망가진 문장도 원래 문장과 같은 열쇠가 나온다. */
const sortChars = w => [...w].sort().join("");
const lineKey = (words, slang) => words.map(sortChars).filter(w => !slang.has(w)).sort().join(" ");
const POOLS = {};
for (const [lang, pool] of Object.entries(globalThis.TR_POOL)) {
  const slang = new Set(pool.flatMap(e => e.slots.map(s => sortChars(s.word))));
  POOLS[lang] = {
    slang,
    keys: new Set(pool.map(e => lineKey(e.text.split(" "), slang))),
    minStrokes: Math.min(...pool.map(e => strokes(e.text)))
  };
}

export const isPoolLine = (line, lang) => {
  const p = POOLS[lang];
  return !!p && typeof line === "string" && line.length > 0 && p.keys.has(lineKey(line.split(" "), p.slang));
};
/* 가장 짧은 풀 문장의 타수. 속도 계산에서 이보다 짧게 치지 않는다. */
export const minLineStrokes = lang => POOLS[lang]?.minStrokes ?? 1;

/* 판이 시작되고 elapsedMs 동안 사람이 칠 수 있는 타수 안에 들어오나 */
export const withinHumanPace = (totalStrokes, elapsedMs) =>
  totalStrokes <= Math.max(0, elapsedMs) / 1000 * MAX_STROKES_PER_SEC + PACE_SLACK_STROKES;
