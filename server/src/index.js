/**
 * 타자 배틀로얄 실시간 서버.
 *
 * 방 하나가 Durable Object 인스턴스 하나다. 끄투가 Node 게임서버 메모리에 방 객체를
 * 들고 있는 것과 같은 구조인데, 프로세스를 우리가 관리하지 않는다는 점만 다르다.
 *
 * 서버는 심판만 본다. 문장 생성과 오염은 각 클라이언트가 자기 화면에서 처리하고,
 * 서버는 진행도를 모아 순위를 매기고 탈락을 선고하며 공격을 중계한다.
 * 각자 치고 있는 문장과 커서 위치도 받아서 다른 사람 화면(상대 카드·관전)에 뿌린다.
 *
 * 빠른 시작은 Matchmaker(전역 DO 하나)가 대기 중인 방 중 사람이 가장 많은 곳으로 보낸다.
 * 계정·카카오 로그인은 auth.js, 코인·상점·스킨은 shop.js, 랭크전 레이팅은 rank.js(모두 D1)가 맡는다.
 * 사람이 칠 수 없는 속도의 완료 신고는 anticheat.js 기준으로 걸러낸다.
 */

import {handleAuth, userFromToken, cleanNick} from "./auth.js";
import {handleShop, grantRewards} from "./shop.js";
import {handleRank, applyRatings} from "./rank.js";
import {strokes, minSentenceMs, MAX_STROKES_PER_SEC, SUSPECT_STRIKES} from "./anticheat.js";

const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const LOBBY_WAIT_MS = 20000;    // 빠른 시작: 두 번째 사람이 들어온 뒤 이만큼 더 기다렸다가 시작
const SOLO_WAIT_MS = 20000;     // 빠른 시작: 혼자면 이만큼 기다렸다가 봇전으로 돌려보낸다
const COUNTDOWN_MS = 3000;      // 시작 신호 뒤 3·2·1 동안은 입력도 판정도 하지 않는다
const ELIM_MS = 20000;          // 탈락 주기
const STATE_HZ = 5;             // 진행도 브로드캐스트 빈도
const HEARTBEAT_MS = 30000;     // 방이 살아 있다고 매치메이커에 알리는 주기
const ROOM_STALE_MS = 75000;    // 이만큼 소식 없는 방은 매치메이커 목록에서 지운다
const MAX_FIRE_BONUS = 2;       // 불붙음으로 늘어나는 공격 수 상한
const MAX_LINE = 160;           // 중계하는 문장 길이 상한(신조어가 다 박혀도 이보다 짧다)
const MAX_DIRTY = 40;
const KINDS = ["anagram", "insert", "reorder"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // 헷갈리는 I,O,0,1 제외
const MAX_MSGS_PER_SEC = 20;    // 클라이언트는 초당 5번쯤 보낸다. 넘치는 건 버린다
const FLOOD_KICK_PER_SEC = 60;  // 이만큼 쏟아내면 끊는다(준비 연타로 방 전체 브로드캐스트를 폭주시키는 걸 막는다)
const MAX_MSG_CHARS = 2048;
const WS_PROTOCOL = "tr.v1";
const WS_AUTH_PREFIX = "auth."; // 로그인 토큰은 주소 대신 서브프로토콜 헤더로 받는다. 주소는 로그에 남는다.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {status, headers: {...CORS, "Content-Type": "application/json"}});

const randomCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), b => CODE_CHARS[b % CODE_CHARS.length]).join("");

/* 방 코드는 대소문자를 가리지 않고, 링크로 돌려도 깨지지 않게 정규화한다 */
const normCode = raw => (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
const isAutoCode = code => code.startsWith("AUTO") || code.startsWith("RANK");   // 빠른 시작·랭크전은 카운트다운으로 시작
const isRankedCode = code => code.startsWith("RANK");
const matchmaker = env => env.MATCH.get(env.MATCH.idFromName("global"));
const wsProtocols = request => (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(s => s.trim());

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, {headers: CORS});

    const authResponse = await handleAuth(request, env, url, json);
    if (authResponse) return authResponse;

    if (url.pathname.startsWith("/shop")) {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "") || null;
      const shopResponse = await handleShop(request, env, url, json, await userFromToken(env, token));
      if (shopResponse) return shopResponse;
    }

    const rankResponse = await handleRank(request, env, url, json);
    if (rankResponse) return rankResponse;

    if (url.pathname === "/join") {
      const lang = url.searchParams.get("lang") === "en" ? "en" : "ko";
      const ranked = url.searchParams.get("ranked") === "1" ? "&ranked=1" : "";
      const r = await matchmaker(env).fetch("https://mm/join?lang=" + lang + ranked);
      return json(await r.json());
    }

    if (url.pathname === "/stats") {
      const r = await matchmaker(env).fetch("https://mm/stats");
      return json(await r.json());
    }

    if (url.pathname === "/new") return json({code: randomCode()});

    if (url.pathname === "/ws") {
      const code = normCode(url.searchParams.get("room"));
      if (!code) return json({error: "room code required"}, 400);
      // 랭크전 방은 매치메이커가 만든 것만 들어간다. 코드를 지어내서 부계정끼리 비공개 랭크전을 돌리는 걸 막는다.
      if (isRankedCode(code) && !(await matchmaker(env).fetch("https://mm/issued?code=" + code)).ok) {
        return json({error: "없는 랭크전 방이다"}, 403);
      }
      // 로그인한 사람이면 계정 id와 닉네임을 방에 넘긴다. 클라이언트가 보낸 uid·token 쿼리는 믿지 않고 지운다.
      const params = new URLSearchParams(url.searchParams);
      const token = wsProtocols(request).find(p => p.startsWith(WS_AUTH_PREFIX))?.slice(WS_AUTH_PREFIX.length);
      const user = await userFromToken(env, token);
      params.delete("token"); params.delete("uid");
      params.set("name", user ? user.nickname : cleanNick(params.get("name")) || "익명");
      if (user) params.set("uid", String(user.id));
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      return room.fetch(new Request("https://room/ws?" + params, request));
    }

    return json({ok: true, service: "typing-royale"});
  }
};

/* 모든 방의 인원·상태를 모아 두고, 빠른 시작을 누른 사람을 가장 붐비는 대기방으로 보낸다.
   예전에는 45초 단위 시간대로 방을 나눠서, 거의 동시에 눌러도 경계에 걸리면 서로 다른 방에 떨어졌다. */
export class Matchmaker {
  constructor() {
    this.rooms = new Map();   // code -> {auto, lang, phase, players, at}
  }

  async fetch(request) {
    const url = new URL(request.url), now = Date.now();
    for (const [code, r] of this.rooms) if (now - r.at > ROOM_STALE_MS) this.rooms.delete(code);

    if (url.pathname === "/report") {
      const r = await request.json();
      if (!r.players) this.rooms.delete(r.code);
      else this.rooms.set(r.code, {auto: r.auto, ranked: r.ranked, lang: r.lang, phase: r.phase, players: r.players, at: now});
      return new Response("ok");
    }

    if (url.pathname === "/join") {
      const lang = url.searchParams.get("lang") === "en" ? "en" : "ko";
      const ranked = url.searchParams.get("ranked") === "1";   // 랭크전과 일반 빠른 시작은 대기열이 따로다
      let best = null;
      for (const [code, r] of this.rooms) {
        if (!r.auto || !!r.ranked !== ranked || r.lang !== lang || r.phase !== "lobby" || r.players >= MAX_PLAYERS) continue;
        if (!best || r.players > this.rooms.get(best).players) best = code;
      }
      if (best) {
        this.rooms.get(best).players++;   // 곧 들어올 사람 자리를 미리 잡아 둔다. 방이 보고하면 실제 값으로 덮인다.
        return Response.json({code: best});
      }
      const code = (ranked ? "RANK" : "AUTO") + (lang === "en" ? "EN" : "") + randomCode();
      this.rooms.set(code, {auto: true, ranked, lang, phase: "lobby", players: 1, at: now});
      return Response.json({code});
    }

    if (url.pathname === "/issued") {
      return new Response(null, {status: this.rooms.get(url.searchParams.get("code"))?.ranked ? 204 : 404});
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
    this.departed = [];         // 게임 중에 나간 사람(랭크전 레이팅 계산에 넣는다)
    this.host = null;
    this.startTimer = null;
    this.loop = null;
    this.heart = null;
    this.elimAt = 0;
    this.lang = "ko";           // 첫 입장자의 언어로 정해진다
    // ponytail: 방 상태를 메모리에만 둔다. 게임이 2분 안에 끝나고 WebSocket이 붙어 있는
    // 동안 DO가 살아 있어서 지금은 충분하다. 재접속을 지원하려면 storage로 옮겨야 한다.
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
    const name = (url.searchParams.get("name") || "익명").slice(0, 12);
    const lang = url.searchParams.get("lang") === "en" ? "en" : "ko";
    const uid = Number(url.searchParams.get("uid")) || null;   // 로그인 안 했으면 null
    const pair = new WebSocketPair();
    this.accept(pair[1], name, lang, uid);
    // 클라이언트가 서브프로토콜을 보냈으면 같은 값을 돌려줘야 브라우저가 연결을 받아들인다
    const headers = wsProtocols(request).includes(WS_PROTOCOL) ? {"Sec-WebSocket-Protocol": WS_PROTOCOL} : {};
    return new Response(null, {status: 101, webSocket: pair[0], headers});
  }

  accept(ws, name, lang, uid) {
    ws.accept();

    if (this.phase !== "lobby") { this.kick(ws, "이미 시작한 방이다"); return; }
    if (this.players.size >= MAX_PLAYERS) { this.kick(ws, "방이 찼다"); return; }
    if (this.ranked && !uid) { this.kick(ws, "랭크전은 로그인해야 한다"); return; }
    // 한 계정으로 탭 두 개 띄워서 자기끼리 붙는 걸 막는다
    if (this.ranked && [...this.players.values()].some(p => p.uid === uid)) { this.kick(ws, "이미 이 방에 들어와 있다"); return; }

    if (this.players.size === 0) {
      this.lang = lang;
      this.heart = setInterval(() => this.report(), HEARTBEAT_MS);
    }
    const id = crypto.randomUUID().slice(0, 8);
    const player = {id, uid, name, ws, done: 0, prog: 0, alive: true, rank: 0, aim: null,
                    ready: false, line: "", pos: 0, bad: false, dt: [],
                    lineStrokes: 0, progAt: 0, lastDoneAt: 0, strikes: 0, suspect: false};
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
      if (++count > MAX_MSGS_PER_SEC) {
        // 끊겠다고 보내도 상대가 닫기 응답을 안 할 수 있어서 방에서 바로 뺀다
        if (count >= FLOOD_KICK_PER_SEC) { flooded = true; this.kick(ws, "메시지를 너무 많이 보냈다"); this.remove(id); }
        return;
      }
      if (typeof e.data !== "string" || e.data.length > MAX_MSG_CHARS) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(player, msg);
    });
    const drop = () => this.remove(id);
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);

    if (this.auto) this.scheduleStart();
  }

  kick(ws, reason) {
    this.send(ws, {t: "denied", reason});
    try { ws.close(1000, reason); } catch {}
  }

  remove(id) {
    const leaver = this.players.get(id);
    if (!leaver) return;
    if ((this.phase === "playing" || this.phase === "starting") && leaver.alive) {
      // 게임 중에 나가면 남은 사람 중 꼴찌로 친다. 랭크전에서 지고 있을 때 나가서 점수를 지키는 걸 막는다.
      leaver.rank = [...this.players.values()].filter(p => p.alive).length;
      leaver.alive = false;
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

  /* 매치메이커에 인원·상태를 알린다. 실패해도 게임에는 영향 없다. */
  report() {
    if (!this.code) return;
    matchmaker(this.env).fetch("https://mm/report", {
      method: "POST",
      body: JSON.stringify({code: this.code, auto: this.auto, ranked: this.ranked, lang: this.lang, phase: this.phase, players: this.players.size})
    }).catch(() => {});
  }

  /* ---------- 로비 ---------- */
  /* 직접 판 방은 방장 빼고 전원, 빠른 시작 방은 전원이 준비해야 한다 */
  allReady() {
    return this.players.size >= MIN_PLAYERS &&
      [...this.players.values()].every(p => p.ready || (!this.auto && p.id === this.host));
  }

  /* 빠른 시작 방 전용. 직접 판 방은 방장이 시작 버튼을 누를 때까지 그대로 기다린다. */
  scheduleStart() {
    clearTimeout(this.startTimer);
    const n = this.players.size;
    if (n === 0) return;

    if (n >= MAX_PLAYERS || this.allReady()) { this.start(); return; }
    if (this.ranked && n < MIN_PLAYERS) return;   // 랭크전은 봇전으로 넘기지 않고 상대가 올 때까지 기다린다

    const wait = n >= MIN_PLAYERS ? LOBBY_WAIT_MS : SOLO_WAIT_MS;
    this.broadcast({t: "countdown", sec: Math.round(wait / 1000), players: n});
    this.startTimer = setTimeout(() => {
      // 끝까지 혼자면 봇전으로 돌려보낸다. 빈 방만 보고 나가는 것보다 낫다.
      if (this.players.size < MIN_PLAYERS) {
        this.broadcast({t: "solo"});
        this.reset();
      } else {
        this.start();
      }
    }, wait);
  }

  reset() {
    clearTimeout(this.startTimer);
    clearInterval(this.loop);
    if (this.players.size === 0) {
      clearInterval(this.heart);
      this.heart = null;
      this.host = null;
    }
    this.startTimer = this.loop = null;
    this.phase = "lobby";
    for (const p of this.players.values()) {
      Object.assign(p, {done: 0, prog: 0, alive: true, rank: 0, ready: false, line: "", pos: 0, bad: false, dt: []});
    }
  }

  /* ---------- 게임 ---------- */
  start() {
    clearTimeout(this.startTimer);
    this.phase = "starting";
    this.startedWith = this.players.size;   // 코인 계산용: 시작할 때 몇 명이었나
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
      // 클라이언트 자기 신고다. 완료 수는 서버가 done 메시지로 직접 세고, 여기서는 받지 않는다.
      const now = Date.now();
      if (typeof msg.line === "string") {
        const line = msg.line.slice(0, MAX_LINE);
        if (line !== p.line) { p.line = line; p.lineStrokes = strokes(line); p.prog = 0; }   // 새 문장이면 진행도를 처음부터
        p.dt = Array.isArray(msg.dt) ? msg.dt.filter(Number.isInteger).slice(0, MAX_DIRTY) : [];
      }
      // 진행도는 사람이 칠 수 있는 속도 이상으로 오르지 못한다
      const cap = p.prog + (p.progAt ? (now - p.progAt) / 1000 : 0) * MAX_STROKES_PER_SEC / Math.max(1, p.lineStrokes);
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
      if (this.phase !== "lobby") return;
      p.ready = !!msg.on;
      this.broadcastPlayers();
      if (this.auto) this.scheduleStart();
      return;
    }
    if (msg.t === "start") {
      if (!this.auto && p.id === this.host && this.phase === "lobby" && this.allReady()) this.start();
      return;
    }
    if (msg.t === "done" && this.phase === "playing" && p.alive) {
      // 공격 종류와 발수는 서버가 정한다. 클라이언트가 고르게 두면 제일 아픈 것만 고른다.
      // 불붙음 보너스는 클라이언트 신고라 상한을 둔다.
      const now = Date.now();
      if (now - p.lastDoneAt < minSentenceMs(p.lineStrokes)) {
        // 사람이 칠 수 없는 속도의 완료는 공격도 순위도 인정하지 않는다
        p.strikes++;
        if (p.strikes >= SUSPECT_STRIKES && !p.suspect) {
          p.suspect = true;
          console.warn("too-fast completions; excluding from rewards:", this.code, p.id, p.uid);
        }
        return;
      }
      p.lastDoneAt = now;
      p.done++;
      const fast = +msg.ms > 0 && +msg.ms < 12000;
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
  }

  /* 끝난 판의 코인을 준다. 로그인했고, 문장을 하나라도 완성했고, 탈락 판정이 한 번은 돈 판만 준다.
     (친구 계정으로 들어왔다 바로 나가서 우승을 챙기는 파밍을 막는다) */
  async payout() {
    if (!this.playStartedAt) return;   // 3·2·1 중에 끝난 판은 아무것도 안 준다
    const fullGame = Date.now() - this.playStartedAt >= ELIM_MS;
    try {
      // 랭크전 레이팅: 나간 사람도 포함한다. 속도 검사에 걸린 사람은 뺀다.
      // 너무 짧게 끝난 판(부계정이 들어왔다 바로 나감)은 나간 쪽 손실만 반영하고 남은 사람은 못 얻는다.
      if (this.ranked) {
        const entries = [...this.players.values(), ...this.departed]
          .filter(p => p.uid && p.rank && !p.suspect)
          .map(p => ({uid: p.uid, rank: p.rank}));
        const ratings = await applyRatings(this.env, entries, {onlyLosses: !fullGame});
        for (const p of this.players.values()) {
          const r = p.uid && ratings.get(p.uid);
          if (r) this.send(p.ws, {t: "rating", ...r});
        }
      }
      if (!fullGame) return;
      const results = [...this.players.values()]
        .filter(p => p.uid && p.rank && p.done > 0 && !p.suspect)
        .map(p => ({uid: p.uid, rank: p.rank, players: this.startedWith}));
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
    const list = [...this.players.values()].map(({id, name, done, prog, alive, rank, ready, line, pos, bad, dt}) =>
      ({id, name, done, prog, alive, rank, ready, line, pos, bad, dt}));
    const elimIn = this.phase === "playing" ? Math.max(0, this.elimAt - Date.now()) : 0;
    this.broadcast({t: "players", players: list, elimIn, phase: this.phase, host: this.host, auto: this.auto});
  }
}
