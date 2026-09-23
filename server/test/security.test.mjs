import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync, readFileSync} from 'node:fs';
import {grantRewards, kstDay} from '../src/shop.js';
import {applyRatings} from '../src/rank.js';
import {cleanNick} from '../src/auth.js';
import {nickAllowed} from '../src/nickname.js';
import worker, {ipScope, Matchmaker} from '../src/index.js';

// Execute the application's actual SQL with foreign keys and transactional D1 batches.
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).sort()) sql.exec(readFileSync(new URL(file, migrations), 'utf8'));
  sql.exec("INSERT INTO users(id,kakao_id,nickname,created_at) VALUES(1,'one','one',0),(2,'two','two',0)");
  const DB = {
    prepare(query) {
      const statement = sql.prepare(query);
      return {bind(...args) {
        return {all: async () => ({results: statement.all(...args)}),
          first: async () => statement.get(...args) ?? null,
          execute: () => ({results: statement.all(...args)})};
      }};
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = statements.map(s => s.execute()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    }
  };
  return {sql, DB};
}

test('deleted player does not abort remaining rewards or receive a phantom reward', async () => {
  const env = database();
  try {
    env.sql.exec('DELETE FROM users WHERE id=1');
    const rewards = await grantRewards(env, [{uid:1,rank:2,players:2},{uid:2,rank:1,players:2}]);
    assert.equal(rewards.has(1), false);
    assert.equal(rewards.get(2).coins, 35);
    assert.equal(env.sql.prepare('SELECT coins FROM users WHERE id=2').get().coins, 35);
  } finally { env.sql.close(); }
});

test('daily coin cap remains atomic across simultaneous payouts', async () => {
  const env = database();
  try {
    env.sql.prepare('INSERT INTO daily_coins VALUES(2,?,590)').run(kstDay());
    const rewards = await Promise.all(Array.from({length:3}, () => grantRewards(env,[{uid:2,rank:1,players:2}])));
    assert.equal(rewards.reduce((n,r) => n+r.get(2).coins,0),10);
    assert.equal(env.sql.prepare('SELECT earned FROM daily_coins').get().earned,600);
  } finally { env.sql.close(); }
});

test('aborted ranked match penalizes the leaver without using the daily pair cap', async () => {
  const env = database();
  try {
    const applied = await applyRatings(env,[{uid:1,ip:'a',rank:1},{uid:2,ip:'b',rank:2}],{onlyLosses:true});
    assert.equal(applied.has(1),false);
    assert.equal(applied.get(2).delta,-16);
    assert.equal(env.sql.prepare('SELECT COUNT(*) AS n FROM ranked_pairs').get().n,0);
  } finally { env.sql.close(); }
});

test('migration retains the table needed by the previous worker during rollout', () => {
  const env = database();
  try { assert.doesNotThrow(() => env.sql.prepare('INSERT INTO oauth_states(state,created_at,nonce) VALUES(?,?,?)').run('state',0,'nonce')); }
  finally { env.sql.close(); }
});

test('nickname normalization preserves Korean jamo and fullwidth input safely', () => {
  assert.equal(cleanNick('한글'.normalize('NFD')),'한글');
  assert.equal(cleanNick('ＫＩＭ１２３'),'KIM123');
  assert.equal(cleanNick('ㅋㅋ'),'ㅋㅋ');
  assert.equal(cleanNick('＜b＞이름＜/b＞'),'이름');
});

test('nickname guard allows common compounds while rejecting impersonation and explicit slurs', () => {
  for (const name of ['정보지킴이','감자지킴이','바보지만','텔레포트','텔레토비','토토로','졸라맨','고르곤졸라','봇치']) assert.ok(nickAllowed(name),name);
  for (const name of ['운영자2','진짜운영자','관리자님','GM김철수','admin1','씨발','보지','자지','정보지킴이씨발']) assert.equal(nickAllowed(name),false,name);
});

test('login steps have separate limits and blocked navigations return to the game', async () => {
  const keys=[];
  const env={RL:{limit:async ({key}) => {keys.push(key);return {success:false};}}};
  for (const path of ['/auth/kakao/start','/auth/kakao/callback','/auth/exchange']) {
    const response=await worker.fetch(new Request('https://game.test'+path),env);
    assert.equal(response.status,path.endsWith('exchange') ? 429 : 302);
    if (response.status===302) assert.equal(response.headers.get('Location'),'https://game.test/#login_error=busy');
  }
  assert.equal(new Set(keys).size,3);
});

test('foreign origin and unknown shop paths never query account data', async () => {
  const env={DB:{prepare(){throw new Error('unexpected database access');}}};
  assert.equal((await worker.fetch(new Request('https://game.test/shop',{headers:{Origin:'https://attacker.test'}}),env)).status,403);
  assert.equal((await worker.fetch(new Request('https://game.test/shop-invalid',{headers:{Authorization:'Bearer invalid'}}),env)).status,404);
});

test('IPv6 privacy addresses in one subnet share a rate-limit scope', () => {
  assert.equal(ipScope('2001:db8:abcd:1234::1'),ipScope('2001:0db8:abcd:1234:ffff:ffff:ffff:ffff'));
  assert.notEqual(ipScope('2001:db8:abcd:1235::1'),ipScope('2001:db8:abcd:1234::1'));
  assert.equal(ipScope('192.0.2.1'),'192.0.2.1');
});

test('matchmaking skips rooms already at the same-IP capacity', async () => {
  const mm=new Matchmaker();
  mm.rooms.set('AUTOFULL',{auto:true,ranked:false,lang:'ko',phase:'lobby',players:4,ips:{test:4},at:Date.now(),held:[],tickets:new Set()});
  const response=await mm.fetch(new Request('https://internal.test/join?ip=test'));
  assert.notEqual((await response.json()).code,'AUTOFULL');
});

test('invalid JSON shapes and oversized streamed bodies are rejected before DB access', async () => {
  const env={DB:{prepare(){throw new Error('unexpected database access');}}};
  for (const body of ['null','[]','1','"name"','{']) {
    assert.equal((await worker.fetch(new Request('https://game.test/me',{method:'POST',body}),env)).status,400);
  }
  assert.equal((await worker.fetch(new Request('https://game.test/me',{method:'POST',body:JSON.stringify({nickname:'a'.repeat(4096)})}),env)).status,413);
  assert.equal((await worker.fetch(new Request('https://game.test/logout',{method:'POST'}),env)).status,200);
});

test('rank settlement is internal-only and serialized before reading pair caps', async () => {
  const env=database();
  let queue=Promise.resolve();
  const state={blockConcurrencyWhile(fn){const result=queue.then(fn);queue=result.catch(()=>{});return result;}};
  const mm=new Matchmaker(state,env);
  try {
    const request=()=>new Request('https://internal.test/ratings',{method:'POST',body:JSON.stringify({entries:[{uid:1,ip:'a',rank:1},{uid:2,ip:'b',rank:2}],onlyLosses:false})});
    const results=await Promise.all(Array.from({length:4},()=>mm.fetch(request()).then(r=>r.json())));
    assert.equal(env.sql.prepare('SELECT games FROM ranked_pairs').get().games,3);
    assert.equal(new Map(results[3]).get(1).delta,0);
    assert.equal((await worker.fetch(request(),env)).status,404);
  } finally { env.sql.close(); }
});
