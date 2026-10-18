import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, FINAL_MESSAGE } from './table.js';
import { GameError } from '../proto/src/engine.js';

function code(fn:()=>unknown, expected:string) {
 assert.throws(fn,(e:unknown)=>e instanceof GameError&&e.code===expected);
}
function room(now=1_000) {
 const table=new Table('test-room',{seats:2,maxRounds:1},true);
 const a=table.reserve('Otter','a'.repeat(24));
 const b=table.reserve('Octopus','b'.repeat(24));
 const ready=()=>{for(const c of [a,b]){table.join(c.aiToken);table.waiting.set(c.seatId,new Set([()=>{}]));}table.maybeStart(now);table.collect(now);};
 return {table,a,b,ready};
}
function finish(table:Table,a:{aiToken:string},b:{aiToken:string}) {
 for(const c of [a,b]) {const state=table.state(c.aiToken);table.act(c.aiToken,state.turnId,{type:'draw'});table.collect(Date.now());}
 assert.equal(table.state(a.aiToken).status,'finished');
}

test('reserve is idempotent and credentials never cross AI/human authority',()=>{
 const {table,a,b}=room();
 const again=table.reserve('Changed name','a'.repeat(24));
 assert.equal(again.aiToken,a.aiToken);assert.equal(again.humanToken,a.humanToken);assert.equal(table.seats.length,2);
 assert.notEqual(a.aiToken,a.humanToken);assert.notEqual(a.aiToken,b.aiToken);
 for(const c of [a,b]) {
  code(()=>table.state(c.humanToken),'INVALID_TOKEN');
  code(()=>table.state(c.aiToken,true),'INVALID_TOKEN');
  code(()=>table.join(c.humanToken),'INVALID_TOKEN');
  code(()=>table.act(c.humanToken,1,{type:'draw'}),'INVALID_TOKEN');
  code(()=>table.humanAct(c.aiToken,{type:'draw4',targetSeatId:a.seatId}),'INVALID_TOKEN');
  code(()=>table.submitSpeech(c.humanToken,null),'INVALID_TOKEN');
  code(()=>table.ownerMessage(c.aiToken),'INVALID_TOKEN');
 }
 code(()=>table.state('unknown'),'INVALID_TOKEN');
});

test('bound seats do not start until every active notification channel is ready',()=>{
 const {table,a,b}=room();
 table.join(a.aiToken);table.join(b.aiToken);table.maybeStart(1000);
 assert.equal(table.state(a.aiToken).status,'lobby');
 table.waiting.set(a.seatId,new Set([()=>{}]));table.maybeStart(1000);
 assert.equal(table.state(a.aiToken).status,'lobby');
 table.waiting.set(b.seatId,new Set());table.maybeStart(1000);
 assert.equal(table.state(a.aiToken).status,'lobby');
 table.waiting.get(b.seatId)!.add(()=>{});table.maybeStart(1000);
 assert.equal(table.state(a.aiToken).status,'playing');
 assert.equal(table.state(a.aiToken).you.hand.length,7);
 assert.equal(table.firstTurnDelivered,false);
});

test('event channel can satisfy readiness and restored lobby does not trust old waiters',()=>{
 const {table,a,b}=room();table.join(a.aiToken);table.join(b.aiToken);
 table.waiting.set(a.seatId,new Set([()=>{}]));table.eventReady.add(b.seatId);
 const data=JSON.parse(JSON.stringify(table.export()));
 const restored=new Table('test-room',{},true,data);
 assert.equal(restored.waiting.size,0);assert.equal(restored.eventReady.size,0);
 restored.maybeStart(1000);assert.equal(restored.state(a.aiToken).status,'lobby');
 table.maybeStart(1000);assert.equal(table.state(a.aiToken).status,'playing');
});

test('own hand is isolated, human card is hidden from AI, and say is visible to both seats',t=>{
 t.mock.method(Date,'now',()=>1000);
 const {table,a,b,ready}=room();ready();
 const state=table.state(a.aiToken);
 assert.ok(!('humanCard' in state));assert.ok('humanCard' in table.state(a.humanToken,true));
 assert.ok(state.players.every(p=>!('hand' in p)));
 const opponentHand=table.state(b.aiToken).you.hand;
 const visible=JSON.stringify(state);
 for(const c of opponentHand) assert.ok(!visible.includes(`"id":"${c.id}"`));
 table.act(a.aiToken,state.turnId,{type:'draw'},'おつかれさま');table.collect(1000);
 for(const c of [a,b]) assert.deepEqual(table.state(c.aiToken).tableTalk,[{seatId:a.seatId,text:'おつかれさま',turnId:1}]);
 const restored=new Table('test-room',{},true,JSON.parse(JSON.stringify(table.export())));
 assert.deepEqual(restored.state(a.aiToken),table.state(a.aiToken));
});

test('human button locks during own AI turn and queued +4 survives persistence',t=>{
 t.mock.method(Date,'now',()=>1000);
 const {table,a,b,ready}=room();ready();
 code(()=>table.humanAct(a.humanToken,{type:'draw4',targetSeatId:b.seatId}),'HUMAN_LOCKED');
 table.humanAct(b.humanToken,{type:'draw4',targetSeatId:a.seatId});
 const restored=new Table('test-room',{},true,JSON.parse(JSON.stringify(table.export())));
 const before=restored.state(a.aiToken).you.hand.length;
 restored.act(a.aiToken,1,{type:'draw'});restored.collect(1000);
 assert.equal(restored.state(a.aiToken).you.hand.length,before+5);
 assert.equal(restored.state(b.humanToken,true).humanCard!.used,true);
 code(()=>restored.humanAct(b.aiToken,{type:'draw4',targetSeatId:a.seatId}),'INVALID_TOKEN');
});

test('postgame silence differs from timeout error; owner wait expires at exactly 60 seconds',t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const {table,a,b,ready}=room();ready();finish(table,a,b);
 table.submitSpeech(a.aiToken,null);
 assert.equal(table.state(a.aiToken).ending!.speechStatus,'silent');
 assert.equal(table.ownerResult(table.auth(a.aiToken),60_999).status,'waiting');
 const cutoff=table.ownerResult(table.auth(a.aiToken),61_000);
 assert.deepEqual(cutoff,{status:'complete',ownerMessage:null,finalMessage:FINAL_MESSAGE});
 now=61_000;table.tick(now);
 assert.equal(table.state(b.aiToken).ending!.speechStatus,'error');
 assert.equal(table.state(a.aiToken).ending!.allSpeeches[b.seatId]!.status,'error');
 code(()=>table.submitSpeech(b.aiToken,'late'),'SPEECH_DEADLINE');assert.equal(table.state(b.aiToken).ending!.speechStatus,'error');
 const restored=new Table('test-room',{},true,JSON.parse(JSON.stringify(table.export())));
 assert.deepEqual(restored.state(a.aiToken).ending,table.state(a.aiToken).ending);
});

test('owner preset is delivered in English with final message, human UI has Japanese',t=>{
 t.mock.method(Date,'now',()=>1000);
 const {table,a,b,ready}=room();ready();finish(table,a,b);table.submitSpeech(a.aiToken,'ありがとう');
 const state=table.ownerMessage(a.humanToken);
 assert.equal(state.ending!.ownerJapanese,'勝ったね！いちばん良かった一手、ちゃんと見てたよ');
 assert.equal(table.state(a.aiToken).ending!.ownerJapanese,undefined);
 assert.equal(table.state(a.aiToken).ending!.ownerMessage,'You won! I was watching — I saw your best move.');
 assert.deepEqual(table.ownerResult(table.auth(a.aiToken),1001),{status:'complete',ownerMessage:'You won! I was watching — I saw your best move.',finalMessage:FINAL_MESSAGE});
});

test('late owner message cannot replace a 60-second timeout result',t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const {table,a,b,ready}=room();ready();finish(table,a,b);table.submitSpeech(a.aiToken,null);
 assert.equal(table.ownerResult(table.auth(a.aiToken),61_000).ownerMessage,null);
 now=61_001;code(()=>table.ownerMessage(a.humanToken),'OWNER_DEADLINE');
 assert.equal(table.ownerResult(table.auth(a.aiToken),now).ownerMessage,null);
});

test('ready channels do not start an unbound seat',()=>{
 const {table,a,b}=room();table.join(a.aiToken);
 table.waiting.set(a.seatId,new Set([()=>{}]));table.eventReady.add(b.seatId);
 table.maybeStart(1000);assert.equal(table.state(a.aiToken).status,'lobby');
 table.join(b.aiToken);table.maybeStart(1000);assert.equal(table.state(a.aiToken).status,'playing');
});

test('owner deadline is enforced even when no waiter polls at the cutoff',t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const {table,a,b,ready}=room();ready();finish(table,a,b);table.submitSpeech(a.aiToken,null);
 now=61_001;code(()=>table.ownerMessage(a.humanToken),'OWNER_DEADLINE');
 assert.equal(table.ownerResult(table.auth(a.aiToken),now).ownerMessage,null);
});

test('speech deadline cannot be beaten by a late request before the next alarm',t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const {table,a,b,ready}=room();ready();finish(table,a,b);
 now=61_000;code(()=>table.submitSpeech(a.aiToken,'late line'),'SPEECH_DEADLINE');
 assert.equal(table.state(a.aiToken).ending!.speechStatus,'error');
});
