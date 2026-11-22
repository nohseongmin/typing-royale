const notice = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>서비스 점검 · 타자 배틀로얄</title><style>
:root{color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText;font:17px/1.75 system-ui,sans-serif}
main{max-width:34rem;margin:clamp(4rem,15vh,10rem) auto;padding:0 1.5rem}h1{font-size:clamp(1.8rem,6vw,2.5rem);line-height:1.3}
p{word-break:keep-all}footer{margin-top:3rem;border-top:1px solid GrayText;padding-top:1rem;font-size:.9rem}a{color:LinkText}
</style></head><body><main><p>타자 배틀로얄</p><h1>잠시 문을 닫습니다</h1>
<p>게임물 등급분류를 준비하는 동안 연습과 온라인 대전을 쉬어 갑니다. 다시 열 때 이 주소에서 알려드릴게요.</p>
<footer>리팩토링 게임즈<br>이용 문의 · 개인정보 열람 및 삭제 요청<br><a href="mailto:sm9375693@gmail.com">sm9375693@gmail.com</a></footer></main></body></html>`;

function maintenance(request) {
  const headers = {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"
  };
  return new Response(request.method === "HEAD" ? null : notice, {status:503, headers});
}

export default {fetch: maintenance};

// 기존 Durable Object 이름과 저장소를 유지하면서 경기 연결은 받지 않는다.
export class Room { fetch(request) { return maintenance(request); } }
export class Matchmaker extends Room {}
