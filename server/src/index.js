/**
 * 타자 배틀로얄 실시간 서버.
 *
 * 방 하나가 Durable Object 인스턴스 하나다. 끄투가 Node 게임서버 메모리에 방 객체를
 * 들고 있는 것과 같은 구조인데, 프로세스를 우리가 관리하지 않는다는 점만 다르다.
 *
 * 서버는 심판만 본다. 문장 생성과 오염은 각 클라이언트가 자기 화면에서 처리하고,
 * 서버는 진행도를 모아 순위를 매기고 탈락을 선고하며 공격을 중계한다.
 * 각자 치고 있는 문장과 커서 위치도 받아서 다른 사람 화면(상대 카드·관전)에 뿌린다.
 * 게임 화면(public/)도 이 워커가 같은 주소에서 내보낸다(wrangler.toml [assets]).
 *
 * 빠른 시작은 Matchmaker(전역 DO 하나)가 대기 중인 방 중 사람이 가장 많은 곳으로 보낸다.
 * 계정·카카오 로그인은 auth.js, 코인·상점·스킨은 shop.js, 랭크전 레이팅은 rank.js(모두 D1)가 맡는다.
 * 중계 문장 검사와 사람 속도 검사는 anticheat.js 기준이다.
 *
 * 무료 플랜은 하루 한도를 넘으면 서비스가 멈춘다. 그래서 요청 수(IP별 제한), 방이 살아 있는 시간
 * (대기방·끝난 판 시간 제한), 연결 수(IP별 동시 연결 제한)를 모두 묶어 둔다.
 */

import {handleAuth, userFromToken, cleanNick, bearer} from "./auth.js";
import {nickAllowed} from "./nickname.js";
import {handleShop, grantRewards} from "./shop.js";
import {handleRank, applyRatings} from "./rank.js";
import {strokes, isPoolLine, minLineStrokes, withinHumanPace, MAX_STROKES_PER_SEC, SUSPECT_STRIKES} from "./anticheat.js";

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const LOBBY_WAIT_MS = 20000;    // 빠른 시작: 두 번째 사람이 들어온 뒤 이만큼 더 기다렸다가 시작
const SOLO_WAIT_MS = 20000;     // 빠른 시작: 혼자면 이만큼 기다렸다가 봇전으로 돌려보낸다
const LOBBY_IDLE_MS = 5 * 60 * 1000;   // 시작 안 하고 이만큼 지난 대기방은 닫는다
const OVER_CLOSE_MS = 10000;    // 끝난 판은 결과를 받을 시간만 두고 닫는다
const COUNTDOWN_MS = 3000;      // 시작 신호 뒤 3·2·1 동안은 입력도 판정도 하지 않는다
const ELIM_MS = 20000;          // 탈락 주기
const STATE_HZ = 5;             // 진행도 브로드캐스트 빈도
const HEARTBEAT_MS = 30000;     // 방이 살아 있다고 매치메이커에 알리는 주기
const ROOM_STALE_MS = 75000;    // 이만큼 소식 없는 방은 매치메이커 목록에서 지운다
const RESERVE_MS = 10000;       // 빠른 시작 자리 예약 유효 시간. 접속 안 하는 /join 연타로 방을 꽉 찬 것처럼 만들지 못하게
const ADMIT_HOLD_MS = 5000;     // 방이 인원을 보고하기 전까지 방금 들인 연결도 IP별 연결 수에 센다
const MAX_SOCKETS_PER_IP = 20;  // 서비스 전체에서 IP 하나가 동시에 붙어 있을 수 있는 연결 수
const MAX_SAME_IP_PUBLIC = 4;   // 빠른 시작·랭크전 방 하나에 같은 IP는 이만큼만(PC방 친구 몇 명은 들어오게)
const MAX_FIRE_BONUS = 2;       // 불붙음으로 늘어나는 공격 수 상한
const FAST_MS = 12000;          // 문장을 이보다 빨리 끝내면 한 발 더
const MAX_LINE = 160;           // 중계하는 문장 길이 상한(신조어가 다 박혀도 이보다 짧다)
const MAX_DIRTY = 40;
const MAX_MSGS_PER_SEC = 20;    // 클라이언트는 초당 5번쯤 보낸다. 이걸 넘기면 끊는다
const MAX_BURST_MSGS = MAX_MSGS_PER_SEC * 5; // 네트워크 지연으로 한꺼번에 도착하는 정상 입력은 버퍼 여유를 둔다.
const MAX_MSG_CHARS = 2048;
const MAX_JSON_BYTES = 2048;
const ROOM_CODE_LEN = 6;
const KINDS = ["anagram", "insert", "reorder"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // 헷갈리는 I,O,0,1 제외
const WS_PROTOCOL = "tr.v1";
const WS_AUTH_PREFIX = "auth."; // 로그인 토큰은 주소 대신 서브프로토콜 헤더로 받는다. 주소는 로그에 남는다.
// IP별 요청 제한(wrangler.toml [[ratelimits]] RL). 경로 묶음마다 따로 센다. 메뉴의 접속자 수 조회가 입장을 막지 않게.
const RATE_BUCKETS = {
  "/ws": "ws", "/join": "join", "/new": "new", "/stats": "stats",
  "/auth/kakao/start": "auth", "/auth/kakao/callback": "authcb", "/auth/exchange": "authx",
  "/me": "me", "/me/delete": "me", "/logout": "me", "/shop": "shop", "/shop/buy": "shop", "/shop/equip": "shop", "/rank/top": "rank"
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: {"Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}
});

const randomCode = n =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), b => CODE_CHARS[b % CODE_CHARS.length]).join("");

/* 방 코드는 대소문자를 가리지 않고, 링크로 돌려도 깨지지 않게 정규화한다 */
const normCode = raw => (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
const isAutoCode = code => code.startsWith("AUTO") || code.startsWith("RANK");   // 빠른 시작·랭크전은 카운트다운으로 시작
const isRankedCode = code => code.startsWith("RANK");
const matchmaker = env => env.MATCH.get(env.MATCH.idFromName("global"));
const wsProtocols = request => (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(s => s.trim());
// IPv6의 기기 주소만 바꾸어 요청·연결 제한을 우회하지 못하게 /64 단위로 묶는다.
export function ipScope(ip) {
  if (!ip.includes(":")) return ip;
  const canonical = new URL("http://[" + ip + "]").hostname.slice(1, -1);
  const [head, tail = ""] = canonical.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  return [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].slice(0, 4).join(":") + "::/64";
}
/* IP는 방·매치메이커 메모리에서 비교만 하고 저장하지 않는다. 그마저도 해시로 다룬다. */
const ipKey = async ip => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ip:" + ip)))]
  .slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");

/* 웹소켓 요청을 방에 넘기지 않고 이유와 함께 돌려보낸다. HTTP 오류로 끊으면 브라우저는 이유를 못 본다. */
function denySocket(request, reason) {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(JSON.stringify({t: "denied", reason}));
  pair[1].close(1008, "denied");
  const headers = wsProtocols(request).includes(WS_PROTOCOL) ? {"Sec-WebSocket-Protocol": WS_PROTOCOL} : {};
  return new Response(null, {status: 101, webSocket: pair[0], headers});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isSocket = url.pathname === "/ws";
    if (isSocket && request.headers.get("Upgrade") !== "websocket") return json({error: "expected websocket"}, 426);

    // 다른 사이트가 방문자 브라우저로 우리 서버를 두드리는 걸 막는다. 게임 화면이 같은 주소라 우리 요청의 Origin은 늘 여기다.
    // (웹소켓은 CORS가 안 막아서 직접 본다. 주소창 이동은 Origin을 안 보내서 로그인 흐름은 걸리지 않는다.)
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({error: "forbidden origin"}, 403);

    const ip = ipScope(request.headers.get("CF-Connecting-IP") || "");
    const bucket = RATE_BUCKETS[url.pathname];
    if (bucket && env.RL && !(await env.RL.limit({key: bucket + ":" + ip})).success) {
      if (url.pathname.startsWith("/auth/kakao/")) return Response.redirect(url.origin + "/#login_error=busy", 302);
      return isSocket ? denySocket(request, "요청이 너무 많다. 잠깐 쉬었다 해라") : json({error: "요청이 너무 많다. 잠깐 쉬었다 해라"}, 429);
    }

    // JSON 경계에서 크기와 형태를 먼저 검사한다. null·배열·거대 본문은 DB 처리 전에 거절한다.
    if (request.method === "POST") {
      if (Number(request.headers.get("Content-Length")) > MAX_JSON_BYTES) return json({error: "요청이 너무 크다"}, 413);
      const reader = request.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_JSON_BYTES) { await reader.cancel(); return json({error: "요청이 너무 크다"}, 413); }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder().decode(bytes) || "{}"); }
      catch { return json({error: "잘못된 JSON이다"}, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({error: "객체가 필요하다"}, 400);
      request = new Request(request, {body: JSON.stringify(body)});
    }

    const authResponse = await handleAuth(request, env, url, json);
    if (authResponse) return authResponse;

    if (["/shop", "/shop/buy", "/shop/equip"].includes(url.pathname)) {
      const shopResponse = await handleShop(request, env, url, json, await userFromToken(env, bearer(request)));
      if (shopResponse) return shopResponse;
    }

    const rankResponse = await handleRank(request, env, url, json);
    if (rankResponse) return rankResponse;

    if (url.pathname === "/join") {
      let query = "lang=" + (url.searchParams.get("lang") === "en" ? "en" : "ko") + "&ip=" + await ipKey(ip);
      if (url.searchParams.get("ranked") === "1") {
        // 랭크전 자리는 로그인한 계정에만 준다. 받은 방 코드는 그 계정만 쓸 수 있다.
        const user = await userFromToken(env, bearer(request));
        if (!user) return json({error: "랭크전은 로그인해야 한다"}, 401);
        query += "&ranked=1&uid=" + user.id;
      }
      const r = await matchmaker(env).fetch("https://mm/join?" + query);
      return json(await r.json());
    }

    if (url.pathname === "/stats") {
      const r = await matchmaker(env).fetch("https://mm/stats");
      return json(await r.json());
    }

    if (url.pathname === "/new") return json({code: randomCode(ROOM_CODE_LEN)});

    if (isSocket) {
      const code = normCode(url.searchParams.get("room"));
      if (!code) return denySocket(request, "방 코드가 없다");
      const token = wsProtocols(request).find(p => p.startsWith(WS_AUTH_PREFIX))?.slice(WS_AUTH_PREFIX.length);
      const user = await userFromToken(env, token);
      const ipHash = await ipKey(ip);
      // IP별 동시 연결 수와 랭크전 입장권은 모든 방을 아는 매치메이커가 본다
      const admit = await matchmaker(env).fetch(`https://mm/admit?code=${code}&ip=${ipHash}` + (user ? "&uid=" + user.id : ""));
      if (!admit.ok) return denySocket(request, await admit.text());

      // 클라이언트가 보낸 uid·token·ip는 믿지 않고 지운 뒤 서버가 확인한 값만 방에 넘긴다
      const params = new URLSearchParams(url.searchParams);
      for (const k of ["token", "uid", "ip"]) params.delete(k);
      params.set("ip", ipHash);
      if (user) { params.set("uid", String(user.id)); params.set("name", user.nickname); }
      else {
        const name = cleanNick(params.get("name"));
        params.set("name", name && nickAllowed(name) ? name : "익명");
      }
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      return room.fetch(new Request("https://room/ws?" + params, request));
    }

    return json({error: "not found"}, 404);
  }
};

/* 모든 방의 인원·상태를 모아 두고, 빠른 시작을 누른 사람을 가장 붐비는 대기방으로 보낸다.
   방마다 IP별 연결 수도 받아 두어서 IP 하나가 여러 방에 소켓을 잔뜩 붙이는 걸 막는다. */
export class Matchmaker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();    // code -> {auto, ranked, lang, phase, players, ips, at, held:[예약 시각], tickets:Set(uid)}
    this.admitting = new Map();   // code -> [{ip, at}] 들여보냈지만 방이 아직 인원에 넣어 보고하지 않은 연결
  }

  async fetch(request) {
    const url = new URL(request.url), now = Date.now();
    if (url.pathname === "/ratings" && request.method === "POST") {
      const {entries, onlyLosses} = await request.json();
      // ponytail: 소규모 서비스의 랭크 정산을 전역 DO에서 직렬화한다. 정산량이 커지면 DB의 원자적 정산으로 옮긴다.
      // Worker의 공개 라우터는 이 내부 경로를 전달하지 않는다.
      return this.state.blockConcurrencyWhile(async () =>
        Response.json([...await applyRatings(this.env, entries, {onlyLosses})]));
    }
    for (const [code, r] of this.rooms) if (now - r.at > ROOM_STALE_MS) this.rooms.delete(code);

    if (url.pathname === "/report") {
      const r = await request.json();
      const had = this.rooms.get(r.code);
      this.admitting.delete(r.code);   // 방이 센 인원에 이미 들어 있다
      if (!r.players) this.rooms.delete(r.code);
      else this.rooms.set(r.code, {
        auto: r.auto, ranked: r.ranked, lang: r.lang, phase: r.phase, players: r.players, ips: r.ips || {}, at: now,
        held: [], tickets: had?.tickets || new Set()   // 방이 실제 인원을 알려 오면 예약은 비운다
      });
      return new Response("ok");
    }

    if (url.pathname === "/join") {
      const lang = url.searchParams.get("lang") === "en" ? "en" : "ko";
      const ip = url.searchParams.get("ip");
      const ranked = url.searchParams.get("ranked") === "1";   // 랭크전과 일반 빠른 시작은 대기열이 따로다
      const seats = r => r.players + (r.held = r.held.filter(t => now - t < RESERVE_MS)).length;
      let best = null;
      for (const [code, r] of this.rooms) {
        if (!r.auto || !!r.ranked !== ranked || r.lang !== lang || r.phase !== "lobby" || seats(r) >= MAX_PLAYERS) continue;
        if ((r.ips[ip] || 0) >= MAX_SAME_IP_PUBLIC) continue;
        if (!best || seats(r) > seats(this.rooms.get(best))) best = code;
      }
      if (!best) {
        best = (ranked ? "RANK" : "AUTO") + (lang === "en" ? "EN" : "") + randomCode(ROOM_CODE_LEN);
        // 아직 아무도 안 들어온 방은 예약 시간이 지나면 목록에서 빠진다(첫 입장자가 오면 방이 보고해서 살아난다)
        this.rooms.set(best, {auto: true, ranked, lang, phase: "lobby", players: 0, ips: {}, at: now - ROOM_STALE_MS + RESERVE_MS, held: [], tickets: new Set()});
      }
      const room = this.rooms.get(best);
      room.held.push(now);   // 곧 들어올 사람 자리를 잠깐 잡아 둔다
      if (ranked) room.tickets.add(url.searchParams.get("uid"));
      return Response.json({code: best});
    }

    if (url.pathname === "/admit") {
      const code = url.searchParams.get("code"), ip = url.searchParams.get("ip"), uid = url.searchParams.get("uid");
      let open = 0;
      for (const r of this.rooms.values()) open += r.ips[ip] || 0;
      for (const [k, list] of this.admitting) {
        const fresh = list.filter(a => now - a.at < ADMIT_HOLD_MS);
        if (fresh.length) this.admitting.set(k, fresh); else this.admitting.delete(k);
        open += fresh.filter(a => a.ip === ip).length;
      }
      if (open >= MAX_SOCKETS_PER_IP) return new Response("한곳에서 너무 많이 접속했다", {status: 429});
      if (isRankedCode(code)) {
        const r = this.rooms.get(code);
        // 랭크전 방 코드는 매치메이커가 그 계정에 준 것만 쓸 수 있다. 코드를 부계정에 넘겨 둘이서 판을 돌리는 걸 막는다.
        if (!r?.ranked || !uid || !r.tickets.has(uid)) return new Response("랭크전은 랭크전 버튼으로만 들어간다", {status: 403});
      }
      this.admitting.set(code, [...(this.admitting.get(code) || []), {ip, at: now}]);
      return new Response(null, {status: 204});
    }

    if (url.pathname === "/stats") {
      let waiting = 0, playing = 0;
      for (const r of this.rooms.values()) {
        if (r.phase === "lobby") waiting += r.players; else playing += r.players;
      }
      return Response.json({online: waiting + playing, waiting, playing});
    }

    return new Response("not found", {status: 404});
  }
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map();   // id -> player
    this.phase = "lobby";       // lobby → starting(3·2·1) → playing → over
    this.code = null;
    this.auto = false;          // 빠른 시작 방이면 카운트다운으로 시작, 직접 판 방이면 방장이 시작
    this.ranked = false;        // 랭크전: 로그인한 사람만, 봇전 전환 없음, 끝나면 레이팅 반영
    this.departed = [];         // 게임 중에 나간 사람(순위·레이팅 계산에 넣는다)
    this.kicked = new Set();    // 방장이 내보낸 IP. 이 방이 빌 때까지 다시 못 들어온다
    this.host = null;
    this.startTimer = null;
    this.startAt = 0;           // 빠른 시작 마감 시각. 한 번 정하면 준비를 껐다 켜도 미뤄지지 않는다
    this.startFor = "";         // 지금 마감이 혼자 기다리는 중("solo")인지 둘 이상("lobby")인지
    this.idleTimer = null;
    this.closeTimer = null;
    this.loop = null;
    this.heart = null;
    this.elimAt = 0;
    this.playStartedAt = 0;
    this.lang = "ko";           // 첫 입장자의 언어로 정해진다
    // ponytail: 방 상태를 메모리에만 둔다. 게임이 몇 분 안에 끝나고 WebSocket이 붙어 있는
    // 동안 DO가 살아 있어서 지금은 충분하다. 재접속이나 Hibernation API를 쓰려면 storage로 옮겨야 한다.
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("not found", {status: 404});
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", {status: 426});
    }

    this.code = normCode(url.searchParams.get("room"));
    this.auto = isAutoCode(this.code);
    this.ranked = isRankedCode(this.code);
    const pair = new WebSocketPair();
    this.accept(pair[1], {
      name: (url.searchParams.get("name") || "익명").slice(0, 12),
      lang: url.searchParams.get("lang") === "en" ? "en" : "ko",
      uid: Number(url.searchParams.get("uid")) || null,   // 로그인 안 했으면 null
      ip: url.searchParams.get("ip") || ""
    });
    // 클라이언트가 서브프로토콜을 보냈으면 같은 값을 돌려줘야 브라우저가 연결을 받아들인다
    const headers = wsProtocols(request).includes(WS_PROTOCOL) ? {"Sec-WebSocket-Protocol": WS_PROTOCOL} : {};
    return new Response(null, {status: 101, webSocket: pair[0], headers});
  }

  accept(ws, {name, lang, uid, ip}) {
    ws.accept();

    if (this.phase !== "lobby") { this.kick(ws, "이미 시작한 방이다"); return; }
    if (this.players.size >= MAX_PLAYERS) { this.kick(ws, "방이 찼다"); return; }
    if (this.kicked.has(ip)) { this.kick(ws, "방장이 내보낸 방이다"); return; }
    if (this.ranked && !uid) { this.kick(ws, "랭크전은 로그인해야 한다"); return; }
    // 한 계정으로 탭 두 개 띄워서 자기끼리 붙는 걸 막는다
    if (this.ranked && [...this.players.values()].some(p => p.uid === uid)) { this.kick(ws, "이미 이 방에 들어와 있다"); return; }
    // 모르는 사람끼리 붙는 방이라 한 곳에서 방을 채우지 못하게 한다
    if (this.auto && [...this.players.values()].filter(p => p.ip === ip).length >= MAX_SAME_IP_PUBLIC) {
      this.kick(ws, "같은 곳에서 너무 많이 들어왔다"); return;
    }

    if (this.players.size === 0) {
      this.lang = lang;
      this.heart = setInterval(() => this.report(), HEARTBEAT_MS);
      // 시작하지 않는 대기방을 붙잡고 있으면 무료 한도(방이 살아 있는 시간)가 탄다
      this.idleTimer = setTimeout(() => { if (this.phase === "lobby") this.dropAll("대기 시간이 지났다"); },
        Number(this.env.LOBBY_IDLE_MS) || LOBBY_IDLE_MS);
    }
    const id = crypto.randomUUID().slice(0, 8);
    const player = {id, uid, ip, name, ws, acct: !!uid, done: 0, prog: 0, alive: true, rank: 0, aim: null,
                    ready: false, line: "", pos: 0, bad: false, dt: [],
                    lineStrokes: 0, progAt: 0, lastDoneAt: 0, doneLine: "", spent: 0, strikes: 0, suspect: false};
    this.players.set(id, player);
    if (!this.host) this.host = id;

    this.send(ws, {t: "joined", you: id, code: this.code, max: MAX_PLAYERS, lang: this.lang, auto: this.auto, host: this.host});
    this.broadcastPlayers();
    this.report();

    let windowAt = 0, count = 0, flooded = false;
    ws.addEventListener("message", e => {
      if (flooded) return;
      const now = Date.now();
      if (now - windowAt >= 1000) { windowAt = now; count = 0; }
      if (++count > MAX_BURST_MSGS) {
        // 끊겠다고 보내도 상대가 닫기 응답을 안 할 수 있어서 방에서 바로 뺀다
        flooded = true;
        this.kick(ws, "메시지를 너무 많이 보냈다");
        this.remove(id);
        return;
      }
      if (typeof e.data !== "string" || e.data.length > MAX_MSG_CHARS) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (count > MAX_MSGS_PER_SEC && ["prog", "aim"].includes(msg?.t)) return;
      if (msg && typeof msg === "object") this.onMessage(player, msg);
    });
    const drop = () => this.remove(id);
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);

    if (this.auto) {
      this.scheduleStart();
      if (this.startAt && this.players.has(id)) this.send(ws, {t: "countdown", sec: Math.ceil((this.startAt - Date.now()) / 1000), players: this.players.size});
    }
  }

  kick(ws, reason) {
    this.send(ws, {t: "denied", reason});
    try { ws.close(1000, reason); } catch {}
  }

  /* 남은 연결을 서버가 닫는다. 안 나가고 버티는 소켓이 방을 붙잡지 못하게 */
  dropAll(reason) {
    for (const [id, p] of [...this.players]) { this.kick(p.ws, reason); this.remove(id); }
  }

  remove(id) {
    const leaver = this.players.get(id);
    if (!leaver) return;
    if (this.phase === "playing" || this.phase === "starting") {
      // 게임 중에 나간 사람도 순위·레이팅 계산에 넣는다. 살아 있었으면 남은 사람 중 꼴찌로 친다.
      // (탈락하자마자 나가서 레이팅 손실을 피하는 것, 지고 있을 때 나가서 점수를 지키는 것을 막는다)
      if (leaver.alive) {
        leaver.rank = [...this.players.values()].filter(p => p.alive).length;
        leaver.alive = false;
      }
      this.departed.push(leaver);
    }
    this.players.delete(id);
    // 방장이 나가면 남은 사람 중 먼저 들어온 사람이 방장이 된다
    if (this.host === id) this.host = this.players.keys().next().value || null;
    // 마지막 사람이 나가면 방을 비운다. 안 그러면 끝난 방 코드가 계속 입장 거부한다.
    if (this.players.size === 0) { this.reset(); this.report(); return; }
    this.report();
    if (this.phase === "lobby") {
      this.broadcastPlayers();
      if (this.auto) this.scheduleStart();
      return;
    }
    // 게임 중(카운트다운 포함) 나가면 그 자리에서 탈락 처리한다
    this.broadcastPlayers();
    this.checkWinner();
  }

  /* 매치메이커에 인원·상태·IP별 연결 수를 알린다. 실패해도 게임에는 영향 없다. */
  report() {
    if (!this.code) return;
    const ips = {};
    for (const p of this.players.values()) ips[p.ip] = (ips[p.ip] || 0) + 1;
    matchmaker(this.env).fetch("https://mm/report", {
      method: "POST",
      body: JSON.stringify({code: this.code, auto: this.auto, ranked: this.ranked, lang: this.lang, phase: this.phase, players: this.players.size, ips})
    }).catch(() => {});
  }

  /* ---------- 로비 ---------- */
  /* 직접 판 방은 방장 빼고 전원, 빠른 시작 방은 전원이 준비해야 한다 */
  allReady() {
    return this.players.size >= MIN_PLAYERS &&
      [...this.players.values()].every(p => p.ready || (!this.auto && p.id === this.host));
  }

  /* 빠른 시작 방 전용. 직접 판 방은 방장이 시작 버튼을 누를 때까지 그대로 기다린다(대기방 시간 제한은 있다). */
  scheduleStart() {
    const n = this.players.size;
    if (n === 0) return;
    // 랭크전은 다 준비해도 바로 시작하지 않는다. 대기 시간 동안 매칭된 다른 사람이 들어올 수 있어야 짜고 치기 어렵다.
    if (n >= MAX_PLAYERS || (!this.ranked && this.allReady())) { this.start(); return; }

    const stage = n >= MIN_PLAYERS ? "lobby" : this.ranked ? "" : "solo";
    if (stage === this.startFor) return;   // 마감은 한 번 정하면 준비를 껐다 켜도 미루지 않는다
    clearTimeout(this.startTimer);
    this.startFor = stage;
    if (!stage) { this.startAt = 0; this.startTimer = null; return; }   // 랭크전 혼자: 상대가 올 때까지 기다린다

    const wait = stage === "lobby" ? LOBBY_WAIT_MS : SOLO_WAIT_MS;
    this.startAt = Date.now() + wait;
    this.broadcast({t: "countdown", sec: Math.round(wait / 1000), players: n});
    this.startTimer = setTimeout(() => {
      if (this.players.size >= MIN_PLAYERS) { this.start(); return; }
      // 끝까지 혼자면 봇전으로 돌려보낸다. 빈 방만 보고 나가는 것보다 낫다.
      this.broadcast({t: "solo"});
      this.dropAll("상대가 없다");
    }, wait);
  }

  reset() {
    clearTimeout(this.startTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.closeTimer);
    clearInterval(this.loop);
    if (this.players.size === 0) {
      clearInterval(this.heart);
      this.heart = null;
      this.host = null;
      this.kicked.clear();
    }
    this.startTimer = this.idleTimer = this.closeTimer = this.loop = null;
    this.startAt = 0;
    this.startFor = "";
    this.phase = "lobby";
    for (const p of this.players.values()) {
      Object.assign(p, {done: 0, prog: 0, alive: true, rank: 0, ready: false, line: "", pos: 0, bad: false, dt: [],
                        lineStrokes: 0, doneLine: "", spent: 0, strikes: 0, suspect: false});
    }
  }

  /* ---------- 게임 ---------- */
  start() {
    clearTimeout(this.startTimer);
    clearTimeout(this.idleTimer);
    this.startAt = 0;
    this.startFor = "";
    this.phase = "starting";
    this.startedWith = this.players.size;
    this.departed = [];
    this.playStartedAt = 0;   // 지난 판 값이 남으면 3·2·1 중에 끝난 판도 끝까지 한 판으로 친다
    this.broadcast({t: "start", countdown: COUNTDOWN_MS});
    this.report();
    this.startTimer = setTimeout(() => {
      this.phase = "playing";
      this.playStartedAt = Date.now();
      for (const p of this.players.values()) p.lastDoneAt = p.progAt = this.playStartedAt;
      this.elimAt = Date.now() + ELIM_MS;
      this.report();
      this.loop = setInterval(() => {
        if (Date.now() >= this.elimAt) {
          this.eliminate();
          this.elimAt = Date.now() + ELIM_MS;
        }
        this.broadcastPlayers();
      }, Math.round(1000 / STATE_HZ));
    }, COUNTDOWN_MS);
  }

  onMessage(p, msg) {
    if (msg.t === "prog") {
      if (this.phase !== "playing" || !p.alive) return;
      const now = Date.now();
      if (typeof msg.line === "string") {
        // 풀에 있는 문장(공격으로 망가진 것 포함)만 받는다. 아무 글이나 상대 화면에 띄우는 통로가 되지 않게.
        const line = msg.line.slice(0, MAX_LINE);
        if (!isPoolLine(line, this.lang)) return;
        if (line !== p.line) {
          p.line = line;
          p.lineStrokes = Math.max(strokes(line), minLineStrokes(this.lang));
          p.prog = 0;   // 새 문장이면 진행도를 처음부터
        }
        const words = line.split(" ").length;
        p.dt = Array.isArray(msg.dt) ? msg.dt.filter(i => Number.isInteger(i) && i >= 0 && i < words).slice(0, MAX_DIRTY) : [];
      }
      // 진행도는 사람이 칠 수 있는 속도 이상으로 오르지 못한다
      const lineStrokes = p.lineStrokes || minLineStrokes(this.lang);
      const cap = p.prog + (now - p.progAt) / 1000 * MAX_STROKES_PER_SEC / lineStrokes;
      p.progAt = now;
      p.prog = Math.max(0, Math.min(1, cap, +msg.prog || 0));
      p.pos = Math.max(0, Math.min(p.line.length, msg.pos | 0));
      p.bad = !!msg.bad;
      return;
    }
    if (msg.t === "aim") {
      p.aim = msg.id && this.players.has(msg.id) ? msg.id : null;
      return;
    }
    if (msg.t === "ready") {
      if (this.phase !== "lobby" || p.ready === !!msg.on) return;
      p.ready = !!msg.on;
      this.broadcastPlayers();
      if (this.auto) this.scheduleStart();
      return;
    }
    if (msg.t === "start") {
      if (!this.auto && p.id === this.host && this.phase === "lobby" && this.allReady()) this.start();
      return;
    }
    if (msg.t === "kick") {
      // 직접 판 방에서 방장이 모르는 사람을 내보낸다
      const target = this.players.get(msg.id);
      if (this.auto || p.id !== this.host || this.phase !== "lobby" || !target || target === p) return;
      this.kicked.add(target.ip);
      this.kick(target.ws, "방장이 내보냈다");
      this.remove(target.id);
      return;
    }
    if (msg.t === "done" && this.phase === "playing" && p.alive) {
      // 완료는 문장 하나에 한 번이다. 지금 치는 문장을 알려 준 적이 없거나 이미 끝낸 문장이면 무시한다.
      if (!p.line || p.line === p.doneLine) return;
      const now = Date.now();
      // 판이 시작된 뒤 끝낸 문장들의 타수를 다 더해서 사람 속도 안인지 본다. 렉으로 신고가 몰려 와도 걸리지 않는다.
      if (!withinHumanPace(p.spent + p.lineStrokes, now - this.playStartedAt)) {
        p.strikes++;
        if (p.strikes >= SUSPECT_STRIKES && !p.suspect) {
          p.suspect = true;
          console.warn("too-fast completions; ranked as last and no coins:", this.code, p.id, p.uid, p.name);
        }
        return;
      }
      p.spent += p.lineStrokes;
      p.doneLine = p.line;
      p.done++;
      // 빠르기는 서버 시계로 잰다. 불붙음은 서버가 못 보는 값이라 상한만 둔다.
      const fast = now - p.lastDoneAt < FAST_MS;
      p.lastDoneAt = now;
      const shots = (fast ? 2 : 1) + Math.max(0, Math.min(MAX_FIRE_BONUS, msg.fire | 0));
      for (let i = 0; i < shots; i++) this.fire(p);
    }
  }

  fire(from) {
    const foes = [...this.players.values()].filter(p => p.alive && p !== from);
    if (!foes.length) return;
    let target = from.aim ? foes.find(p => p.id === from.aim) : null;
    if (!target) {
      target = Math.random() < 0.45
        ? foes.reduce((a, b) => (b.done * 1000 + b.prog > a.done * 1000 + a.prog ? b : a))
        : foes[Math.floor(Math.random() * foes.length)];
    }
    const kind = KINDS[Math.floor(Math.random() * KINDS.length)];
    this.send(target.ws, {t: "atk", from: from.name, kind});
    this.send(from.ws, {t: "sent", to: target.name, toId: target.id, kind});
  }

  eliminate() {
    const alive = [...this.players.values()].filter(p => p.alive);
    if (alive.length <= 1) return;
    const loser = alive.reduce((a, b) => (b.done * 1000 + b.prog < a.done * 1000 + a.prog ? b : a));
    loser.alive = false;
    loser.rank = alive.length;
    this.broadcast({t: "out", id: loser.id, name: loser.name, rank: loser.rank});
    this.send(loser.ws, {t: "end", rank: loser.rank, win: false});
    this.checkWinner();
  }

  checkWinner() {
    const alive = [...this.players.values()].filter(p => p.alive);
    if ((this.phase !== "playing" && this.phase !== "starting") || alive.length > 1) return;
    if (alive.length === 1) {
      alive[0].rank = 1;
      this.send(alive[0].ws, {t: "end", rank: 1, win: true});
    }
    this.phase = "over";
    clearTimeout(this.startTimer);
    clearInterval(this.loop);
    this.loop = null;
    // 관전 중인 사람도 최종 순위를 받아야 해서 순위를 한 번 더 뿌린 뒤 우승자를 알린다
    this.broadcastPlayers();
    if (alive.length === 1) this.broadcast({t: "winner", id: alive[0].id, name: alive[0].name});
    this.report();
    this.payout();
    this.closeTimer = setTimeout(() => this.dropAll("판이 끝났다"), OVER_CLOSE_MS);
  }

  /* 끝난 판의 레이팅·코인을 정산한다. 게임 중에 나간 사람도 넣는다. */
  async payout() {
    // 3·2·1 중에 끝난 판은 코인이 없다. 랭크전은 그때 나간 사람만 잃는다(판 피하기 방지).
    if (!this.playStartedAt && !this.ranked) return;
    const fullGame = !!this.playStartedAt && Date.now() - this.playStartedAt >= ELIM_MS;
    const everyone = [...this.players.values(), ...this.departed];
    try {
      if (this.ranked) {
        // 속도 검사에 걸린 사람은 빼지 않고 꼴찌로 친다. 빼 주면 지고 있을 때 일부러 걸려서 점수를 지킨다.
        // 너무 짧게 끝난 판(부계정이 들어왔다 바로 나감)은 잃는 쪽만 반영하고 얻는 사람은 없다.
        const last = this.startedWith + 1;
        const entries = everyone.filter(p => p.uid && (p.rank || p.suspect))
          .map(p => ({uid: p.uid, ip: p.ip, rank: p.suspect ? last : p.rank}));
        const response = await matchmaker(this.env).fetch("https://mm/ratings", {
          method: "POST", body: JSON.stringify({entries, onlyLosses: !fullGame})
        });
        if (!response.ok) throw new Error("rank settlement failed: " + response.status);
        const ratings = new Map(await response.json());
        for (const p of this.players.values()) {
          const r = p.uid && ratings.get(p.uid);
          if (r) this.send(p.ws, {t: "rating", ...r});
        }
      }
      if (!fullGame) return;
      // 보상은 실제로 문장을 친 사람 수로 계산한다. 가만히 있는 게스트를 채워 판을 부풀리는 걸 막는다.
      const played = everyone.filter(p => p.done > 0).length;
      if (played < MIN_PLAYERS) return;
      const results = everyone.filter(p => p.uid && p.rank && p.done > 0 && !p.suspect)
        .map(p => ({uid: p.uid, rank: p.rank, players: played}));
      if (!results.length) return;
      const granted = await grantRewards(this.env, results);
      for (const p of this.players.values()) {
        const g = p.uid && granted.get(p.uid);
        if (g) this.send(p.ws, {t: "reward", coins: g.coins, total: g.total, capped: g.capped});
      }
    } catch (e) {
      console.error("payout failed:", e);
    }
  }

  /* ---------- 전송 ---------- */
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj) { for (const p of this.players.values()) this.send(p.ws, obj); }
  broadcastPlayers() {
    const list = [...this.players.values()].map(({id, name, acct, done, prog, alive, rank, ready, line, pos, bad, dt}) =>
      ({id, name, acct, done, prog, alive, rank, ready, line, pos, bad, dt}));
    const elimIn = this.phase === "playing" ? Math.max(0, this.elimAt - Date.now()) : 0;
    this.broadcast({t: "players", players: list, elimIn, phase: this.phase, host: this.host, auto: this.auto});
  }
}
