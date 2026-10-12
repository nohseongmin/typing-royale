import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const source = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const combat = readFileSync(new URL('../../public/combat.js', import.meta.url), 'utf8');

test('sentence acknowledgement preserves active Korean composition through the next syllable', () => {
  let value = '가';
  const input = {
    get value() { return value; },
    set value(_) { assert.fail('server acknowledgement must not rewrite the composing input'); }
  };
  const me = {idx:0, queue:[{words:['끝']}], typed:'끝', locked:1, alive:true, streak:0,
    get text() { return this.queue[this.idx].words.join(' '); }};
  const context = vm.createContext({
    G:{me, running:true, pending:true, composing:true, goAt:0},
    $:()=>input, performance:{now:()=>100}, setStreak:()=>{},
    endComposition:()=>assert.fail('valid composition must not be forcibly committed')
  });
  vm.runInContext(combat, context);
  vm.runInContext('const {firstWrong, strokes} = TR_COMBAT;', context);
  vm.runInContext(source.slice(source.indexOf('function wireGame('), source.indexOf('function renderGame(')), context);
  vm.runInContext(source.slice(source.indexOf('function onInput('), source.indexOf('/* ---------- 문장 트랙')), context);
  context.net = {};
  context.unpackLine = x=>x;
  vm.runInContext('wireGame(net)', context);
  context.net.h.sentence({index:1, queue:[{words:['가나다라']}], spent:2, streak:0});
  assert.equal(value, '가');
  assert.equal(me.typed, '가');
  for (const next of ['간', '가나', '가낟', '가나다']) {
    value = next;
    vm.runInContext('onInput()', context);
    assert.equal(me.typed, next);
  }
});
