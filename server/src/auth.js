/**
 * 카카오 로그인과 세션. 게임 방(Durable Object)과 분리해서 계정만 다룬다.
 *
 * 흐름: /auth/kakao/start?n= → 카카오 인가 → /auth/kakao/callback 에서 코드 교환·회원번호 조회
 *       → 1분짜리 교환권 발급 → 게임 주소 # 뒤에 교환권을 붙여 돌려보낸다
 *       → 게임이 n을 대조한 뒤 /auth/exchange 로 진짜 세션을 받는다.
 * # 뒤 주소는 브라우저 방문 기록에 남아서 세션 대신 금방 쓸모없어지는 교환권을 싣는다.
 * 세션은 쿠키가 아니라 토큰(Authorization 헤더, 웹소켓은 서브프로토콜)이다.
 *
 * 필요한 설정: KAKAO_REST_KEY, KAKAO_CLIENT_SECRET (wrangler secret)
 */

import {tierOf} from "./rank.js";
import {nickAllowed, nickKey} from "./nickname.js";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TICKET_MS = 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 5;          // 계정 하나에 살아 있는 세션 수. 어디서 샌 옛 토큰이 계속 살아 있지 않게 오래된 것부터 지운다
const NICK_MAX = 12;
const REQUIRED = ["KAKAO_REST_KEY", "KAKAO_CLIENT_SECRET"];
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async text => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
const hmacKey = secret => crypto.subtle.importKey("raw", enc.encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign", "verify"]);

/* 로그인 state는 DB에 두지 않고 서명한다. 로그인 버튼을 연타해서 DB 한도를 태울 수 없다. */
async function signState(env, nonce) {
  const body = nonce + "." + Date.now();
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.KAKAO_CLIENT_SECRET), enc.encode("state:" + body));
  return body + "." + b64url(new Uint8Array(sig));
}
/* 서명이 맞고 10분 안이면 로그인을 시작한 브라우저의 n을 돌려준다 */
async function openState(env, state) {
  const [nonce, ts, sig] = String(state).split(".");
  if (!NONCE_RE.test(nonce || "") || !sig || !(Date.now() - Number(ts) <= STATE_TTL_MS)) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.KAKAO_CLIENT_SECRET), fromB64url(sig), enc.encode("state:" + nonce + "." + ts));
    return ok ? nonce : null;
  } catch {
    return null;   // 망가진 base64
  }
}

/* 태그를 먼저 떼고, 한글·영문·숫자·공백·밑줄·하이픈만 남긴다.
   꺾쇠만 지우면 "<b>이름</b>"이 "b이름/b"로 남아서 태그째 먼저 지운다.
   허용 목록이라 안 보이는 글자, 한글 채움 문자, 남의 글자를 흉내 내는 글자, 주소용 기호가 다 빠진다. */
export const cleanNick = raw => String(raw ?? "")
  .normalize("NFC").replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/<[^>]*>/g, "")
  .replace(/[^가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 _-]/g, "")
  .replace(/ +/g, " ").trim().slice(0, NICK_MAX);

const missingConfig = env => REQUIRED.filter(k => !env[k]);

export async function userFromToken(env, token) {
  if (!token || !env.DB) return null;
  return await env.DB.prepare(
    "SELECT u.id, u.nickname, u.coins, u.rating, u.ranked_games, u.sound, u.font, u.theme FROM sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.token_hash = ? AND s.expires_at > ? AND s.pending = 0 AND u.banned = 0"
  ).bind(await sha256(token), Date.now()).first();
}

export const bearer = request => {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
};

/* 처음 로그인한 카카오 회원의 계정. 카카오 프로필 이름은 실명인 경우가 많아서 쓰지 않고 임시 닉네임으로 시작한다. */
async function findOrCreateUser(env, kakaoId) {
  const byKakao = () => env.DB.prepare("SELECT id FROM users WHERE kakao_id = ?").bind(kakaoId).first();
  let user = await byKakao();
  for (let i = 0; i < 5 && !user; i++) {
    const nick = "플레이어" + String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
    // 닉네임이 겹치거나 같은 사람이 동시에 두 번 로그인하면 넣지 않고 다시 찾는다
    user = await env.DB.prepare("INSERT INTO users (kakao_id, nickname, nick_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id")
      .bind(kakaoId, nick, nickKey(nick), Date.now()).first() || await byKakao();
  }
  return user;
}

/* 인증 관련 경로면 응답을, 아니면 null을 돌려준다 */
export async function handleAuth(request, env, url, json) {
  const redirectUri = url.origin + "/auth/kakao/callback";

  if (url.pathname === "/auth/config") {
    return json({kakao: missingConfig(env).length === 0 && !!env.DB});
  }

  if (url.pathname === "/auth/kakao/start") {
    const missing = missingConfig(env);
    if (missing.length || !env.DB) {
      console.error("kakao login is not configured; missing:", missing.join(", ") || "DB binding");
      return json({error: "카카오 로그인이 아직 설정되지 않았다"}, 503);
    }
    // n은 로그인 버튼을 누른 브라우저가 만든 값이다. 돌아갈 때 그대로 붙여 주고 브라우저가 대조한다.
    // 남이 자기 계정으로 받은 콜백 주소를 보내서 그 계정으로 로그인시키는 걸 막는다.
    const nonce = url.searchParams.get("n") || "";
    if (!NONCE_RE.test(nonce)) return json({error: "잘못된 로그인 요청이다"}, 400);
    const authorize = new URL("https://kauth.kakao.com/oauth/authorize");
    authorize.search = new URLSearchParams({client_id: env.KAKAO_REST_KEY, redirect_uri: redirectUri, response_type: "code", state: await signState(env, nonce)});
    return Response.redirect(authorize.toString(), 302);
  }

  if (url.pathname === "/auth/kakao/callback") {
    // 결과는 항상 이 서버의 게임 화면으로만 돌려보낸다(열린 리다이렉트 방지)
    const back = params => Response.redirect(url.origin + "/#" + new URLSearchParams(params), 302);
    if (missingConfig(env).length || !env.DB) return back({login_error: "config"});
    const code = url.searchParams.get("code");
    if (!code) return back({login_error: url.searchParams.get("error") || "cancelled"});
    const nonce = await openState(env, url.searchParams.get("state"));
    if (!nonce) return back({login_error: "expired"});

    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded;charset=utf-8"},
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: env.KAKAO_REST_KEY,
        redirect_uri: redirectUri, code, client_secret: env.KAKAO_CLIENT_SECRET
      })
    });
    if (!tokenRes.ok) {
      console.error("kakao token exchange failed:", tokenRes.status);
      return back({login_error: "token"});
    }
    const {access_token} = await tokenRes.json();

    const meRes = await fetch("https://kapi.kakao.com/v2/user/me", {headers: {Authorization: "Bearer " + access_token}});
    if (!meRes.ok) {
      console.error("kakao user lookup failed:", meRes.status);
      return back({login_error: "profile"});
    }
    const kakao = await meRes.json();
    if (!kakao.id) return back({login_error: "profile"});

    const user = await findOrCreateUser(env, String(kakao.id));
    if (!user) return back({login_error: "account"});
    const now = Date.now(), ticket = randomToken();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),   // 모두의 만료된 세션·교환권 정리
      env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, pending) VALUES (?, ?, ?, 1)").bind(await sha256(ticket), user.id, now + TICKET_MS)
    ]);
    // ? 가 아니라 # 뒤에 붙인다. # 뒤는 서버 로그와 Referer에 남지 않는다.
    return back({ticket, n: nonce});
  }

  if (url.pathname === "/auth/exchange" && request.method === "POST") {
    const {ticket} = await request.json().catch(() => ({}));
    if (typeof ticket !== "string" || !ticket) return json({error: "교환권이 없다"}, 400);
    const now = Date.now();
    // 교환권은 한 번만 쓴다
    const row = await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ? AND pending = 1 AND expires_at > ? RETURNING user_id")
      .bind(await sha256(ticket), now).first();
    if (!row) return json({error: "로그인 시간이 지났다"}, 401);
    const session = randomToken();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(session), row.user_id, now + SESSION_MS),
      env.DB.prepare(
        "DELETE FROM sessions WHERE user_id = ? AND pending = 0 AND token_hash NOT IN " +
        "(SELECT token_hash FROM sessions WHERE user_id = ? AND pending = 0 ORDER BY expires_at DESC LIMIT ?)"
      ).bind(row.user_id, row.user_id, MAX_SESSIONS)
    ]);
    return json({session});
  }

  if (url.pathname === "/me") {
    const user = await userFromToken(env, bearer(request));
    if (!user) return json({error: "unauthorized"}, 401);
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (typeof body.nickname !== "string") return json({error: "닉네임은 문자열이어야 한다"}, 400);
      const nickname = cleanNick(body.nickname);
      if (!nickname) return json({error: "닉네임을 입력해라"}, 400);
      if (!nickAllowed(nickname)) return json({error: "쓸 수 없는 닉네임이다"}, 400);
      try {
        await env.DB.prepare("UPDATE users SET nickname = ?, nick_key = ? WHERE id = ?").bind(nickname, nickKey(nickname), user.id).run();
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) return json({error: "이미 누가 쓰는 닉네임이다"}, 409);
        throw e;
      }
      user.nickname = nickname;
    }
    return json({user: {...user, tier: tierOf(user.rating)}});
  }

  if (url.pathname === "/me/delete" && request.method === "POST") {
    const user = await userFromToken(env, bearer(request));
    if (!user) return json({error: "unauthorized"}, 401);
    // 탈퇴하면 계정에 딸린 기록을 바로 다 지운다
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM inventory WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM daily_coins WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM ranked_pairs WHERE a = ? OR b = ?").bind(user.id, user.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id)
    ]);
    return json({ok: true});
  }

  if (url.pathname === "/logout" && request.method === "POST") {
    // 로그아웃하면 모든 기기에서 나간다. 어디선가 샌 토큰도 같이 끊긴다
    const user = await userFromToken(env, bearer(request));
    if (user) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
    return json({ok: true});
  }

  return null;
}
