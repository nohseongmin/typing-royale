/**
 * 카카오 로그인과 세션. 게임 방(Durable Object)과 분리해서 계정만 다룬다.
 *
 * 흐름: /auth/kakao/start → 카카오 인가 → /auth/kakao/callback 에서 코드 교환·회원번호 조회
 *       → 세션 발급 → 게임 페이지로 돌려보내면서 주소 # 뒤에 세션 토큰을 붙인다.
 * 세션은 쿠키가 아니라 토큰(Authorization 헤더)이다. 게임 페이지(github.io)와 서버(workers.dev)
 * 도메인이 달라서 쿠키는 제3자 쿠키 차단에 막힌다.
 *
 * 필요한 설정: KAKAO_REST_KEY, KAKAO_CLIENT_SECRET (wrangler secret), APP_ORIGIN (wrangler.toml vars)
 */

import {tierOf} from "./rank.js";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const NICK_MAX = 12;
const REQUIRED = ["KAKAO_REST_KEY", "KAKAO_CLIENT_SECRET", "APP_ORIGIN"];
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async text => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

/* 태그·제어문자·남은 꺾쇠를 빼고 12자로 자른다. 화면에서도 이스케이프하지만 저장부터 깨끗하게 둔다.
   꺾쇠만 지우면 "<b>이름</b>"이 "b이름/b"로 남아서 태그째 먼저 지운다.
   글자 방향을 뒤집는 문자와 폭 없는 문자도 뺀다. 남의 닉네임처럼 보이게 꾸미는 데 쓰인다. */
export const cleanNick = raw => String(raw ?? "")
  .replace(/<[^>]*>/g, "")
  .replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
  .trim().slice(0, NICK_MAX);

const missingConfig = env => REQUIRED.filter(k => !env[k]);

export async function userFromToken(env, token) {
  if (!token || !env.DB) return null;
  return await env.DB.prepare(
    "SELECT u.id, u.nickname, u.coins, u.rating, u.ranked_games, u.sound, u.font, u.theme FROM sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256(token), Date.now()).first();
}

const bearer = request => {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
};

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
    const now = Date.now();
    const state = randomToken();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(now - STATE_TTL_MS),   // 로그인하다 그만둔 사람 것 정리
      env.DB.prepare("INSERT INTO oauth_states (state, created_at, nonce) VALUES (?, ?, ?)").bind(state, now, nonce)
    ]);
    const authorize = new URL("https://kauth.kakao.com/oauth/authorize");
    authorize.search = new URLSearchParams({client_id: env.KAKAO_REST_KEY, redirect_uri: redirectUri, response_type: "code", state});
    return Response.redirect(authorize.toString(), 302);
  }

  if (url.pathname === "/auth/kakao/callback") {
    // 결과는 항상 고정된 게임 주소로만 돌려보낸다(열린 리다이렉트 방지)
    const back = params => Response.redirect(env.APP_ORIGIN + "#" + new URLSearchParams(params), 302);
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    if (!code || !state) return back({login_error: url.searchParams.get("error") || "cancelled"});

    // state는 한 번만 쓰고 10분 지나면 무효. 남이 만든 인가 코드를 우리 콜백에 밀어 넣는 걸 막는다.
    const saved = await env.DB.prepare("DELETE FROM oauth_states WHERE state = ? RETURNING created_at, nonce").bind(state).first();
    if (!saved || Date.now() - saved.created_at > STATE_TTL_MS) return back({login_error: "expired"});

    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded;charset=utf-8"},
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: env.KAKAO_REST_KEY,
        redirect_uri: redirectUri, code, client_secret: env.KAKAO_CLIENT_SECRET
      })
    });
    if (!tokenRes.ok) {
      console.error("kakao token exchange failed:", tokenRes.status, await tokenRes.text());
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

    // 닉네임 동의항목은 비즈 앱이어야 받을 수 있어서 없으면 임시 닉네임으로 시작한다. 게임 안에서 바꾼다.
    const now = Date.now();
    const firstNick = cleanNick(kakao.kakao_account?.profile?.nickname) || "플레이어" + String(kakao.id).slice(-4);
    await env.DB.prepare("INSERT INTO users (kakao_id, nickname, created_at) VALUES (?, ?, ?) ON CONFLICT(kakao_id) DO NOTHING")
      .bind(String(kakao.id), firstNick, now).run();
    const user = await env.DB.prepare("SELECT id FROM users WHERE kakao_id = ?").bind(String(kakao.id)).first();

    const session = randomToken();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(user.id, now),
      env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(session), user.id, now + SESSION_MS)
    ]);
    // 토큰은 ? 가 아니라 # 뒤에 붙인다. # 뒤는 서버 로그와 Referer에 남지 않는다.
    return back({session, n: saved.nonce});
  }

  if (url.pathname === "/me") {
    const user = await userFromToken(env, bearer(request));
    if (!user) return json({error: "unauthorized"}, 401);
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const nickname = cleanNick(body.nickname);
      if (!nickname) return json({error: "닉네임을 입력해라"}, 400);
      await env.DB.prepare("UPDATE users SET nickname = ? WHERE id = ?").bind(nickname, user.id).run();
      user.nickname = nickname;
    }
    return json({user: {...user, tier: tierOf(user.rating)}});
  }

  if (url.pathname === "/logout" && request.method === "POST") {
    const token = bearer(request);
    if (token && env.DB) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ok: true});
  }

  return null;
}
