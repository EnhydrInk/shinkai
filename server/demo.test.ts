import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECTS, GameEngine, GameError, makeDeck } from '../proto/src/engine.js';
import { makeDemoDeck } from './demo.js';

test('demo preserves exactly the original 104 cards for all room sizes',()=>{
 const original=makeDeck(EFFECTS).sort((a,b)=>a.id.localeCompare(b.id));
 for(const seats of [2,3,4]){
  const deck=makeDemoDeck(seats);
  assert.equal(deck.length,104);assert.equal(new Set(deck.map(c=>c.id)).size,104);
  assert.deepEqual([...deck].sort((a,b)=>a.id.localeCompare(b.id)),original);
  assert.equal(deck[seats*7]!.color,'red');assert.equal(deck[seats*7]!.value,'3');
 }
});

test('real engine deals seat 1 two red 5s and exposes their legal double play',()=>{
 for(const seats of [2,3,4]){
  const engine=new GameEngine({seats},{deck:makeDemoDeck(seats)});
  for(let i=0;i<seats;i++)engine.join(`Player ${i+1}`,1000);
  engine.start(1000);
  const view=engine.view('s1');
  assert.deepEqual(view.you.hand.slice(0,2).map(c=>[c.color,c.value]),[['red','5'],['red','5']]);
  assert.equal(view.topCard!.value,'3');assert.equal(view.topCard!.color,'red');
  const action=view.legalActions.find(a=>a.type==='play'&&a.secondCardId);
  assert.ok(action&&action.type==='play');
  assert.deepEqual([action.cardId,action.secondCardId].sort(),view.you.hand.slice(0,2).map(c=>c.id).sort());
  engine.act('s1',view.turnId,action,1010);
  assert.equal(engine.view('s1').you.hand.length,5);
 }
});

test('seed is repeatable, changes shuffled cards, and survives JSON serialization',()=>{
 const a=makeDemoDeck(4,7,42), b=makeDemoDeck(4,7,42), c=makeDemoDeck(4,7,43);
 assert.deepEqual(a,b);assert.notDeepEqual(a,c);
 assert.deepEqual(JSON.parse(JSON.stringify(a)),a);
 for(const deck of [a,c]){
  assert.equal(deck[0]!.value,'5');assert.equal(deck[4]!.value,'5');assert.equal(deck[28]!.value,'3');
 }
 const engine=new GameEngine({seats:4},{deck:JSON.parse(JSON.stringify(a))});
 for(let i=1;i<=4;i++)engine.join(`Player ${i}`,1000);
 engine.start(1000);
 const restored=GameEngine.fromState(JSON.parse(JSON.stringify(engine.exportState())));
 assert.deepEqual(restored.view('s1'),engine.view('s1'));
 assert.ok(restored.view('s1').legalActions.some(a=>a.type==='play'&&a.secondCardId));
});

test('invalid dimensions and seeds fail instead of returning an unusable deck',()=>{
 for(const [seats,hand,seed] of [[1,7,1],[5,7,1],[2,1,1],[2,11,1],[2,7,NaN],[2,7,1.5]])
  assert.throws(()=>makeDemoDeck(seats!,hand!,seed!),e=>e instanceof GameError&&e.code==='BAD_CONFIG');
});
