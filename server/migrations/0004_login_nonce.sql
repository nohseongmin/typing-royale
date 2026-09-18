-- 로그인 버튼을 누른 브라우저가 만든 값. 콜백 때 돌려줘서 브라우저가 자기 로그인인지 대조한다(로그인 CSRF 방지).
ALTER TABLE oauth_states ADD COLUMN nonce TEXT NOT NULL DEFAULT '';
