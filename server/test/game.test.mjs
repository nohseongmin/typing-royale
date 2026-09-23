import assert from 'node:assert/strict';
import {test, beforeEach} from 'node:test';
import {Room} from '../src/index.js';

beforeEach(t=>{
  let seed=17;
  t.mock.method(Math,'random',()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296));
});

function game() {
  const messages=[];
  const room=new Room({},{});
  room.phase='playing'; room.lang='en'; room.playStartedAt=Date.now()-10000;
  room.send=(_ws,msg)=>messages.push(structuredClone(msg));
  room.fire=()=>{};
  const player={id:'p',name:'test',ws:{},alive:true,done:0,prog:0,pos:0,bad:false,dt:[],
    spent:0,streak:0,strikes:0,suspect:false,lastDoneAt:room.playStartedAt,progAt:room.playStartedAt};
  room.players.set(player.id,player);
  room.initSentences(player);
  return {room,player,messages};
}

test('final input completes without a preceding 100% progress frame',()=>{
  const {room,player}=game();
  room.onMessage(player,{t:'done',index:0,version:player.queue[0].v,text:player.line});
  assert.equal(player.done,1);
  assert.equal(player.prog,0);
});

test('completion replay and invented sentence are rejected',()=>{
  const {room,player}=game();
  const message={t:'done',index:0,version:player.queue[0].v,text:player.line};
  room.onMessage(player,{...message,text:'made up'});
  assert.equal(player.done,0);
  room.onMessage(player,message);
  room.onMessage(player,message);
  assert.equal(player.done,1);
});

test('forged progress, cursor, sentence and fire bonus do not set the score',()=>{
  const {room,player}=game();
  const line=player.line;
  room.onMessage(player,{t:'prog',index:0,text:'wrong',prog:1,pos:999,line:'fake'});
  assert.equal(player.line,line);
  assert.equal(player.prog,0);
  let shots=0; room.fire=()=>shots++;
  room.onMessage(player,{t:'done',index:0,version:player.queue[0].v,text:line,fire:999});
  const {strokes}=globalThis.TR_COMBAT;
  assert.equal(shots,2+(strokes(line)>=120 ? 2 : strokes(line)>=40 ? 1 : 0));
});

test('stale completion after attack is rejected and the updated sentence can be completed',()=>{
  const {room,player,messages}=game();
  const original=player.line;
  const version=player.queue[0].v;
  const attacker={id:'attacker',name:'attacker',aim:player.id};
  // Use the actual attack handler: the only alive opponent is player.
  Room.prototype.fire.call(room,attacker);
  assert.notEqual(player.line,original);
  room.onMessage(player,{t:'done',index:0,version,text:original});
  assert.equal(player.done,0);
  assert.ok(messages.some(m=>m.rejected));
  room.onMessage(player,{t:'done',index:0,version:player.queue[0].v,text:player.line});
  assert.equal(player.done,1);
});

test('attacks preserve the confirmed prefix and next sentence preview is authoritative',()=>{
  const {room,player,messages}=game();
  const prefix=player.line.slice(0,Math.floor(player.line.length/2));
  room.onMessage(player,{t:'prog',index:0,text:prefix});
  const attacker={id:'attacker',name:'attacker',aim:player.id};
  for(let i=0;i<5;i++) Room.prototype.fire.call(room,attacker);
  assert.ok(player.line.startsWith(prefix));
  const latest=messages.filter(m=>m.attack).at(-1);
  assert.deepEqual(latest.queue[1].words,player.queue[1].words);
  assert.ok(player.queue.slice(1).some(line=>line.hits>0));
});

test('old frames cannot erase current progress or replace the server sentence',()=>{
  const {room,player}=game();
  const line=player.line;
  room.onMessage(player,{t:'prog',index:0,text:line.slice(0,5)});
  assert.equal(player.pos,5);
  room.onMessage(player,{t:'prog',index:0,text:line.slice(0,2),line:'other'});
  room.onMessage(player,{t:'prog',index:99,text:line});
  assert.equal(player.pos,5);
  assert.equal(player.line,line);
});

test('excess cumulative typing speed earns no completion',()=>{
  const {room,player,messages}=game();
  room.playStartedAt=Date.now();
  player.spent=1000;
  for(let i=0;i<3;i++) room.onMessage(player,{t:'done',index:0,version:player.queue[0].v,text:player.line});
  assert.equal(player.done,0);
  assert.equal(player.suspect,true);
  assert.equal(messages.filter(m=>m.rejected).length,3);
});

test('Korean composition remains provisional until the syllable is committed',()=>{
  const {room,player}=game();
  player.queue[0]=globalThis.TR_COMBAT.makeLine({text:'가다 나무 아래에서 쉰다',slots:[]});
  room.currentSentence(player);
  room.onMessage(player,{t:'prog',index:0,text:'ㄱ',composing:true});
  assert.equal(player.pos,0); assert.equal(player.bad,false);
  room.onMessage(player,{t:'prog',index:0,text:'가',composing:false});
  assert.equal(player.pos,1); assert.equal(player.streak,2);
  room.onMessage(player,{t:'prog',index:0,text:'가x',composing:false});
  assert.equal(player.pos,1); assert.equal(player.streak,0);
});

test('reorder attacks cannot restore previously swapped words',()=>{
  const {makeLine,corrupt}=globalThis.TR_COMBAT;
  const line=makeLine({text:'alpha bravo charlie delta echo foxtrot golf hotel',slots:[]});
  assert.equal(corrupt(line,0,'reorder'),'reorder');
  const locked=[...line.swapped].map(i=>[i,line.words[i]]);
  assert.equal(corrupt(line,0,'reorder'),'reorder');
  for(const [i,word] of locked) assert.equal(line.words[i],word);
});
