/**
 * 닉네임 규칙. 로비·상대 카드·순위표에 그대로 보이는 글이라 욕설·사칭·연락처 홍보를 막는다.
 * 글자 종류는 auth.js의 cleanNick이 한글·영문·숫자로 먼저 좁혀 둔다.
 */

// 비교용 열쇠: 대소문자·공백·밑줄·하이픈을 무시한다("A dmin"과 "admin"을 같은 이름으로 본다)
export const nickKey = n => n.toLowerCase().replace(/[\s_-]/g, "");

const BLOCK = /시발|씨발|씨빨|씹|ㅅㅂ|ㅆㅂ|병신|븅신|ㅂㅅ|좆|존나|ㅈㄴ|니애미|느금|애미|애비|섹스|보지|자지|창녀|걸레|fuck|shit|bitch|nigg|cunt/;
const RESERVED = /운영자|관리자|운영진|개발자|admin|official|^gm(?![a-z])|^(공식|나|익명)$|^봇(?:[0-9a-z]|$)/;
const CONTACT = /카톡|톡아디|톡아이디|텔레그램|텔레아이디|토토사이트|카지노|바카라|www|http/;
// ponytail: 부분 문자열 금칙어 목록이다. 신고가 들어오는 대로 단어를 더한다

export const nickAllowed = n => {
  const k = nickKey(n);
  // 흔한 합성어 경계가 금칙어와 겹치는 경우만 제거한다. 뒤에 붙은 실제 금칙어는 계속 검사한다.
  const words = k.replace(/(?:정보|감자|과자|바보|울보|먹보|남자|여자|피자|사자|왕자|모자|부자)지|시발점|물걸레|병신년/g, "");
  return !!k && !BLOCK.test(words) && !RESERVED.test(k) && !CONTACT.test(k);
};
