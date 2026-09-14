/**
 * 타자 배틀로얄 실시간 서버.
 *
 * 방 하나가 Durable Object 인스턴스 하나다. 끄투가 Node 게임서버 메모리에 방 객체를
 * 들고 있는 것과 같은 구조인데, 프로세스를 우리가 관리하지 않는다는 점만 다르다.
 *
 * 서버는 심판만 본다. 문장 생성과 오염은 각 클라이언트가 자기 화면에서 처리하고,
 * 서버는 진행도를 모아 순위를 매기고 탈락을 선고하며 공격을 중계한다.
 */

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const LOBBY_WAIT_MS = 20000;   // 두 번째 사람이 들어온 뒤 이만큼 더 기다렸다가 시작
const SOLO_WAIT_MS = 20000;    // 혼자면 이만큼 기다렸다가 봇전으로 돌려보낸다
const ELIM_MS = 20000;         // 탈락 주기
const STATE_HZ = 5;            // 진행도 브로드캐스트 빈도
const AUTO_BUCKET_MS = 45000;  // 자동 매칭은 같은 시간대에 누른 사람끼리 묶는다
const KINDS = ["anagram", "insert", "reorder"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // 헷갈리는 I,O,0,1 제외

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {status, headers: {...CORS, "Content-Type": "application/json"}});

const randomCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), b => CODE_CHARS[b % CODE_CHARS.length]).join("");

/* 방 코드는 대소문자를 가리지 않고, 링크로 돌려도 깨지지 않게 정규화한다.
   자동 매칭 코드(AUTOEN12345)까지 담아야 해서 16자. 8자로 자르면 버킷 10개가 한 방으로 뭉쳐서
   /join이 빈 방이라고 확인한 방과 실제로 들어가는 방이 달라진다. */
const normCode = raw => (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, {headers: CORS});

    // 자동 매칭: 같은 시간 버킷의 방을 묻고, 이미 시작했으면 다음 버킷으로 넘어간다
    if (url.pathname === "/join") {
      // 한타·영타는 서로 다른 대기열로 묶는다
      const lang = url.searchParams.get("lang") === "en" ? "EN" : "";
      const bucket = Math.floor(Date.now() / AUTO_BUCKET_MS);
      for (let i = 0; i < 3; i++) {
        const code = normCode("AUTO" + lang + ((bucket + i) % 100000));
        const room = env.ROOM.get(env.ROOM.idFromName(code));
        const open = await room.fetch("https://room/open").then(r => r.json());
        if (open.joinable) return json({code});
      }
      return json({code: normCode("AUTO" + lang + ((bucket + 3) % 100000))});
    }

    if (url.pathname === "/new") return json({code: randomCode()});

    if (url.pathname === "/ws") {
      const code = normCode(url.searchParams.get("room"));
      if (!code) return json({error: "room code required"}, 400);
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      return room.fetch(new Request("https://room/ws?" + url.searchParams, request));
    }

    return json({ok: true, service: "typing-royale"});
  }
};

export class Room {
  constructor(state) {
    this.state = state;
    this.players = new Map();   // id -> player
    this.phase = "lobby";
    this.code = null;
    this.startTimer = null;
    this.loop = null;
    this.elimAt = 0;
    this.lang = "ko";           // 첫 입장자의 언어로 정해진다
    // ponytail: 방 상태를 메모리에만 둔다. 게임이 2분 안에 끝나고 WebSocket이 붙어 있는
    // 동안 DO가 살아 있어서 지금은 충분하다. 재접속을 지원하려면 storage로 옮겨야 한다.
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/open") {
      return Response.json({
        joinable: this.phase === "lobby" && this.players.size < MAX_PLAYERS,
        players: this.players.size
      });
    }

    if (url.pathname !== "/ws") return new Response("not found", {status: 404});
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", {status: 426});
    }

    this.code = normCode(url.searchParams.get("room"));
    const name = (url.searchParams.get("name") || "익명").slice(0, 12);
    const lang = url.searchParams.get("lang") === "en" ? "en" : "ko";
    const pair = new WebSocketPair();
    this.accept(pair[1], name, lang);
    return new Response(null, {status: 101, webSocket: pair[0]});
  }

  accept(ws, name, lang) {
    ws.accept();

    if (this.phase !== "lobby") { this.kick(ws, "이미 시작한 방이다"); return; }
    if (this.players.size >= MAX_PLAYERS) { this.kick(ws, "방이 찼다"); return; }

    if (this.players.size === 0) this.lang = lang;
    const id = crypto.randomUUID().slice(0, 8);
    const player = {id, name, ws, done: 0, prog: 0, alive: true, rank: 0, aim: null};
    this.players.set(id, player);

    this.send(ws, {t: "joined", you: id, code: this.code, max: MAX_PLAYERS, lang: this.lang});
    this.broadcastPlayers();

    ws.addEventListener("message", e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(player, msg);
    });
    const drop = () => this.remove(id);
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);

    this.scheduleStart();
  }

  kick(ws, reason) {
    this.send(ws, {t: "denied", reason});
    try { ws.close(1000, reason); } catch {}
  }

  remove(id) {
    if (!this.players.delete(id)) return;
    // 마지막 사람이 나가면 방을 비운다. 안 그러면 끝난 방 코드가 계속 입장 거부한다.
    if (this.players.size === 0) { this.reset(); return; }
    if (this.phase === "lobby") { this.broadcastPlayers(); this.scheduleStart(); return; }
    // 게임 중 나가면 그 자리에서 탈락 처리한다
    this.broadcastPlayers();
    this.checkWinner();
  }

  /* ---------- 로비 ---------- */
  scheduleStart() {
    clearTimeout(this.startTimer);
    const n = this.players.size;
    if (n === 0) return;

    if (n >= MAX_PLAYERS) { this.start(); return; }

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
    this.startTimer = this.loop = null;
    this.phase = "lobby";
    for (const p of this.players.values()) { p.done = 0; p.prog = 0; p.alive = true; p.rank = 0; }
  }

  /* ---------- 게임 ---------- */
  start() {
    clearTimeout(this.startTimer);
    this.phase = "playing";
    this.elimAt = Date.now() + ELIM_MS;
    this.broadcast({t: "start", elimIn: ELIM_MS});

    this.loop = setInterval(() => {
      if (Date.now() >= this.elimAt) {
        this.eliminate();
        this.elimAt = Date.now() + ELIM_MS;
      }
      this.broadcastPlayers();
    }, Math.round(1000 / STATE_HZ));
  }

  onMessage(p, msg) {
    if (msg.t === "prog") {
      // 클라이언트 자기 신고다. 순위에만 쓰고 범위만 막아 둔다.
      p.done = Math.max(0, Math.min(9999, msg.done | 0));
      p.prog = Math.max(0, Math.min(1, +msg.prog || 0));
      return;
    }
    if (msg.t === "aim") {
      p.aim = msg.id && this.players.has(msg.id) ? msg.id : null;
      return;
    }
    if (msg.t === "done" && this.phase === "playing" && p.alive) {
      // 공격 종류와 발수는 서버가 정한다. 클라이언트가 고르게 두면 제일 아픈 것만 고른다.
      const fast = +msg.ms > 0 && +msg.ms < 12000;
      for (let i = 0; i < (fast ? 2 : 1); i++) this.fire(p);
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
    this.send(from.ws, {t: "sent", to: target.name, kind});
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
    if (this.phase !== "playing" || alive.length > 1) return;
    if (alive.length === 1) {
      alive[0].rank = 1;
      this.send(alive[0].ws, {t: "end", rank: 1, win: true});
      this.broadcast({t: "winner", id: alive[0].id, name: alive[0].name});
    }
    this.phase = "over";
    clearInterval(this.loop);
    this.loop = null;
  }

  /* ---------- 전송 ---------- */
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj) { for (const p of this.players.values()) this.send(p.ws, obj); }
  broadcastPlayers() {
    const list = [...this.players.values()]
      .map(({id, name, done, prog, alive, rank}) => ({id, name, done, prog, alive, rank}));
    const elimIn = this.phase === "playing" ? Math.max(0, this.elimAt - Date.now()) : 0;
    this.broadcast({t: "players", players: list, elimIn, phase: this.phase});
  }
}
