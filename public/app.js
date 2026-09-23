"use strict";

const POOL_KO = TR_POOL.ko, POOL_EN = TR_POOL.en;   // pool.js

/* ===================== 유틸 ===================== */
const $ = s => document.querySelector(s);
const app = $("#app");
const rnd = n => Math.floor(Math.random()*n);
const pick = a => a[rnd(a.length)];
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");   // 속성값에도 쓴다
/* 시크릿 모드·샌드박스 iframe·data: URL에서는 localStorage 접근 자체가 throw한다 */
const lsGet = (k, d="") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/, LATIN = /[A-Za-z]/;

/* 두벌식 자판에서 누르는 키 순서로 푼다. 겹모음(ㅘ)·겹받침(ㄺ)은 두 키다.
   타수 계산과, 조합 중인 글자가 목표의 올바른 앞부분인지(갇 → 가다) 판정에 같이 쓴다. */
const {keys, strokes, firstWrong, MAX_HITS, SAFE_WORDS, makeLine, lineText, wordAt, corrupt, ATTACK_NAMES, unpackLine} = TR_COMBAT;

/* 한글 한 글자는 두벌식으로 평균 2.4타, 영문은 1타. 봇 속도와 2연타 판정을 언어와 무관하게 타수로 맞춘다. */
const KO_STROKES_PER_CHAR = 2.4;
const FAST_STROKES_PER_SEC = 6.2;   // 이보다 빠르게 문장을 끝내면 공격 2발
const strokesPerChar = () => CFG.lang === "en" ? 1 : KO_STROKES_PER_CHAR;
const sentences = () => CFG.lang === "en" ? POOL_EN : POOL_KO;

/* ===================== 문장 & 공격 ===================== */
// 타자·공격 규칙은 combat.js에서 공유한다.

/* ===================== 플레이어 ===================== */
let G = null;

class Player{
  constructor(id, name, bot){
    this.id = id; this.name = name; this.bot = bot;
    this.queue = []; this.idx = 0;
    this.typed = ""; this.locked = 0; this.done = 0; this.alive = true; this.rank = 0;
    this.strokes = 0; this.keys = 0; this.streak = 0;
    this.startedAt = 0; this.cps = 0; this.pauseUntil = 0; this.lastChar = 0;
    this.fill();
  }
  fill(){
    while (this.queue.length < this.idx + 4){
      let t, guard = 0;
      do { t = pick(sentences()); guard++; }
      while (guard < 8 && this.queue.slice(-3).some(l => l.src === t.text));
      this.queue.push(makeLine(t));
    }
  }
  get line(){ return this.queue[this.idx]; }
  get text(){ return lineText(this.line); }
  get progress(){ return Math.min(1, this.typed.length / this.text.length); }
  get score(){ return this.done * 1000 + this.progress * 999; }
  /* 아직 안 친 구간에 박혀 있는 공격 수 */
  get incoming(){
    let n = this.line.hits;
    for (let i = this.idx + 1; i <= this.idx + 3; i++) n += this.queue[i] ? this.queue[i].hits : 0;
    return n;
  }

  /* 1순위는 지금 치는 문장. 단 커서에서 SAFE_WORDS 어절 뒤부터만 건드린다(친 부분 불가침).
     한 문장이 MAX_HITS를 넘으면 다음 문장으로 밀어 넣는다. */
  hit(kind, from){
    this.fill();
    const cur = this.line;
    const safe = wordAt(cur, this.typed.length) + SAFE_WORDS;
    const slots = [];
    if (safe < cur.words.length) slots.push([cur, safe]);
    for (let i = this.idx + 1; i <= this.idx + 3; i++) slots.push([this.queue[i], 0]);

    let applied = null, where = null;
    for (const [l,min] of slots){ if (l.hits < MAX_HITS && (applied = corrupt(l, min, kind))){ where = l; break; } }
    if (!applied) for (const [l,min] of slots){ if ((applied = corrupt(l, min, kind))){ where = l; break; } }
    if (!applied) return null;

    feed(`${from.name} → ${this.name} · ${ATTACK_NAMES[applied]}`, this === G.me ? "dmg" : "");
    if (this === G.me){
      SFX.hit();
      // 치는 중인 문장이 맞으면 더 세게 흔든다
      const big = where === cur;
      bump("#app", big ? "jolt-big" : "jolt");
      bump("#board", "flash");
      navigator.vibrate?.(big ? 90 : 40);
      toast(ATTACK_NAMES[applied] + (where === cur ? " · 치는 중인 문장!" : ""), "atk");
      if (where === cur) G.rebuild = true;
    } else {
      bump("#foe-" + this.id);
    }
    return applied;
  }

  complete(){
    const txt = this.text;
    const secs = (performance.now() - this.startedAt) / 1000;
    if (G.online){
      if (G.pending) return;
      G.pending = true;
      G.net.send({t:"done", index:this.idx, version:this.line.v, text:txt});
      return;
    }
    this.done++; this.strokes += strokes(txt);
    this.idx++; this.typed = ""; this.locked = 0; this.startedAt = performance.now();
    this.fill();
    const fast = txt.length * strokesPerChar() / Math.max(secs, .1) > FAST_STROKES_PER_SEC;
    const n = (fast ? 2 : 1) + (this === G.me ? fireTier(this.streak) : 0);   // 불붙으면 공격이 늘어난다
    for (let i=0;i<n;i++) sendAttack(this);
    if (this === G.me){
      SFX.atk();
      feed(`문장 완료 · 공격 ${n}발`, "me");
      if (fast) toast("PERFECT · 2연타", "good");
      G.slide = true;
    }
  }
}

/* 멀티 전환 지점: target.hit(...) 대신 소켓으로 {from,to,kind}를 보내고
   수신 이벤트에서 해당 Player.hit()을 부르면 나머지 로직은 그대로 재사용된다. */
function sendAttack(from){
  const foes = G.players.filter(p => p.alive && p !== from);
  if (!foes.length) return;
  let target = (from === G.me && G.target) ? foes.find(p => p.id === G.target) : null;
  if (!target) target = Math.random() < .45 ? foes.slice().sort((a,b)=>b.score-a.score)[0] : pick(foes);
  const applied = target.hit(pick(Object.keys(ATTACK_NAMES)), from);
  if (from === G.me && applied) launch(target.id, applied);
}

/* ===================== UI 헬퍼 ===================== */
function toast(msg, cls=""){
  const d = document.createElement("div");
  d.className = "tst " + cls; d.textContent = msg;
  const box = $("#toast");
  box.appendChild(d);
  while (box.children.length > 3) box.firstChild.remove();   // 한꺼번에 여러 개 떠도 3개까지만
  setTimeout(()=>d.remove(), 1300);
}
function feed(msg, cls=""){
  const box = $("#feed"); if (!box) return;
  const d = document.createElement("div");
  d.className = "ev " + cls; d.textContent = msg;
  box.prepend(d);
  while (box.children.length > 7) box.lastChild.remove();
}
function bump(sel, cls = "hit"){
  const el = $(sel); if (!el) return;
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  setTimeout(()=>el.classList.remove(cls), 520);
}

const calmMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* 공격을 여러 발 쏘면 동시에 겹치지 않게 조금씩 간격을 둔다 */
const FX_GAP_MS = 110, ORB_MS = 380, SPARKS = 12;
function launch(toId, kind){
  const now = performance.now(), delay = Math.max(0, (launch.next || 0) - now);
  launch.next = now + delay + FX_GAP_MS;
  setTimeout(()=> fireFx(toId, kind), delay);
}
function fireFx(toId, kind){
  const from = $("#board"), to = $("#foe-" + toId);
  if (!from || !to) return;
  const burning = fireTier(G.me.streak) > 0;
  if (calmMotion()){ bump("#foe-" + toId, "hit"); return; }
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const x0 = a.left + a.width / 2, y0 = a.top + a.height * .35, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
  const orb = document.createElement("div");
  orb.className = "orb" + (burning ? " fire" : "");
  orb.textContent = ATTACK_NAMES[kind];
  orb.style.left = x0 + "px"; orb.style.top = y0 + "px";
  document.body.appendChild(orb);
  orb.animate([
    {transform: "translate(-50%,-50%) scale(.5)", opacity: 0},
    {transform: "translate(-50%,-50%) scale(1.2)", opacity: 1, offset: .18},
    {transform: `translate(calc(-50% + ${x1 - x0}px), calc(-50% + ${y1 - y0}px)) scale(.9)`, opacity: 1}
  ], {duration: ORB_MS, easing: "cubic-bezier(.55,0,.8,.2)"});   // 점점 빨라지면서 꽂힌다
  bump("#board", "recoil");
  setTimeout(()=>{
    orb.remove();
    SFX.smack();
    bump("#foe-" + toId, "smash");
    for (let i = 0; i < SPARKS; i++){
      const p = document.createElement("i");
      p.className = "spark" + (burning ? " fire" : "");
      p.style.left = x1 + "px"; p.style.top = y1 + "px";
      document.body.appendChild(p);
      const ang = i / SPARKS * Math.PI * 2 + Math.random() * .4, dist = 60 + Math.random() * 55;
      p.animate([
        {transform: "translate(-50%,-50%) scale(1.2)", opacity: 1},
        {transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(.2)`, opacity: 0}
      ], {duration: 440, easing: "cubic-bezier(.2,.8,.3,1)"});
      setTimeout(()=> p.remove(), 460);
    }
  }, ORB_MS);
}

/* Tab으로 공격 대상을 돌린다. 자동 → 상대들 → 다시 자동 */
/* Tab을 꾹 누르면 초당 수십 번 바뀐다. 서버는 초당 메시지 수를 제한해서, 마지막 값만 조금 늦게 보낸다. */
const AIM_SEND_MS = 120;
function sendAim(){
  if (!G.online || sendAim.pending) return;
  sendAim.pending = setTimeout(()=>{ sendAim.pending = null; if (G?.online) G.net.send({t:"aim", id:G.target}); }, AIM_SEND_MS);
}
function cycleTarget(dir){
  // 순위순으로 돌리면 누르는 사이 순위가 바뀌어 건너뛰거나 되돌아간다. 입장 순서로 고정한다.
  const order = [null, ...G.players.filter(p => p !== G.me && p.alive).map(p => p.id)];
  const i = Math.max(0, order.indexOf(G.target));
  G.target = order[(i + dir + order.length) % order.length];
  sendAim();
  SFX.key();
}

/* 안 틀리고 이만큼(타수) 치면 불붙음 / 폭주. 단계만큼 문장 완료 공격이 늘어난다. */
const FIRE_STEPS = [40, 120];
const fireTier = n => FIRE_STEPS.filter(step => (n || 0) >= step).length;
function setStreak(me, n){
  const before = fireTier(me.streak), after = fireTier(n);
  me.streak = n;
  if (after > before){ toast(after === 2 ? "🔥🔥 폭주 · 공격 +2" : "🔥 불붙음 · 공격 +1", "fire"); SFX.fire(); }
  else if (after < before) toast("불 꺼짐");
}

const theme = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";
const themeLabel = () => theme() === "dark" ? "라이트" : "다크";
function toggleTheme(e){
  const next = theme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  lsSet("tr_theme", next);
  e.currentTarget.textContent = themeLabel();
}

/* 누군가 지금 치는 문장. 나와 봇은 로컬 상태에서, 다른 사람은 서버가 중계한 값에서 읽는다. */
const MINI_BEFORE = 4, MINI_AFTER = 13;   // 상대 카드는 좁아서 커서 주변만 잘라서 보여 준다
function liveOf(p){
  if (p instanceof Remote) return {text: p.line || "", pos: p.pos || 0, bad: !!p.bad, dt: p.dt || []};
  return {text: p.text, pos: p.typed.length, bad: false, dt: [...p.line.dirty]};
}
/* 친 글자·틀린 글자·커서·공격받은 어절을 칠한다 */
function lineHtml({text, pos, bad, dt}, before = Infinity, after = Infinity){
  if (!text) return "";
  const dirty = new Set();
  let at = 0;
  text.split(" ").forEach((w, i) => { if (dt.includes(i)) for (let k = 0; k < w.length; k++) dirty.add(at + k); at += w.length + 1; });
  const a = Math.max(0, pos - before), b = Math.min(text.length, pos + after);
  let h = "";
  for (let i = a; i < b; i++){
    const cls = i < pos ? (bad && i === pos - 1 ? "mno" : "mok") : i === pos ? "mcur" : dirty.has(i) ? "mdt" : "";
    h += `<span class="${cls}">${esc(text[i])}</span>`;
  }
  return h;
}

/* ===================== 효과음 =====================
   소리 파일 없이 Web Audio로 합성한다. 브라우저는 사용자 입력 전에는 소리를 막아서
   첫 키 입력이나 클릭 때 컨텍스트를 연다. */
const SFX = {
  ctx: null, noise: null,
  muted: lsGet("tr_mute") === "1",
  toggle(){ this.muted = !this.muted; lsSet("tr_mute", this.muted ? "1" : "0"); },
  open(){
    if (this.muted) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx){
      this.ctx = new AC();
      this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  env(g, t, peak, dur){
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  },
  tone(type, f0, f1, dur, peak){
    const c = this.open(); if (!c) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    this.env(g, t, peak, dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + .02);
  },
  hiss(type, f0, f1, dur, peak, q = 1){
    const c = this.open(); if (!c) return;
    const t = c.currentTime, src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = this.noise;
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    this.env(g, t, peak, dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t, Math.random() * .5); src.stop(t + dur + .02);
  },
  pack: "sound:basic",   // 상점 소리 스킨
  key(){
    const r = Math.random();
    switch (this.pack){
      case "sound:blue":         // 청축: 딸깍 두 번 겹치는 날카로운 클릭
        this.hiss("highpass", 4200 + r*800, 3000, .018, .3, 1); this.tone("square", 1900, 1400, .012, .05);
        setTimeout(()=> this.hiss("bandpass", 3000 + r*600, 2200, .02, .18, 4), 14);
        break;
      case "sound:red":          // 적축: 낮고 둥근 톡
        this.hiss("lowpass", 1500 + r*300, 500, .05, .22, 1); this.tone("sine", 150, 90, .05, .12);
        break;
      case "sound:typewriter":   // 타자기: 쇠 부딪는 탁
        this.hiss("bandpass", 2200 + r*500, 1200, .06, .3, 6); this.tone("triangle", 520, 260, .05, .1);
        break;
      case "sound:bubble":       // 뽁뽁이: 음이 떨어지는 뽁
        this.tone("sine", 900 + r*300, 300, .07, .18);
        break;
      default: {                 // 짧은 고음 잡음 + 낮은 톡
        const f = 2600 + r*900; this.hiss("bandpass", f, f*.8, .035, .16, 3); this.tone("sine", 190, 120, .03, .08);
      }
    }
  },
  err(){ this.tone("square", 150, 95, .09, .05); },                                                                            // 낮게 떨어지는 버즈
  atk(){ this.hiss("bandpass", 500, 3200, .2, .22, 1.5); this.tone("triangle", 320, 880, .16, .07); },                        // 위로 올라가는 휙
  hit(){ this.tone("sine", 180, 42, .32, .45); this.hiss("lowpass", 1400, 200, .16, .3); },                                    // 묵직한 쿵
  smack(){ this.hiss("lowpass", 3200, 260, .13, .3); this.tone("square", 240, 55, .12, .1); },                                  // 상대에게 꽂히는 퍽
  fire(){ this.hiss("bandpass", 300, 2600, .38, .2, 1); this.tone("sawtooth", 170, 540, .32, .05); },                          // 불붙는 화르르
  beep(go){ this.tone("sine", go ? 1320 : 880, go ? 1320 : 880, go ? .28 : .12, .12); }                                        // 3·2·1은 낮게, GO는 높고 길게
};
const sndLabel = () => SFX.muted ? "소리 끔" : "소리 켬";

/* ===================== 네트워크 =====================
   Cloudflare Worker + Durable Object. 방 하나가 DO 인스턴스 하나다.
   게임 화면도 같은 워커가 내보내서 서버 주소는 이 페이지 주소다. 파일로 열면(file://) 연습 모드만 된다. */
const SERVER = /^https?:$/.test(location.protocol) ? location.origin : "";
const WS_PROTOCOL = "tr.v2";   // 서버와 같은 값
const httpBase = () => SERVER;
const wsBase   = () => SERVER.replace(/^http/, "ws");

class Net{
  constructor(code, name, handlers){
    this.h = handlers;
    // 로그인 토큰은 주소에 넣지 않고 서브프로토콜 헤더로 보낸다. 주소는 서버 로그에 남는다.
    const protocols = [WS_PROTOCOL];
    if (/^[\w-]+$/.test(AUTH.token || "")) protocols.push("auth." + AUTH.token);
    this.ws = new WebSocket(`${wsBase()}/ws?room=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}&lang=${CFG.lang}`, protocols);
    this.ws.onopen = () => this.h.open && this.h.open();
    this.ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (this.h[m.t]) this.h[m.t](m);
    };
    this.ws.onerror = () => this.h.fail && this.h.fail();
    this.ws.onclose = () => this.h.gone && this.h.gone();
  }
  send(obj){ if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close(){ this.h = {}; try { this.ws.close(); } catch {} }
}

/* 상대 플레이어. 진행도만 서버에서 받아 채우고 화면에는 내 봇들과 똑같이 그려진다. */
class Remote{
  constructor(o){ Object.assign(this, o); this.cps = 0; this.incoming = 0; }
  get progress(){ return this.prog || 0; }
  get score(){ return this.done * 1000 + this.progress * 999; }
}

/* ===================== 계정 =====================
   카카오 로그인은 서버가 처리하고, 끝나면 게임 주소 # 뒤에 세션 토큰을 붙여서 돌려보낸다.
   로그인 안 해도 지금처럼 다 할 수 있다. 계정은 재화·스킨·랭크를 저장하는 데 쓴다. */
const AUTH = {token: lsGet("tr_session"), user: null, kakao: false};

function authFetch(path, opts = {}){
  const headers = {...(opts.headers || {})};
  if (AUTH.token) headers.Authorization = "Bearer " + AUTH.token;
  return fetch(httpBase() + path, {...opts, headers});
}
/* 로그인하고 돌아왔으면 # 뒤 1분짜리 교환권으로 세션을 받고 주소창에서 지운다.
   세션을 주소에 싣지 않는 건 # 뒤 주소도 브라우저 방문 기록에는 남기 때문이다. */
async function takeLoginResult(){
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has("ticket") && !h.has("login_error")) return;
  history.replaceState(null, "", location.pathname + location.search);
  // 내가 누른 로그인에서 돌아온 게 아니면 받지 않는다. 남이 자기 계정 로그인 결과 링크를 보내는 걸 막는다.
  const nonce = lsGet("tr_login_nonce");
  lsSet("tr_login_nonce", "");
  try {
    if (!h.get("ticket") || !nonce || h.get("n") !== nonce) throw new Error(h.get("login_error") || "다른 곳에서 시작한 로그인");
    const r = await fetch(httpBase() + "/auth/exchange", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ticket: h.get("ticket")})});
    if (!r.ok) throw new Error("교환 " + r.status);
    AUTH.token = (await r.json()).session;
    lsSet("tr_session", AUTH.token);
  } catch (e) {
    console.warn("로그인하지 못했다", e.message);
    setTimeout(()=> toast("로그인하지 못했다"), 300);
  }
}
async function loadAccount(){
  if (!SERVER) return;
  try {
    AUTH.kakao = (await (await fetch(httpBase() + "/auth/config")).json()).kakao === true;
    if (!AUTH.token) return;
    const r = await authFetch("/me");
    if (r.status === 401){ AUTH.token = ""; lsSet("tr_session", ""); return; }   // 만료되거나 로그아웃된 세션
    if (r.ok) AUTH.user = (await r.json()).user;
  } catch (e) {
    console.warn("계정 정보를 못 불러왔다", e);
  }
}
/* 로그인했으면 계정 닉네임을 바꾼다. 서버가 거절하면(금칙어·중복) 그 이유를 던진다. */
async function saveNickname(nick){
  if (!AUTH.user || !nick || nick === AUTH.user.nickname) return;
  const r = await authFetch("/me", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({nickname: nick})});
  const body = await r.json().catch(() => ({}));
  if (r.status === 401){ AUTH.token = ""; AUTH.user = null; lsSet("tr_session", ""); return; }
  if (!r.ok) throw new Error(body.error || "닉네임을 저장하지 못했다");
  AUTH.user = body.user;
}
async function logout(){
  await authFetch("/logout", {method: "POST"}).catch(e => console.warn("로그아웃 요청 실패", e));
  AUTH.token = ""; AUTH.user = null; lsSet("tr_session", "");
}
const accountHtml = () => AUTH.user
  ? `<b>${esc(AUTH.user.nickname)}</b><span class="tier">${esc(AUTH.user.tier || "")} ${AUTH.user.rating}</span><span><span class="coin num">${AUTH.user.coins}</span> 코인</span><button class="linkbtn" id="logout">로그아웃</button><button class="linkbtn" id="withdraw">탈퇴</button>`
  : "";   // 기본은 게스트. 로그인 버튼은 상점 안에 있다
function wireAccount(){
  $("#login")?.addEventListener("click", ()=>{
    // 돌아왔을 때 내가 누른 로그인인지 확인할 값. 서버가 # 뒤에 그대로 돌려준다.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
    lsSet("tr_login_nonce", nonce);
    location.href = httpBase() + "/auth/kakao/start?n=" + nonce;
  });
  $("#logout")?.addEventListener("click", async ()=>{ await logout(); menu(); });
  $("#withdraw")?.addEventListener("click", async ()=>{
    if (!confirm("계정과 코인·스킨·레이팅 기록을 모두 지운다. 되돌릴 수 없다. 탈퇴할까?")) return;
    const r = await authFetch("/me/delete", {method: "POST"}).catch(() => null);
    if (!r?.ok){ toast("탈퇴하지 못했다"); return; }
    AUTH.token = ""; AUTH.user = null; lsSet("tr_session", "");
    toast("탈퇴했다 · 기록을 모두 지웠다", "good");
    menu();
  });
}

/* ===================== 스킨 =====================
   이름·가격은 서버 상점 목록이 기준이고, 여기는 적용 방법만 둔다. */
const SKIN_FONTS = {"font:jua": "Jua", "font:dohyeon": "Do Hyeon", "font:pen": "Nanum Pen Script", "font:coding": "Nanum Gothic Coding"};
const SKIN_THEMES = {"theme:cobalt": "#3b82f6", "theme:violet": "#8b5cf6", "theme:sunset": "#f59e0b"};

/* 글꼴은 쓸 때만 받는다. 전부 미리 받으면 첫 화면이 느려진다. */
function loadFont(id){
  const family = SKIN_FONTS[id];
  if (!family) return null;
  const href = "https://fonts.googleapis.com/css2?family=" + family.replace(/ /g, "+") + "&display=swap";
  if (![...document.querySelectorAll("link[rel=stylesheet]")].some(l => l.href === href)){
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = href;
    document.head.appendChild(link);
  }
  return `"${family}", "Pretendard Variable", Pretendard, system-ui, sans-serif`;
}
function applyLoadout(loadout){
  if (!loadout) return;
  SFX.pack = loadout.sound || "sound:basic";
  const root = document.documentElement.style;
  const font = loadFont(loadout.font);
  if (font) root.setProperty("--type-font", font); else root.removeProperty("--type-font");
  if (SKIN_THEMES[loadout.theme]) root.setProperty("--acc", SKIN_THEMES[loadout.theme]); else root.removeProperty("--acc");
  // 글꼴이 바뀌면 글자 폭이 달라져서 한 줄 맞춤을 다시 계산한다
  document.fonts?.ready.then(()=>{ if (G?.running) fitAll(); });
}

/* ===================== 메뉴 ===================== */
const CFG = {diff:"normal", bots:2, lang: lsGet("tr_lang") === "en" ? "en" : "ko"};
const STATS_POLL_MS = 30000;
const DIFF = {easy:{cps:1.3,label:"쉬움"}, normal:{cps:2.1,label:"보통"}, hard:{cps:3.3,label:"어려움"}};

function menu(mode){
  mode = mode || lsGet("tr_mode") || (SERVER ? "online" : "solo");
  if (mode !== "solo") mode = "online";
  // offline은 저장하지 않는다. 저장해 두면 나중에 서버가 붙어도 안내문만 계속 뜬다.
  lsSet("tr_mode", mode);
  if (!SERVER && mode === "online") mode = "offline";
  const nick = lsGet("tr_nick");
  CFG.lang = lsGet("tr_lang") === "en" ? "en" : "ko";   // 남의 방에서 바뀐 언어는 판이 끝나면 내 설정으로 돌린다
  const EX = CFG.lang === "en"
    ? {anagram:"wonder → rednow", insert:"a cup of bussin coffee", reorder:"quiet river → river quiet"}
    : {anagram:"언제인가를 → 언인가제를", insert:"어제의 밤티 나보다", reorder:"가장 밝은 → 밝은 가장"};
  app.innerHTML = `
  <div class="menu">
    <div class="kicker">TYPING BATTLE ROYALE</div>
    <div class="logo">타자 <em>배틀로얄</em></div>
    <div class="sub">문장을 완성하면 상대 문장이 망가진다 · 20초마다 꼴찌 탈락</div>
    <div class="online" id="online"></div>
    <div class="account" id="account">${accountHtml()}</div>
    <div class="modebar">
      <button class="snd" id="shopBtn">상점</button>
      <button class="snd" id="rankBtn">랭킹</button>
      <div class="seg" id="segMode">
        <button data-k="online" class="${mode!=="solo"?"on":""}">온라인 대전</button>
        <button data-k="solo" class="${mode==="solo"?"on":""}">연습 모드</button>
      </div>
      <div class="seg" id="segLang">
        <button data-k="ko" class="${CFG.lang==="ko"?"on":""}">한타</button>
        <button data-k="en" class="${CFG.lang==="en"?"on":""}">영타</button>
      </div>
      <button class="snd" id="snd">${sndLabel()}</button>
      <button class="snd" id="theme">${themeLabel()}</button>
    </div>
    ${mode === "offline" ? `
      <div class="lobby">
        <div class="wait" style="padding:34px 0">온라인 대전은 웹 주소로 열어야 한다.<br>파일로 열었으면 연습 모드로 해봐라.</div>
      </div>
    ` : mode === "solo" ? `
      <div class="opts">
        <div class="opt"><h4>봇 난이도</h4><div class="seg" id="segDiff">
          ${Object.entries(DIFF).map(([k,v])=>`<button data-k="${k}" class="${k===CFG.diff?"on":""}">${v.label}</button>`).join("")}
        </div></div>
        <div class="opt"><h4>봇 수</h4><div class="seg" id="segBots">
          ${[2,3,5,7].map(n=>`<button data-k="${n}" class="${n===CFG.bots?"on":""}">${n}</button>`).join("")}
        </div></div>
      </div>
      <button class="btn" id="go">연습 시작</button>
    ` : `
      <div class="lobby">
        <div class="field"><input id="nick" maxlength="12" placeholder="닉네임" value="${esc(AUTH.user?.nickname || nick)}"></div>
        <div class="field"><button class="btn" id="quick" style="flex:1">빠른 시작</button><button class="btn rankbtn" id="ranked">랭크전</button></div>
        <div class="field">
          <input id="code" maxlength="8" placeholder="방 코드" style="text-transform:uppercase">
          <button class="btn ghost" id="enter">입장</button>
        </div>
        <div class="field"><button class="btn ghost" id="make" style="flex:1">방 만들기</button></div>
        <div class="err" id="err"></div>
      </div>
    `}
    <div class="cards">
      <div class="card"><b>애너그램</b><p>단어 글자를 섞는다.</p><div class="ex">${EX.anagram}</div></div>
      <div class="card"><b>끼워넣기</b><p>신조어를 문법 맞는 자리에 밀어 넣는다.</p><div class="ex">${EX.insert}</div></div>
      <div class="card"><b>순서섞기</b><p>어절 순서를 뒤바꾼다.</p><div class="ex">${EX.reorder}</div></div>
      <div class="card"><b>불가침</b><p>친 부분과 바로 다음 한 어절은 안전. 그 뒤부터 실시간으로 망가진다.</p></div>
    </div>
    <a class="foot" href="privacy.html">개인정보 처리방침</a>
  </div>`;

  const seg = (id,key,cast,after) => { const el=$(id); if(!el) return;
    el.addEventListener("click", e=>{
      const b = e.target.closest("button"); if (!b) return;
      [...e.currentTarget.children].forEach(c=>c.classList.toggle("on", c===b));
      if (key) CFG[key] = cast(b.dataset.k);
      if (after) after(b.dataset.k);
    });
  };
  seg("#segMode", null, null, k => menu(k));
  seg("#segLang", null, null, k => { lsSet("tr_lang", k); menu(mode === "solo" ? "solo" : "online"); });
  $("#snd").addEventListener("click", e => { SFX.toggle(); e.currentTarget.textContent = sndLabel(); });
  $("#theme").addEventListener("click", toggleTheme);
  wireAccount();
  $("#shopBtn").addEventListener("click", ()=> shop());
  $("#rankBtn").addEventListener("click", ()=> leaderboard());
  seg("#segDiff","diff",String);
  seg("#segBots","bots",Number);

  // 접속자 수. 사람이 있는 게 보여야 빠른 시작을 누른다.
  const showStats = () => fetch(httpBase() + "/stats").then(r => r.json()).then(st => {
    const el = $("#online");
    if (!el) return clearInterval(menu.poll);
    if (typeof st.online !== "number") return;   // 통계를 모르는 옛 서버
    el.innerHTML = `지금 <b>${st.online}</b>명 접속 중 · 대기 <b>${st.waiting}</b>명`;
  }).catch(() => {});
  clearInterval(menu.poll);
  // 탭을 띄워만 둬도 계속 묻지 않게 화면이 보일 때만, 드문드문 묻는다(요청 한도를 아낀다)
  if (SERVER){ showStats(); menu.poll = setInterval(()=>{ if (document.visibilityState === "visible") showStats(); }, STATS_POLL_MS); }

  if (mode === "offline") return;
  if (mode === "solo"){ $("#go").addEventListener("click", ()=>start({})); return; }

  const fail = msg => $("#err").textContent = msg;
  const nickOf = () => ($("#nick").value.trim() || "익명").slice(0,12);
  // 로그인했으면 계정 닉네임도 바꾼다. 방에 들어가기 전에 끝내야 예전 이름으로 입장하지 않는다.
  const remember = () => { const v = $("#nick").value.trim(); lsSet("tr_nick", v); return saveNickname(v); };

  async function ask(path){
    if (!SERVER) throw new Error("온라인 대전은 웹 주소로 열어야 한다");
    const r = await authFetch(path);   // 랭크전 자리는 로그인한 계정에만 준다
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "서버 응답 " + r.status);
    return r.json();
  }
  let busy = false;
  const guard = fn => async () => {
    if (busy) return;
    busy = true;
    fail("");
    try { await remember(); await fn(); }
    catch (e) { fail(e.message || "서버에 연결하지 못했다"); }
    finally { busy = false; }
  };

  $("#quick").addEventListener("click", guard(async ()=>{
    lobby((await ask("/join?lang=" + CFG.lang)).code, nickOf(), true);
  }));
  $("#ranked").addEventListener("click", guard(async ()=>{
    // 레이팅을 계정에 저장해야 해서 랭크전은 로그인한 사람만 한다
    if (!AUTH.user) throw new Error("랭크전은 카카오 로그인이 필요하다 · 상점에서 로그인할 수 있다");
    lobby((await ask("/join?lang=" + CFG.lang + "&ranked=1")).code, nickOf(), true);
  }));
  $("#make").addEventListener("click", guard(async ()=>{
    lobby((await ask("/new")).code, nickOf(), false);
  }));
  $("#enter").addEventListener("click", guard(async ()=>{
    const code = $("#code").value.trim().toUpperCase();
    if (!code) throw new Error("방 코드를 입력해라");
    if (!SERVER) throw new Error("온라인 대전은 웹 주소로 열어야 한다");
    lobby(code, nickOf(), false);
  }));
  $("#code").addEventListener("keydown", e => { if (e.key === "Enter") $("#enter").click(); });
  $("#nick").addEventListener("keydown", e => { if (e.key === "Enter") $("#quick").click(); });
}

/* ===================== 랭킹 ===================== */
async function leaderboard(){
  clearInterval(menu.poll);
  app.innerHTML = `<div class="menu"><div class="kicker">RANKING</div><div class="logo">랭크전 <em>순위</em></div><div class="wait" style="margin-top:31px">불러오는 중</div></div>`;
  let top = null;
  try {
    const r = await fetch(httpBase() + "/rank/top");
    if (!r.ok) throw new Error("status " + r.status);
    top = (await r.json()).top;
  } catch (e) {
    console.error("순위를 못 불러왔다", e);
  }
  app.innerHTML = `
  <div class="menu">
    <div class="kicker">RANKING</div>
    <div class="logo">랭크전 <em>순위</em></div>
    <div class="sub">${AUTH.user ? `내 레이팅 <b>${AUTH.user.rating}</b> · ${esc(AUTH.user.tier || "")}` : "랭크전은 카카오 로그인하고 할 수 있다"}</div>
    <div class="standings" style="margin-top:29px">${
      top === null ? `<div class="wait">순위를 불러오지 못했다</div>`
      : top.length ? top.map((p, i) => `<div class="srow${i === 0 ? " first" : ""}"><b>${i + 1}위</b><span>${esc(p.nickname)}</span><u>${esc(p.tier)} · ${p.rating}</u></div>`).join("")
      : `<div class="wait">아직 랭크전 기록이 없다</div>`}</div>
    <button class="btn ghost" id="back">메뉴로</button>
  </div>`;
  $("#back").addEventListener("click", ()=> menu());
}

/* ===================== 상점 ===================== */
const SHOP_TABS = {sound: "타자 소리", font: "글꼴", theme: "테마"};
const LISTEN_TAPS = [0, 110, 200, 330, 420];   // 들어보기: 다다닥 치는 느낌으로 몇 번

async function shop(tab = "sound"){
  clearInterval(menu.poll);
  app.innerHTML = `<div class="menu"><div class="kicker">SHOP</div><div class="logo">스킨 <em>상점</em></div><div class="wait" style="margin-top:31px">불러오는 중</div></div>`;
  let data;
  try {
    const r = await authFetch("/shop");
    if (!r.ok) throw new Error("status " + r.status);
    data = await r.json();
  } catch (e) {
    console.error("상점을 못 불러왔다", e);
    app.querySelector(".wait").innerHTML = `상점을 불러오지 못했다 · <button class="linkbtn" id="back">메뉴로</button>`;
    $("#back").addEventListener("click", ()=> menu());
    return;
  }
  const logged = !!AUTH.user;
  const owned = new Set(data.owned || []), loadout = data.loadout || {};
  if (logged) AUTH.user.coins = data.coins;

  const preview = it => it.slot === "font"
    ? `<div class="pv" style='font-family:${loadFont(it.id) || "inherit"}'>타자 배틀로얄 Typing</div>`
    : it.slot === "theme"
      ? `<div class="pv swatch" style="--sw:${SKIN_THEMES[it.id] || "#10b981"}"><i></i><i></i><i></i></div>`
      : `<button class="snd pv" data-listen="${it.id}">들어보기</button>`;
  const action = it => {
    const price = it.price ? it.price + " 코인" : "무료";
    if (!logged) return `<button class="btn ghost" disabled>${price}</button>`;
    if (loadout[it.slot] === it.id) return `<button class="btn ghost" disabled>사용 중</button>`;
    if (it.price === 0 || owned.has(it.id)) return `<button class="btn" data-equip="${it.id}">사용하기</button>`;
    return `<button class="btn" data-buy="${it.id}" ${data.coins < it.price ? "disabled" : ""}>${it.price} 코인에 사기</button>`;
  };

  app.innerHTML = `
  <div class="menu">
    <div class="kicker">SHOP</div>
    <div class="logo">스킨 <em>상점</em></div>
    <div class="sub">${logged
      ? `<b class="coin num">${data.coins}</b> 코인 · 온라인 대전에서 순위가 높을수록 많이 받는다`
      : "스킨은 로그인하면 쓸 수 있다 · 게임하면서 코인을 모아서 산다"}</div>
    ${logged ? "" : `<div class="account">${AUTH.kakao ? `<button class="kakao" id="login">카카오로 로그인</button>` : "카카오 로그인은 준비 중이다"}</div>
    <div class="note">로그인하면 카카오 회원번호와 닉네임·게임 기록을 저장한다. 닉네임은 순위표에 공개된다 · <a href="privacy.html">개인정보 처리방침</a></div>`}
    <div class="modebar" style="margin-top:23px"><div class="seg" id="shopTabs">
      ${Object.entries(SHOP_TABS).map(([k,v]) => `<button data-k="${k}" class="${k===tab?"on":""}">${v}</button>`).join("")}
    </div></div>
    <div class="shopgrid">${data.items.filter(it => it.slot === tab).map(it => `
      <div class="item${loadout[it.slot] === it.id ? " on" : ""}">
        <b>${esc(it.name)}</b>
        <u>${it.price ? it.price + " 코인" : "무료"}${owned.has(it.id) ? " · 보유" : ""}</u>
        ${preview(it)}
        ${action(it)}
      </div>`).join("")}</div>
    <div class="err" id="err"></div>
    <button class="btn ghost" id="back" style="margin-top:23px">메뉴로</button>
  </div>`;

  wireAccount();
  $("#back").addEventListener("click", ()=> menu());
  $("#shopTabs").addEventListener("click", e => { const b = e.target.closest("button"); if (b) shop(b.dataset.k); });
  app.querySelectorAll("[data-listen]").forEach(b => b.addEventListener("click", ()=>{
    const mine = SFX.pack;
    SFX.pack = b.dataset.listen;
    LISTEN_TAPS.forEach(t => setTimeout(()=> SFX.key(), t));
    setTimeout(()=>{ SFX.pack = mine; }, LISTEN_TAPS.at(-1) + 100);
  }));
  const post = async (path, item) => {
    const r = await authFetch(path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({item})});
    const body = await r.json().catch(() => ({}));
    if (!r.ok){ $("#err").textContent = body.error || "실패했다"; return null; }
    return body;
  };
  app.querySelectorAll("[data-buy]").forEach(b => b.addEventListener("click", async ()=>{
    b.disabled = true;   // 연타 방지(서버도 한 번만 빼지만 화면에서도 막는다)
    const res = await post("/shop/buy", b.dataset.buy);
    if (!res){ b.disabled = false; return; }
    AUTH.user.coins = res.coins;
    toast("샀다", "good");
    shop(tab);
  }));
  app.querySelectorAll("[data-equip]").forEach(b => b.addEventListener("click", async ()=>{
    const res = await post("/shop/equip", b.dataset.equip);
    if (!res) return;
    AUTH.user[res.slot] = res.item;
    applyLoadout(AUTH.user);
    shop(tab);
  }));
}

/* ===================== 로비 ===================== */
const ROOM_MAX = 10;
const ACCT_MARK = '<i class="acct" title="로그인한 계정"></i>';   // 게스트가 계정 닉네임을 흉내 내도 구별되게
/* 누르면 바로 그 방으로 들어오는 초대 링크 */
function inviteLink(code){
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set("room", code);
  return u.toString();
}
function menuError(msg){
  menu("online");
  setTimeout(()=>{ const e = $("#err"); if (e) e.textContent = msg; }, 30);
}

/* 초대 링크로 들어온 사람. 바로 입장시키지 않고 닉네임부터 정하게 한다. */
function invite(code){
  clearInterval(menu.poll);
  app.innerHTML = `
  <div class="menu">
    <div class="kicker">초대받은 방</div>
    <div class="logo">타자 <em>배틀로얄</em></div>
    <div class="lobby" style="margin-top:29px">
      <div class="code">${esc(code)}</div>
      <div class="codehint">같이 칠 때 보일 닉네임을 정해라</div>
      <div class="field"><input id="nick" maxlength="12" placeholder="닉네임" value="${esc(AUTH.user?.nickname || lsGet("tr_nick"))}"></div>
      <div class="field"><button class="btn" id="join" style="flex:1">입장</button></div>
      <div class="field"><button class="btn ghost" id="toMenu" style="flex:1">메뉴로</button></div>
    </div>
  </div>`;
  // 주소창에서 방 코드를 지운다. 안 지우면 판이 끝나고 새로고침할 때마다 같은 방 초대 화면이 뜬다.
  const clearLink = () => { const u = new URL(location.href); u.searchParams.delete("room"); history.replaceState(null, "", u); };
  const join = async () => {
    const nick = $("#nick").value.trim();
    lsSet("tr_nick", nick);
    try { await saveNickname(nick); }
    catch (e) { toast(e.message); return; }
    clearLink();
    lobby(code, (nick || "익명").slice(0, 12), code.startsWith("AUTO"));
  };
  $("#join").addEventListener("click", join);
  $("#nick").addEventListener("keydown", e => { if (e.key === "Enter") join(); });
  $("#toMenu").addEventListener("click", ()=>{ clearLink(); menu("online"); });
  $("#nick").focus();
}

function lobby(code, name, auto, retry = 0){
  clearInterval(menu.poll);
  let players = [], deadline = 0, host = null, copiedAt = 0;
  const ranked = code.startsWith("RANK"), since = Date.now();
  // 바뀐 부분만 다시 그린다. 버튼을 매번 새로 만들면 누르는 사이에 바뀌어 클릭이 씹힌다.
  const setHtml = (sel, html) => { const el = $(sel); if (el && el._h !== html){ el._h = html; el.innerHTML = html; } };

  /* 폰이면 공유창을 띄우고, PC면 클립보드에 복사한다. 클립보드가 막힌 브라우저면 링크를 선택해 둬서 Ctrl+C만 누르면 된다. */
  const copyInvite = async () => {
    const url = inviteLink(code);
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({title: "타자 배틀로얄", text: "타자 배틀로얄 한 판 하자", url});
      else await navigator.clipboard.writeText(url);
      copiedAt = Date.now(); render();
    } catch (e) {
      if (e.name !== "AbortError") $("#inviteUrl")?.select();
    }
  };

  app.innerHTML = `
  <div class="menu">
    <div class="kicker" id="lkick"></div>
    <div class="lobby" style="margin-top:29px">
      ${ranked ? "" /* 랭크전은 상대를 고를 수 없게 초대 링크를 안 보여 준다 */ : `
      <div class="code" id="copy" title="눌러서 초대 링크 복사">${esc(code)}</div>
      <div class="field invite">
        <input id="inviteUrl" readonly value="${esc(inviteLink(code))}">
        <button class="btn" id="copyLink">초대 링크 복사</button>
      </div>
      <div class="codehint">링크를 받은 사람은 누르면 닉네임만 정하고 바로 이 방에 들어온다</div>`}
      <div class="slots" id="slots"></div>
      <div class="wait" id="lwait"></div>
      <div class="field" id="lact"></div>
      <div class="field"><button class="btn ghost" id="leave" style="flex:1">나가기</button></div>
      <div class="err" id="err"></div>
    </div>
  </div>`;
  $("#copy")?.addEventListener("click", copyInvite);
  $("#copyLink")?.addEventListener("click", copyInvite);
  $("#inviteUrl")?.addEventListener("focus", e => e.target.select());
  $("#leave").addEventListener("click", ()=>{ stop(); menu("online"); });
  $("#slots").addEventListener("click", e => { const b = e.target.closest("[data-kick]"); if (b) net.send({t:"kick", id: b.dataset.kick}); });
  $("#lact").addEventListener("click", e => {
    const me = players.find(p => p.id === lobby.you);
    if (e.target.closest("#begin")) net.send({t:"start"});
    else if (e.target.closest("#ready")) net.send({t:"ready", on: !me?.ready});
  });

  const render = () => {
    const left = deadline ? Math.max(0, Math.ceil((deadline - Date.now())/1000)) : null;
    const isHost = !auto && host === lobby.you;
    const me = players.find(p => p.id === lobby.you);
    // 직접 판 방은 방장 빼고 전원, 빠른 시작 방은 전원이 준비해야 한다(서버와 같은 규칙)
    const others = players.filter(p => auto || p.id !== host);
    const readyCount = others.filter(p => p.ready).length;
    const allReady = players.length >= 2 && readyCount === others.length;
    const status = ranked
      ? (players.length < 2 ? `랭크전 상대를 찾는 중 · <b>${Math.floor((Date.now() - since) / 1000)}초</b>`   // 랭크전은 봇전으로 안 넘어간다
                            : `${players.length}명 · ${left !== null ? `<b>${left}초</b> 뒤 시작` : "곧 시작"}`)
      : auto
        ? (players.length < 2
            ? `상대를 기다리는 중${left !== null ? ` · <b>${left}초</b> 뒤 봇전으로 시작` : ""}`
            : `준비 <b>${readyCount}/${players.length}</b> · 모두 준비하면 바로 시작${left !== null ? ` · <b>${left}초</b> 뒤 자동 시작` : ""}`)
        : isHost
          ? (players.length < 2 ? "친구가 들어오면 시작할 수 있다"
             : allReady ? "<b>모두 준비됐다</b> · 시작해라" : `준비 <b>${readyCount}/${others.length}</b> · 다 준비해야 시작할 수 있다`)
          : me?.ready ? "준비 완료 · 방장이 시작하길 기다리는 중" : "준비를 눌러야 방장이 시작할 수 있다";
    const kicker = `${ranked ? "랭크전" : auto ? "빠른 시작" : "방"} · ${CFG.lang === "en" ? "영타" : "한타"} · ${players.length}/${ROOM_MAX}`;
    if ($("#lkick").textContent !== kicker) $("#lkick").textContent = kicker;
    setHtml("#slots",
      players.map(p=>`<div class="slot"><span class="grow">${esc(p.name)}${p.acct ? ACCT_MARK : ""}</span>${!auto && p.id===host?'<span class="host">방장</span>':p.ready?'<span class="ready">준비</span>':""}${p.id===lobby.you?'<span class="me">나</span>':""}${isHost && p.id !== lobby.you ? `<button class="linkbtn" data-kick="${esc(p.id)}">내보내기</button>` : ""}</div>`).join("") +
      Array.from({length: Math.max(0, 2 - players.length)}, ()=>`<div class="slot empty">비어 있음</div>`).join(""));
    setHtml("#lwait", status);
    setHtml("#lact", ranked ? ""
      : isHost ? `<button class="btn" id="begin" style="flex:1" ${allReady ? "" : "disabled"}>게임 시작</button>`
      : `<button class="btn${me?.ready ? " ghost" : ""}" id="ready" style="flex:1">${me?.ready ? "준비 취소" : "준비"}</button>`);
    const copied = Date.now() - copiedAt < 1500 ? "복사됨" : "초대 링크 복사";
    if ($("#copyLink") && $("#copyLink").textContent !== copied) $("#copyLink").textContent = copied;
  };

  const tick = setInterval(render, 500);   // 카운트다운 숫자만 바뀐다. 버튼은 상태가 바뀔 때만 다시 만든다
  const stop = () => { clearInterval(tick); net.close(); };

  const net = new Net(code, name, {
    joined: m => {
      lobby.you = m.you; host = m.host; auto = m.auto;
      // 방 언어는 먼저 들어온 사람 기준이다. 한타·영타가 한 방에 섞이면 공정하지 않다.
      if (m.lang && m.lang !== CFG.lang){ CFG.lang = m.lang; toast(m.lang === "en" ? "영타 방에 들어왔다" : "한타 방에 들어왔다"); }
      render();
    },
    players: m => { players = m.players; host = m.host; render(); },
    countdown: m => { deadline = Date.now() + m.sec*1000; render(); },
    denied: m => {
      stop();
      // 빠른 시작은 배정받고 들어가는 사이에 방이 차거나 시작할 수 있다. 조용히 다른 방을 다시 받는다.
      if (auto && retry < 2){
        authFetch("/join?lang=" + CFG.lang + (ranked ? "&ranked=1" : "")).then(r => r.json())
          .then(j => { if (!j.code) throw new Error(j.error); lobby(j.code, name, true, retry + 1); })
          .catch(() => menuError(m.reason || "서버에 연결하지 못했다"));
        return;
      }
      menuError(m.reason);
    },
    start: m => { clearInterval(tick); start({net, code, you: lobby.you, countdown: m.countdown, queue:m.queue}); },
    solo: () => { clearInterval(tick); net.close(); toast("상대가 없어서 봇전으로 시작한다"); start({}); },
    fail: () => { clearInterval(tick); menuError("서버에 연결하지 못했다"); },
    gone: () => { if (!G || !G.running){ clearInterval(tick); menuError("서버 연결이 끊겼다"); } }
  });

  render();
}

/* ===================== 게임 ===================== */
const ELIM_MS = 20000;
const COUNTDOWN_MS = 3000;   // 시작 전 3·2·1 (서버와 같은 길이)
const BOT_NAMES = ["알파","베타","감마","델타","엡실론","제타","에타"];

function start(opts){
  opts = opts || {};
  const net = opts.net || null;
  const base = DIFF[CFG.diff].cps;
  G = {players:[], me:null, target:null, running:true, nextElim:0, t0:0,
       tick:null, composing:false, committing:false, slide:false, sliding:false, rebuild:false, ver:-1, spans:[], hadErr:false,
       net, online:!!net, code:opts.code || null, sentProg:0, sentKey:"", spectating:false, pending:false, goAt:0, watchOrder:""};
  G.me = new Player(opts.you || "me", "나", false);
  if (G.online) G.me.queue = opts.queue.map(unpackLine);
  G.players.push(G.me);
  if (!G.online){
    for (let i=0;i<CFG.bots;i++){
      const b = new Player("b"+i, "봇 "+BOT_NAMES[i], true);
      b.cps = base * KO_STROKES_PER_CHAR / strokesPerChar() * (0.85 + Math.random()*0.3);
      G.players.push(b);
    }
  }
  // 3·2·1 동안은 아무도 못 친다. 온라인은 서버가 준 길이, 연습 모드도 같은 길이로 맞춘다.
  G.t0 = performance.now();
  G.goAt = G.t0 + (opts.countdown ?? COUNTDOWN_MS);
  G.nextElim = G.goAt + ELIM_MS;
  if (G.online) wireGame(net);
  G.players.forEach(p => { p.startedAt = G.goAt; p.lastChar = G.goAt; });
  renderGame();
  // 렌더까지 이 인터벌 하나로 돌린다. requestAnimationFrame은 탭이 가려지거나
  // 임베드 뷰어에서 멈춰버려서 화면이 통째로 얼어붙는다.
  G.tick = setInterval(loop, 25);
}

/* 게임 중에는 서버가 심판이다. 순위·탈락·공격 배정 전부 서버 판정을 그대로 따른다. */
function wireGame(net){
  net.h = {
    players: m => {
      const seen = new Set();
      for (const info of m.players){
        seen.add(info.id);
        if (info.id === G.me.id){ G.me.alive = info.alive; G.me.rank = info.rank; continue; }
        const had = G.players.find(x => x.id === info.id);
        if (had) Object.assign(had, info); else G.players.push(new Remote(info));
      }
      G.players = G.players.filter(p => p === G.me || seen.has(p.id));
      if (m.elimIn) G.nextElim = performance.now() + m.elimIn;
    },
    sentence: m => {
      const me = G.me;
      if (m.index < me.idx) return;
      const advanced = m.index > me.idx;
      me.idx = m.index; me.done = m.index;
      me.queue.splice(me.idx, me.queue.length - me.idx, ...m.queue.map(unpackLine));
      if (advanced){
        me.typed = ""; me.locked = 0; me.startedAt = performance.now();
        me.strokes = m.spent; G.pending = false; G.slide = true;
        $("#type").value = "";
        setStreak(me, m.streak);
      } else if (m.rejected){
        let prefix = 0;
        while (prefix < me.typed.length && me.typed[prefix] === me.text[prefix]) prefix++;
        // 완성 문자열의 속도 검증이 거절되면 마지막 글자를 다시 입력해 재시도한다.
        prefix = Math.min(prefix, me.text.length - 1);
        me.typed = me.text.slice(0, prefix); me.locked = prefix;
        $("#type").value = me.typed; G.pending = false;
        setStreak(me, m.streak); toast(m.reason);
      }
      G.rebuild = true;
      if (m.attack){
        SFX.hit(); bump("#app", "jolt"); bump("#board", "flash");
        feed(`${m.attack.from} → 나 · ${ATTACK_NAMES[m.attack.kind]}`, "dmg");
        toast(ATTACK_NAMES[m.attack.kind], "atk");
      }
    },
    sent: m => { SFX.atk(); feed(`나 → ${m.to} · ${ATTACK_NAMES[m.kind]}`, "me"); if (m.toId) launch(m.toId, m.kind); },
    out: m => {
      feed(`${m.name} 탈락 · ${m.rank}위`, "out");
      if (m.id !== G.me.id) toast(m.name + " 탈락");
      if (G.target === m.id) G.target = null;
    },
    rating: m => {
      if (AUTH.user){ AUTH.user.rating = m.after; AUTH.user.tier = m.tier; }
      const sign = m.delta > 0 ? "+" : "";
      toast(`레이팅 ${sign}${m.delta} · ${m.tier}`, m.delta >= 0 ? "good" : "");
      const el = $("#ratingLine");
      if (el) el.innerHTML = `레이팅 ${m.before} → <b>${m.after}</b> (${sign}${m.delta}) · ${esc(m.tier)}`;
    },
    reward: m => {
      if (AUTH.user) AUTH.user.coins = m.total;
      toast(`+${m.coins} 코인${m.capped ? " · 오늘 한도" : ""}`, "good");
      const el = $("#reward");
      if (el) el.textContent = `+${m.coins} 코인`;
    },
    winner: m => {
      feed(`${m.name} 우승`, "out");
      const w = G.players.find(p => p.id === m.id);
      if (w) w.rank = 1;
      if (G.spectating) over(false);   // 관전하던 사람은 우승자가 나오면 최종 순위를 본다
    },
    end: m => { G.me.rank = m.rank; G.me.alive = !!m.win; if (m.win) over(true); else spectate(); },
    denied: m => toast(m.reason || "서버 연결이 거절됐다"),
    gone: () => { if (G && G.running){ toast("서버 연결이 끊겼다"); over(false); } }
  };
}

function renderGame(){
  app.innerHTML = `
  <div class="hud" id="hud">
    <span class="tleft" id="tleft">다음 탈락 20.0초</span>
    <span class="tick"><i id="tbar"></i></span>
    <span class="stat"><b class="num" id="sCpm">0</b><u>타/분</u></span>
    <span class="stat"><b class="num" id="sAcc">100</b><u>%</u></span>
    <span class="stat"><b class="num" id="sDone">0</b><u>문장</u></span>
    <span class="stat"><b class="num" id="sRank">1</b><u>위</u></span>
    <span class="stat streak"><b class="num" id="sStreak">0</b><u>연속</u></span>
    <span class="aimpill" id="aimPill"></span>
    <button class="snd" id="snd">${sndLabel()}</button>
      <button class="snd" id="theme">${themeLabel()}</button>
  </div>
  <div class="stage">
    <div>
      <div class="board" id="board">
        <div class="rail"><div class="track" id="track"></div></div>
        <div class="hint" id="hint"></div>
        <input id="type" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="blur" id="blur">클릭해서 계속 입력</div>
        <div class="count" id="count"></div>
      </div>
      <div class="feed" id="feed"></div>
    </div>
    <div>
      <div class="foes" id="foes"></div>
      <div class="aim">Tab으로 공격 대상 바꾸기 · 카드 클릭도 된다</div>
    </div>
  </div>`;

  $("#foes").addEventListener("click", e=>{
    const c = e.target.closest(".foe"); if (!c) return;
    const p = G.players.find(x => x.id === c.dataset.id);
    if (!p || !p.alive) return;
    G.target = G.target === p.id ? null : p.id;
    sendAim();
    $("#type").focus();
  });

  const inp = $("#type");
  inp.addEventListener("compositionstart", ()=> G.composing = true);
  inp.addEventListener("compositionend", ()=>{ G.composing = false; onInput(); });
  inp.addEventListener("input", onInput);
  inp.addEventListener("keydown", e=>{
    const me = G.me;
    // 포커스가 입력칸을 떠나지 않게 막고 공격 대상만 돌린다
    if (e.key === "Tab"){ e.preventDefault(); cycleTarget(e.shiftKey ? -1 : 1); return; }
    if (performance.now() < G.goAt || G.pending){ e.preventDefault(); return; }
    // 틀린 글자를 고치기 전엔 다음 글자로 못 간다. 한글 IME 입력은 keydown으로 못 막아서 onInput에서 잘라낸다.
    if (!e.isComposing && e.key.length === 1 && firstWrong(me.typed, me.text, false) >= 0){
      e.preventDefault(); me.keys++; SFX.err(); return;
    }
    // 맞게 친 부분은 지울 수 없다
    if (!e.isComposing && e.key === "Backspace" && inp.value.length <= me.locked){ e.preventDefault(); return; }
    if (e.key.length === 1 || e.key === "Process" || e.key === "Backspace"){ me.keys++; SFX.key(); }
  });
  inp.addEventListener("blur", ()=> $("#blur").classList.add("on"));
  inp.addEventListener("focus", ()=> $("#blur").classList.remove("on"));
  $("#blur").addEventListener("click", ()=> inp.focus());
  $("#snd").addEventListener("click", e => { SFX.toggle(); e.currentTarget.textContent = sndLabel(); });
  $("#theme").addEventListener("click", toggleTheme);
  document.addEventListener("click", ()=>{ if (G && G.running) inp.focus(); });
  inp.focus();
  buildRows();
  addEventListener("resize", fitAll);
}

/* 조합 중에 입력칸 값을 바꾸면 IME가 조합을 끝내면서 글자를 다시 끼워 넣는다.
   문장 끝 글자가 다음 문장으로 넘어가던 원인이 이거다. blur로 조합을 먼저 끝내고 다음 틱에 처리한다. */
function endComposition(){
  if (G.committing) return;
  G.committing = true;
  setTimeout(()=>{
    const inp = $("#type");
    G.committing = false;
    if (!inp || !G.running) return;
    inp.blur(); inp.focus();
    G.composing = false;
    onInput();
  }, 0);
}

function onInput(){
  if (!G || !G.running || !G.me.alive) return;
  const inp = $("#type"), me = G.me, t = me.text;
  if (G.pending){ inp.value = me.typed; return; }
  if (performance.now() < G.goAt){ if (G.composing) endComposition(); else inp.value = ""; return; }
  let v = inp.value;
  let w = firstWrong(v, t, G.composing);

  if (G.composing){
    // 틀린 글자 뒤로 새 글자를 조합하기 시작했거나, 마지막 글자까지 맞게 조합했으면 조합을 끊고 다시 판정한다
    if ((w >= 0 && w < v.length - 1) || v === t) endComposition();
  } else {
    if (v.length < me.locked) v = t.slice(0, me.locked);          // 맞게 친 부분은 지울 수 없다
    else if (w >= 0 && v.length > w + 1) v = v.slice(0, w + 1);   // 틀린 글자에서 멈춘다
    if (v !== inp.value) inp.value = v;
    w = firstWrong(v, t, false);
    // 새로 맞게 확정된 글자만큼 연속 타수를 쌓는다
    if (w < 0 && v.length > me.locked) setStreak(me, me.streak + strokes(t.slice(me.locked, v.length)));
    if (w < 0) me.locked = v.length;
  }
  if (w >= 0 && me.streak) setStreak(me, 0);   // 한 번이라도 틀리면 불이 꺼진다

  me.typed = w >= 0 ? v.slice(0, w + 1) : v;
  if (!G.composing && v === t){
    me.complete();
    if (!G.online){ inp.value = ""; me.typed = ""; }
  }
}

/* ---------- 문장 트랙 ---------- */
function rowHtml(line, cls){
  let h = "";
  line.words.forEach((w,i)=>{
    if (i) h += `<span class="ch sp"> </span>`;
    const dt = line.dirty.has(i);
    for (const c of w) h += `<span class="ch${dt?" dt":""}"${dt?' data-dt="1"':""}>${esc(c)}</span>`;
  });
  return `<div class="row ${cls}"><span class="fit">${h}</span></div>`;
}
/* 현재 문장과 다음 문장 둘 다 본다. 현재만 보면 다음 문장이 공격받아도 미리보기가 안 바뀌어서
   넘어가는 순간 바뀐 글자가 튀어나온다. */
const rowKey = () => { const q = G.me.queue, i = G.me.idx; return `${i}:${q[i].v}:${q[i+1].v}`; };

function buildRows(){
  const me = G.me, q = me.queue;
  $("#track").innerHTML =
      (me.idx > 0 ? rowHtml(q[me.idx-1], "past") : `<div class="row past"></div>`)
    + rowHtml(q[me.idx], "cur")
    + rowHtml(q[me.idx+1], "next");
  const fit = $(".row.cur .fit");
  G.spans = [...fit.querySelectorAll(".ch")];
  G.tail = document.createElement("span");          // 문장 길이를 넘겨 친 글자
  G.tail.className = "ch no tail";
  fit.appendChild(G.tail);
  G.ver = rowKey();
  fitAll();
}
function fitAll(){
  for (const row of document.querySelectorAll(".rail .row")){
    const span = row.querySelector(".fit"); if (!span) continue;
    span.style.transform = "scale(1)";
    const avail = row.clientWidth - 12, w = span.scrollWidth;
    if (w > avail) span.style.transform = `scale(${(avail/w).toFixed(4)})`;
  }
}
function advance(){
  const track = $("#track"), h = $(".rail .row").offsetHeight;
  G.sliding = true;
  track.classList.add("go");
  track.style.transform = `translateY(${-2*h}px)`;
  setTimeout(()=>{
    track.classList.remove("go");
    track.style.transform = "";
    G.sliding = false;
    buildRows();
  }, 420);
}

/* ---------- 루프 ---------- */
function loop(){
  if (!G.running) return;
  const now = performance.now();

  for (const p of G.players){
    if (!p.alive || !p.bot || now < p.pauseUntil || now < G.goAt) continue;
    const txt = p.text;
    const slow = Math.max(.5, 1 - .2 * p.line.hits);
    const need = 1000 / (p.cps * slow);
    while (now - p.lastChar >= need && p.typed.length < txt.length){
      p.lastChar += need;
      p.typed = txt.slice(0, p.typed.length + 1);
      if (Math.random() < .015 + .02 * p.line.hits){
        p.pauseUntil = now + 250 + rnd(650);
        p.lastChar = p.pauseUntil;
        break;
      }
    }
    if (p.typed.length >= txt.length){ p.complete(); p.lastChar = now; }
  }

  if (G.online){
    // 입력 문자열만 보낸다. 서버가 배정한 문장과 대조해 진행도를 계산한다.
    if (G.me.alive && now >= G.goAt && now - G.sentProg > 200){
      G.sentProg = now;
      const me = G.me, msg = {t:"prog", index:me.idx, text:me.typed, composing:G.composing};
      G.net.send(msg);
    }
  } else if (now >= G.nextElim){
    eliminate(); G.nextElim = now + ELIM_MS;
  }
  if (G.running) G.spectating ? drawWatch() : draw();
}

function eliminate(){
  const alive = G.players.filter(p => p.alive);
  if (alive.length <= 1) return;
  const loser = alive.slice().sort((a,b)=>a.score-b.score)[0];
  loser.alive = false; loser.rank = alive.length;
  feed(`${loser.name} 탈락 · ${alive.length}위`, "out");
  if (loser !== G.me) toast(loser.name + " 탈락");
  if (G.target === loser.id) G.target = null;
  const left = G.players.filter(p => p.alive);
  if (left.length === 1){ left[0].rank = 1; return over(left[0] === G.me); }
  if (loser === G.me) spectate();   // 떨어져도 나가지 않고 남은 봇들을 지켜본다
}

function over(win){
  const wasOnline = G.online;
  G.running = false;
  clearInterval(G.tick);
  if (G.net){
    // 코인 지급은 판이 끝난 뒤에 온다. 보상 메시지만 남기고 잠깐 연결을 유지한다.
    const net = G.net;
    net.h = {reward: net.h.reward, rating: net.h.rating};
    setTimeout(()=> net.close(), 5000);
  }
  document.body.classList.remove("risk");
  const me = G.me; me.rank = me.rank || 1;
  const mins = Math.max(0, performance.now() - G.goAt) / 60000;
  const standings = G.players.slice().sort((a,b) => (a.rank || 99) - (b.rank || 99) || b.score - a.score);
  app.innerHTML = `
  <div class="over">
    <div class="big ${win?"win":""}">${win ? "WINNER" : me.rank + "위"}</div>
    <p>${win ? "마지막까지 살아남았다" : `${G.players.length}명 중 ${me.rank}위`}</p>
    <div class="reward num" id="reward"></div>
    <div class="rating" id="ratingLine"></div>
    <div class="final">
      <div class="card"><b class="num">${Math.round(me.strokes / Math.max(mins,.01))}</b><u>평균 타/분</u></div>
      <div class="card"><b class="num">${me.done}</b><u>완료 문장</u></div>
      <div class="card"><b class="num">${Math.round(mins*60)}</b><u>생존 초</u></div>
    </div>
    <div class="standings">${standings.map(p => `<div class="srow${p === me ? " me" : ""}${p.rank === 1 ? " first" : ""}"><b>${p.rank ? p.rank + "위" : "-"}</b><span>${esc(p === me ? "나" : p.name)}</span><u>${p.done}문장</u></div>`).join("")}</div>
    <button class="btn" id="again">${wasOnline ? "새 판 찾기" : "다시 하기"}</button>
    <button class="btn ghost" id="back">메뉴로</button>
  </div>`;
  $("#again").addEventListener("click", ()=> wasOnline ? menu("online") : start({}));
  $("#back").addEventListener("click", ()=> menu());
}

/* ---------- 관전 ---------- */
/* 탈락해도 게임은 계속된다. 남은 사람들이 치는 문장을 크게 보여 준다. */
function spectate(){
  G.spectating = true;
  G.watchOrder = "";
  document.body.classList.remove("risk");
  app.innerHTML = `
  <div class="hud" id="hud">
    <span class="tleft" id="tleft"></span>
    <span class="tick"><i id="tbar"></i></span>
    <span class="stat"><b class="num">${G.me.rank || "-"}</b><u>위로 탈락</u></span>
    <button class="snd" id="quit">나가기</button>
  </div>
  <div class="watchhead"><b>관전 중</b> · 남은 사람들이 치는 걸 보고 있다</div>
  <div class="watch" id="watch"></div>`;
  $("#quit").addEventListener("click", quitGame);
}
function quitGame(){
  const wasOnline = G.online;
  G.running = false;
  clearInterval(G.tick);
  if (G.net) G.net.close();
  document.body.classList.remove("risk");
  menu(wasOnline ? "online" : "solo");
}
function drawWatch(){
  const now = performance.now(), left = Math.max(0, G.nextElim - now);
  $("#tleft").textContent = `다음 탈락 ${(left/1000).toFixed(1)}초`;
  $("#tbar").style.width = Math.min(100, left / ELIM_MS * 100) + "%";
  const list = G.players.filter(p => p !== G.me).sort((a,b) => (b.alive - a.alive) || (b.score - a.score));
  const box = $("#watch"), order = list.map(p => p.id).join();
  if (G.watchOrder !== order){   // 순위가 바뀔 때만 카드를 다시 배치한다
    G.watchOrder = order;
    box.innerHTML = list.map(p => `
      <div class="wcard" id="w-${p.id}">
        <div class="top"><span class="rk"></span><span class="nm">${esc(p.name)}${p.acct ? ACCT_MARK : ""}</span><span class="dn"></span></div>
        <div class="wline"></div>
        <div class="pbar"><i></i></div>
      </div>`).join("");
  }
  const ranked = list.filter(p => p.alive);
  for (const p of list){
    const el = $("#w-" + p.id); if (!el) continue;
    el.classList.toggle("dead", !p.alive);
    el.querySelector(".rk").textContent = p.alive ? (ranked.indexOf(p) + 1) + "위" : (p.rank ? p.rank + "위 탈락" : "탈락");
    el.querySelector(".dn").textContent = p.done + "문장";
    el.querySelector(".pbar i").style.width = (p.progress * 100) + "%";
    const line = el.querySelector(".wline"), html = p.alive ? lineHtml(liveOf(p)) : "";
    if (line._h !== html){ line._h = html; line.innerHTML = html; }
  }
}

/* ---------- 렌더 ---------- */
function draw(){
  const now = performance.now(), me = G.me;

  if (G.slide){ G.slide = false; G.rebuild = false; advance(); }
  else if (!G.sliding && (G.rebuild || G.ver !== rowKey())){ G.rebuild = false; buildRows(); }

  const toGo = G.goAt - now, cd = toGo > 0 ? String(Math.ceil(toGo / 1000)) : toGo > -600 ? "GO" : "";
  if ($("#count").textContent !== cd){ $("#count").textContent = cd; if (cd) SFX.beep(cd === "GO"); }

  const left = Math.max(0, G.nextElim - now);
  $("#tleft").textContent = `다음 탈락 ${(left/1000).toFixed(1)}초`;
  $("#tbar").style.width = Math.min(100, left / ELIM_MS * 100) + "%";
  $("#hud").classList.toggle("danger", left < 5000);

  // 글자 상태
  const t = me.text, typed = me.typed;
  const wrongAt = firstWrong(typed, t, G.composing);
  let bad = wrongAt >= 0;
  for (let i=0;i<G.spans.length;i++){
    const s = G.spans[i];
    let st = "";
    if (i < typed.length){
      if (i === wrongAt) st = "no";
      else if (G.composing && i === typed.length-1) st = "comp";
      else st = "ok";
    } else if (i === typed.length) st = "cur";
    if (s.dataset.st !== st){
      s.dataset.st = st;
      s.className = "ch" + (s.dataset.dt ? " dt" : "") + (st ? " " + st : "");
    }
    // '가' 자리에 '그'를 치면 '그'가 보여야 한다
    const want = i < typed.length ? typed[i] : t[i];
    if (s.textContent !== want) s.textContent = want;
    // 대신 원래 글자도 위에 흐릿하게 남겨서 뭘 쳤어야 했는지 보이게 한다
    const ruby = st === "no" ? (t[i] === " " ? "␣" : t[i]) : "";
    if ((s.dataset.t || "") !== ruby) s.dataset.t = ruby;
  }
  const extra = typed.length > t.length ? typed.slice(t.length) : "";
  if (G.tail.textContent !== extra) G.tail.textContent = extra;
  if (extra) bad = true;
  if (bad && !G.hadErr){
    SFX.err();
    const row = $(".row.cur");
    if (row){ row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake"); }
  }
  G.hadErr = bad;

  const inc = me.incoming;
  // 한글 자리에 영문이, 영문 자리에 한글이 들어오면 한/영 전환을 안 한 것이다
  const last = typed.slice(-1), expect = t[typed.length - 1] || "";
  const wrongIme = last && ((HANGUL.test(last) && LATIN.test(expect)) || (LATIN.test(last) && HANGUL.test(expect)));
  $("#hint").innerHTML = wrongIme ? "<b>한/영 키를 눌러라</b>" : inc ? `대기 중인 공격 <b>${inc}</b>` : "";

  const mins = Math.max(0, now - G.goAt) / 60000;
  const good = [...typed].filter((c,i)=>c === t[i]).join("");
  $("#sCpm").textContent = Math.round((me.strokes + strokes(good)) / Math.max(mins,.01));
  $("#sAcc").textContent = me.keys ? Math.min(100, Math.round((me.strokes + strokes(good)) / me.keys * 100)) : 100;
  $("#sDone").textContent = me.done;
  const tier = fireTier(me.streak);
  $("#sStreak").textContent = me.streak;
  for (const el of [$("#hud"), $("#board")]){ el.classList.toggle("fire1", tier === 1); el.classList.toggle("fire2", tier === 2); }
  const aimed = G.players.find(p => p.id === G.target);
  const aimHtml = `대상 <b>${aimed ? esc(aimed.name) : "자동"}</b> · Tab`;
  if ($("#aimPill").innerHTML !== aimHtml) $("#aimPill").innerHTML = aimHtml;

  const ranked = G.players.filter(p=>p.alive).sort((a,b)=>b.score-a.score);
  $("#sRank").textContent = ranked.indexOf(me) + 1;
  document.body.classList.toggle("risk", me.alive && ranked.length > 1 && ranked.indexOf(me) === ranked.length - 1);

  const foes = G.players.filter(p => p !== me), box = $("#foes");
  if (box.children.length !== foes.length){
    box.innerHTML = foes.map(p=>`
      <div class="foe" id="foe-${p.id}" data-id="${p.id}">
        <div class="top"><span class="rk"></span><span class="nm">${esc(p.name)}${p.acct ? ACCT_MARK : ""}</span><span class="dn"></span></div>
        <div class="pbar"><i></i></div>
        <div class="meta"><span class="load"></span><span class="sp"></span></div>
        <div class="mini"></div>
      </div>`).join("");
  }
  for (const p of foes){
    const el = $("#foe-"+p.id); if (!el) continue;
    el.classList.toggle("dead", !p.alive);
    el.classList.toggle("target", G.target === p.id);
    el.querySelector(".pbar i").style.width = (p.progress*100) + "%";
    el.querySelector(".dn").textContent = p.done + "문장";
    el.querySelector(".rk").textContent = p.alive ? (ranked.indexOf(p)+1) + "위" : "OUT";
    el.querySelector(".load").textContent = p.alive && p.incoming ? "적재 " + p.incoming : "";
    el.querySelector(".sp").textContent = p.alive && p.cps ? Math.round(p.cps*strokesPerChar()*60) + "타/분" : "";
    const mini = el.querySelector(".mini"), mh = p.alive ? lineHtml(liveOf(p), MINI_BEFORE, MINI_AFTER) : "";
    if (mini._h !== mh){ mini._h = mh; mini.innerHTML = mh; }
  }

}

// 초대 링크(?room=코드)로 들어오면 닉네임부터 정하고 그 방으로 간다. 랭크전 방은 초대로 못 들어간다.
const invitedRoom = (new URLSearchParams(location.search).get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
if (invitedRoom && !invitedRoom.startsWith("RANK") && SERVER) invite(invitedRoom);
else menu();
// 계정은 화면을 먼저 띄운 뒤 불러와서 채운다. 기다렸다 그리면 느린 망에서 빈 화면이 오래 보인다.
takeLoginResult().then(loadAccount).then(()=>{
  applyLoadout(AUTH.user);
  const box = $("#account");
  if (box){ box.innerHTML = accountHtml(); wireAccount(); }
  const nickInput = $("#nick");
  if (nickInput && AUTH.user && !nickInput.value) nickInput.value = AUTH.user.nickname;
});
