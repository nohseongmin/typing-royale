/* 연습 모드와 서버가 같은 타자·공격 규칙을 사용한다. */
(() => {
"use strict";
const rnd = n => Math.floor(Math.random()*n);
const pick = a => a[rnd(a.length)];
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅗㅏ","ㅗㅐ","ㅗㅣ","ㅛ","ㅜ","ㅜㅓ","ㅜㅔ","ㅜㅣ","ㅠ","ㅡ","ㅡㅣ","ㅣ"];
const JONG = ["","ㄱ","ㄲ","ㄱㅅ","ㄴ","ㄴㅈ","ㄴㅎ","ㄷ","ㄹ","ㄹㄱ","ㄹㅁ","ㄹㅂ","ㄹㅅ","ㄹㅌ","ㄹㅍ","ㄹㅎ","ㅁ","ㅂ","ㅂㅅ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
const COMPAT_SPLIT = {"ㅘ":"ㅗㅏ","ㅙ":"ㅗㅐ","ㅚ":"ㅗㅣ","ㅝ":"ㅜㅓ","ㅞ":"ㅜㅔ","ㅟ":"ㅜㅣ","ㅢ":"ㅡㅣ",
  "ㄳ":"ㄱㅅ","ㄵ":"ㄴㅈ","ㄶ":"ㄴㅎ","ㄺ":"ㄹㄱ","ㄻ":"ㄹㅁ","ㄼ":"ㄹㅂ","ㄽ":"ㄹㅅ","ㄾ":"ㄹㅌ","ㄿ":"ㄹㅍ","ㅀ":"ㄹㅎ","ㅄ":"ㅂㅅ"};
function keys(str){
  let out = "";
  for (const ch of str){
    const c = ch.charCodeAt(0) - 0xAC00;
    if (c < 0 || c > 11171){ out += COMPAT_SPLIT[ch] || ch; continue; }
    out += CHO[Math.floor(c / 588)] + JUNG[Math.floor(c / 28) % 21] + JONG[c % 28];
  }
  return out;
}
const strokes = str => keys(str).length;

/* 처음 틀린 글자 위치(없으면 -1). 조합 중인 마지막 글자는 자모 단위로 앞부분만 맞으면 통과다. */
function firstWrong(typed, target, composing){
  for (let i = 0; i < typed.length; i++){
    const ok = composing && i === typed.length - 1
      ? keys(target.slice(i)).startsWith(keys(typed[i]))
      : typed[i] === target[i];
    if (!ok) return i;
  }
  return -1;
}

const MAX_HITS = 2;      // 한 문장이 받을 수 있는 최대 공격 수
const SAFE_WORDS = 2;    // 지금 치는 어절에서 이만큼 뒤부터만 공격 가능

function makeLine(entry){
  // swapped/shuffled: 이미 순서섞기·애너그램 당한 어절. 같은 공격이 두 번 들어가면 원래대로 돌아올 수 있다.
  // inserted: 끼워 넣은 신조어 자리 / slots: 이 문장에서 아직 쓸 수 있는 신조어 자리
  return {src:entry.text, words:entry.text.split(" "), slots:entry.slots.slice(), tags:[], hits:0,
          dirty:new Set(), swapped:new Set(), shuffled:new Set(), inserted:new Set(), v:0};
}
const lineText = l => l.words.join(" ");

/* 커서 위치가 몇 번째 어절인지 */
function wordAt(line, pos){
  let n = 0, seen = 0;
  for (const w of line.words){
    seen += w.length;
    if (pos <= seen) return n;
    seen += 1; n++;
  }
  return line.words.length - 1;
}
/* 어절을 끼워 넣으면 그 뒤 표시들의 위치도 한 칸씩 민다 */
function shiftMarks(line, from){
  const shift = set => new Set([...set].map(d => d >= from ? d + 1 : d));
  line.dirty = shift(line.dirty); line.swapped = shift(line.swapped);
  line.shuffled = shift(line.shuffled); line.inserted = shift(line.inserted);
}

function atkAnagram(l, min){
  const cand = l.words.map((w,i)=>i).filter(i => i >= min && l.words[i].length >= 3 && !l.shuffled.has(i));
  if (!cand.length) return false;
  const i = pick(cand), src = l.words[i];
  for (let t=0; t<24; t++){
    const a = [...src];
    for (let k=a.length-1; k>0; k--){ const j = rnd(k+1); [a[k],a[j]] = [a[j],a[k]]; }
    if (a.join("") !== src){ l.words[i] = a.join(""); l.dirty.add(i); l.shuffled.add(i); return true; }
  }
  return false;
}
function atkInsert(l, min){
  const cand = [];
  for (const o of l.slots){
    // 이미 끼운 신조어 바로 뒤에는 또 안 넣는다(신조어 연타 방지)
    const i = l.words.findIndex((w, k) => k >= Math.max(min, 1) && w === o.before && !l.inserted.has(k - 1));
    if (i >= 0) cand.push([i, o]);
  }
  if (!cand.length) return false;
  const [i, o] = pick(cand);
  l.words.splice(i, 0, o.word);
  shiftMarks(l, i); l.dirty.add(i); l.inserted.add(i);
  l.slots = l.slots.filter(x => x.before !== o.before);   // 같은 자리엔 한 번만
  return true;
}
function atkReorder(l, min){
  const cand = [];
  for (let i = Math.max(min,0); i < l.words.length - 1; i++){
    if (!l.swapped.has(i) && !l.swapped.has(i+1)) cand.push(i);   // 한 번 바뀐 어절은 다시 안 바꾼다
  }
  if (!cand.length) return false;
  const i = pick(cand);
  [l.words[i], l.words[i+1]] = [l.words[i+1], l.words[i]];
  l.dirty.add(i); l.dirty.add(i+1); l.swapped.add(i); l.swapped.add(i+1);
  // 애너그램·신조어 표시는 어절을 따라간다. 안 옮기면 신조어 연타 방지 판정이 엉뚱한 어절을 본다.
  for (const set of [l.shuffled, l.inserted]){
    const a = set.has(i), b = set.has(i+1);
    set.delete(i); set.delete(i+1);
    if (a) set.add(i+1);
    if (b) set.add(i);
  }
  return true;
}
const ATTACKS = {anagram:atkAnagram, insert:atkInsert, reorder:atkReorder};
const ATTACK_NAMES = {anagram:"애너그램", insert:"끼워넣기", reorder:"순서섞기"};

/* 한 종류가 안 먹으면 다른 종류로 대체 */
function corrupt(line, min, kind){
  const order = [kind, ...Object.keys(ATTACKS).filter(k => k !== kind)];
  for (const k of order){
    if (ATTACKS[k](line, min)){
      line.hits++; line.v++;
      if (!line.tags.includes(k)) line.tags.push(k);
      return k;
    }
  }
  return null;
}


const packLine = l => ({src:l.src, words:l.words, tags:l.tags, hits:l.hits, dirty:[...l.dirty], v:l.v});
const unpackLine = l => ({...l, dirty:new Set(l.dirty)});
globalThis.TR_COMBAT = {keys, strokes, firstWrong, MAX_HITS, SAFE_WORDS, makeLine, lineText, wordAt, corrupt, ATTACK_NAMES, packLine, unpackLine};
})();

