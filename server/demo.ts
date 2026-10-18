import { EFFECTS, GameError, makeDeck, parseRules, type Card } from '../proto/src/engine.js';

/** A repeatable recording deck; round-robin dealing gives seat 1 a legal red pair. */
export function makeDemoDeck(seats:number, initialHand=7, seed=1):Card[] {
 parseRules({seats,initialHand});
 if(initialHand<2)throw new GameError('BAD_CONFIG','The demo requires at least two initial cards');
 if(!Number.isSafeInteger(seed))throw new GameError('BAD_CONFIG','Demo seed must be a safe integer');
 const cards=makeDeck(EFFECTS);
 const pair=cards.filter(c=>c.color==='red'&&c.value==='5');
 const top=cards.find(c=>c.color==='red'&&c.value==='3')!;
 const reserved=new Set([...pair,top].map(c=>c.id));
 const rest=cards.filter(c=>!reserved.has(c.id));
 let state=seed>>>0;
 const random=()=>{
  state=(state+0x6D2B79F5)>>>0;
  let value=state;
  value=Math.imul(value^(value>>>15),value|1);
  value^=value+Math.imul(value^(value>>>7),value|61);
  return ((value^(value>>>14))>>>0)/4294967296;
 };
 for(let i=rest.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[rest[i],rest[j]]=[rest[j]!,rest[i]!];}
 const deck:Card[]=[];
 let index=0;
 for(let i=0;i<cards.length;i++)deck.push(i===0?pair[0]!:i===seats?pair[1]!:i===seats*initialHand?top:rest[index++]!);
 return deck;
}
