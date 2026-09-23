// Explicit target only. Creates a private guest room; never uses ranked accounts or stored user data.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

const base = new URL(process.env.TEST_BASE_URL);
const sockets=[];
function connect(code, name, protocol='tr.v2') {
  const url=new URL('/ws',base); url.protocol=base.protocol==='https:' ? 'wss:' : 'ws:';
  url.search=new URLSearchParams({room:code,name,lang:'en'});
  const ws=new WebSocket(url,[protocol]); sockets.push(ws);
  const frames=[];
  ws.addEventListener('message',event=>frames.push(JSON.parse(event.data)));
  return {ws,frames,send:msg=>ws.send(JSON.stringify(msg)),async next(predicate) {
    const deadline=Date.now()+6000;
    while(Date.now()<deadline) {
      const found=frames.find(predicate); if(found) return found;
      await delay(20);
    }
    throw new Error('Timed out waiting for frame; received '+frames.map(m=>m.t).join(','));
  }};
}

try {
  const response=await fetch(new URL('/new',base));
  assert.equal(response.status,200);
  const {code}=await response.json();
  const legacy=connect(code,'LegacyCheck','tr.v1');
  assert.match((await legacy.next(m=>m.t==='denied')).reason,/새로고침/);
  const host=connect(code,'HostCheck'), guest=connect(code,'GuestCheck');
  await Promise.all([host.next(m=>m.t==='joined'),guest.next(m=>m.t==='joined')]);
  guest.send({t:'ready',on:true});
  await host.next(m=>m.t==='players' && m.players.some(p=>p.name==='GuestCheck' && p.ready));
  host.send({t:'start'});
  const [a,b]=await Promise.all([host.next(m=>m.t==='start'),guest.next(m=>m.t==='start')]);
  await delay(a.countdown+100);
  const text=a.queue[0].words.join(' ');
  host.send({t:'prog',index:0,text:text.slice(0,-1),prog:1,pos:999,line:'fake'});
  host.send({t:'done',index:0,version:a.queue[0].v,text,fire:999});
  const ack=await host.next(m=>m.t==='sentence' && m.accepted && m.index===1);
  await guest.next(m=>m.t==='sentence' && m.attack);
  await delay(100);
  guest.send({t:'done',index:0,version:b.queue[0].v,text:b.queue[0].words.join(' ')});
  const rejected=await guest.next(m=>m.t==='sentence' && m.rejected);
  assert.equal(rejected.index,0);
  const changed=rejected.queue[0];
  guest.send({t:'done',index:0,version:changed.v,text:changed.words.join(' ')});
  await guest.next(m=>m.t==='sentence' && m.accepted && m.index===1);
  host.send({t:'done',index:0,version:a.queue[0].v,text});
  await delay(100);
  assert.equal(host.frames.filter(m=>m.t==='sentence' && m.accepted).length,1);
  const live=host.frames.filter(m=>m.t==='sentence').at(-1);
  host.send({t:'done',index:1,version:live.queue[0].v,text:live.queue[0].words.join(' ')});
  const second=await host.next(m=>m.t==='sentence' && m.accepted && m.index===2);
  assert.ok(second.spent>ack.spent);
  console.log('PASS: legacy rejection, 2-player ready/start, final input, attack resync, replay rejection, consecutive completion');
} finally {
  for (const ws of sockets) ws.close();
}
