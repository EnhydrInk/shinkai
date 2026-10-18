import { GameEngine, GameError, type EngineState, type Rules, type Action, type HumanAction, type PublicEvent, type Card } from '../proto/src/engine.js';
import { makeDemoDeck } from './demo.js';

export const FINAL_MESSAGE = "That's the game — thanks for playing. Your person was right here watching you the whole time. Go tell them about it.";
export type Seat = { seatId:string; name:string; aiToken:string; humanToken:string; requestId:string; bound:boolean };
type Ending = { speech?:string|null; speechStatus:'pending'|'said'|'silent'|'error'; speechDeadline:number; ownerMessage?:string; ownerJapanese?:string; ownerDeadline?:number; delivered?:boolean };
export type DemoConfig={seed?:number;humanCards?:('draw4'|'swap'|'peek')[]};
export type OutboundEvent={eventId:string;name:'turn.ready'|'game.finished'|'owner.message';data:{roomId:string;seatId:string;publicEvent:Record<string,unknown>}};
export type TableData = { roomId:string; engine:EngineState; seats:Seat[]; talk:{seatId:string;text:string;turnId:number}[]; events:PublicEvent[]; endings:Record<string,Ending>; firstTurnDelivered:boolean; demo:boolean|DemoConfig; ownerNotified?:string[]; humanPeeks?:Record<string,{targetSeatId:string;card:Card}>;outbox?:OutboundEvent[] };
export class Table {
 engine:GameEngine;
 seats:Seat[]=[];
 talk:TableData['talk']=[];
 events:PublicEvent[]=[];
 endings:TableData['endings']={};
 firstTurnDelivered=false;
 ownerNotified=new Set<string>();
 outbox:OutboundEvent[]=[];
 humanPeeks:NonNullable<TableData["humanPeeks"]>={};
 readonly waiting=new Map<string, Set<()=>void>>();
 readonly eventReady=new Set<string>();
 constructor(readonly roomId:string, rules:Partial<Rules>={}, readonly demo:boolean|DemoConfig=false, data?:TableData) {
  const config=typeof demo==='object'?demo:{};
  if(config.humanCards&&(!Array.isArray(config.humanCards)||config.humanCards.some(c=>!['draw4','swap','peek'].includes(c))))throw new GameError('BAD_CONFIG','Invalid demo human cards');
  this.engine=data?GameEngine.fromState(data.engine):new GameEngine(rules,demo?{deck:makeDemoDeck(rules.seats??4,rules.initialHand??7,config.seed??1)}:{});
  if(data) { this.seats=data.seats;this.talk=data.talk;this.events=data.events;this.endings=data.endings;this.firstTurnDelivered=data.firstTurnDelivered;this.ownerNotified=new Set(data.ownerNotified??[]);this.humanPeeks=data.humanPeeks??{};this.outbox=data.outbox??[]; }
 }
 export():TableData { return {roomId:this.roomId,engine:this.engine.exportState(),seats:this.seats,talk:this.talk,events:this.events,endings:this.endings,firstTurnDelivered:this.firstTurnDelivered,demo:this.demo,ownerNotified:[...this.ownerNotified],humanPeeks:this.humanPeeks,outbox:this.outbox}; }
 reserve(name:string,requestId:string) {
  if(typeof requestId!=='string'||requestId.length<24||requestId.length>128) throw new GameError('BAD_REQUEST_ID','A private random requestId (24–128 characters) is required');
  const existing=this.seats.find(s=>s.requestId===requestId);
  if(existing) return this.credentials(existing);
  if(typeof name!=='string') throw new GameError('BAD_NAME','A name is required');
  const seatId=this.engine.join(name,Date.now());
  const seat={seatId,name:name.trim(),aiToken:crypto.randomUUID()+crypto.randomUUID(),humanToken:crypto.randomUUID()+crypto.randomUUID(),requestId,bound:false};
  this.seats.push(seat);
  if(this.demo) this.engine.setHumanCard(seatId,(typeof this.demo==='object'?this.demo.humanCards?.[this.seats.length-1]:undefined)??'draw4');
  return this.credentials(seat);
 }
 private credentials(s:Seat) { return {roomId:this.roomId,seatId:s.seatId,aiToken:s.aiToken,humanToken:s.humanToken,state:this.view(s,true)}; }
 auth(token:string,human=false) {
  const seat=this.seats.find(s=>(human?s.humanToken:s.aiToken)===token);
  if(!seat)throw new GameError('INVALID_TOKEN',human?'Invalid human credential':'Invalid AI credential');
  return seat;
 }
 join(token:string) { const s=this.auth(token);s.bound=true;return {state:this.view(s)}; }
 view(s:Seat,human=false) {
  const state=this.engine.view(s.seatId);
  const ending=this.endings[s.seatId];
  const visibleEnding=ending?{...ending}:null;if(visibleEnding&&!human)delete visibleEnding.ownerJapanese;
  return {...state, ...(human?{you:{...state.you,peek:this.humanPeeks[s.seatId]??state.you.peek}}:{}), roomId:this.roomId,players:state.players.map(p=>({...p,bound:this.seats.find(s=>s.seatId===p.seatId)?.bound??false})),tableTalk:this.talk.slice(-12),publicEvents:this.events.slice(-24),
   firstTurnDelivered:this.firstTurnDelivered,
   ...(human?{humanCard:this.engine.humanView(s.seatId)}:{}),
   ending:visibleEnding?{...visibleEnding,prompt:`The game has ended. Winners: ${state.result?.winners.join(', ')}. You have ${state.you.hand.length} cards left. You may say one line to anyone in Japanese, or choose silence. Then wait for your person's message using wait_for_owner.`,allSpeeches:Object.fromEntries(Object.entries(this.endings).map(([id,e])=>[id,{status:e.speechStatus,text:e.speech??null}]))}:null};
 }
 maybeStart(now:number) {
  if(this.seats.length!==this.engine.rules.seats||!this.seats.every(s=>s.bound&&(this.waiting.get(s.seatId)?.size||this.eventReady.has(s.seatId))))return;
  if(this.engine.view(this.seats[0]!.seatId).status==='lobby')this.engine.start(now);
 }
 collect(now:number) {
  const fresh=this.engine.takeEvents();
  for(const s of this.seats){const peek=this.engine.view(s.seatId).you.peek;if(peek)this.humanPeeks[s.seatId]=peek;}
  this.events.push(...fresh);this.events=this.events.slice(-64);
  for(const event of fresh)if(event.type==='game_finished') for(const s of this.seats)this.endings[s.seatId]={speechStatus:'pending',speechDeadline:now+60_000};
  for(const e of Object.values(this.endings))if(e.speechStatus==='pending'&&now>=e.speechDeadline){e.speechStatus='error';e.ownerDeadline=now+60_000;}
  return fresh;
 }
 tick(now=Date.now()) { this.engine.expire(now);return this.collect(now); }
 state(token:string,human=false) { const s=this.auth(token,human);return this.view(s,human); }
 act(token:string,turnId:number,action:Action,say?:string) {
  const s=this.auth(token);
  if(say!==undefined&&(typeof say!=='string'||say.length>300))throw new GameError('BAD_SPEECH','Table talk must be at most 300 characters');
  this.engine.act(s.seatId,turnId,action,Date.now());
  if(say?.trim())this.talk.push({seatId:s.seatId,text:say.trim(),turnId});
  this.talk=this.talk.slice(-32);
  return this.view(s);
 }
 humanAct(token:string,action:HumanAction) { const s=this.auth(token,true);this.engine.queueHumanCard(s.seatId,action,Date.now());return this.view(s,true); }
 submitSpeech(token:string,text:string|null) {
  this.tick();
  const s=this.auth(token);const e=this.endings[s.seatId];
  if(!e)throw new GameError('NOT_FINISHED','The game has not ended');
  if(e.speechStatus==='error')throw new GameError('SPEECH_DEADLINE','The 60-second postgame speech deadline has passed. Continue with wait_for_owner.');
  if(text!==null&&(typeof text!=='string'||text.length>300))throw new GameError('BAD_SPEECH','Use one Japanese line of at most 300 characters, or null for silence');
  if(e.speechStatus==='pending'){e.speech=text?.trim()||null;e.speechStatus=e.speech?'said':'silent';e.ownerDeadline=Date.now()+60_000;}
  return this.view(s);
 }
 ownerMessage(token:string) {
  this.tick();
  const s=this.auth(token,true), e=this.endings[s.seatId];
  if(!e)throw new GameError('NOT_FINISHED','The game has not ended');
  if(e.delivered||(e.ownerDeadline!==undefined&&Date.now()>=e.ownerDeadline))throw new GameError('OWNER_DEADLINE','The closing wait has already ended');
  const won=this.engine.view(s.seatId).result!.winners.includes(s.seatId);
  e.ownerMessage=won?'You won! I was watching — I saw your best move.':'I was watching, the whole way. Thank you.';
  e.ownerJapanese=won?'勝ったね！いちばん良かった一手、ちゃんと見てたよ':'ちゃんと見てたよ。ありがとう';
  return this.view(s,true);
 }
 ownerResult(s:Seat,now=Date.now()) {
  const e=this.endings[s.seatId];
  if(!e||e.speechStatus==='pending')throw new GameError('SPEECH_PENDING','Submit your optional postgame line or silence first');
  if(e.ownerMessage||now>=(e.ownerDeadline??Infinity)){e.delivered=true;return {status:'complete',ownerMessage:e.ownerMessage??null,finalMessage:FINAL_MESSAGE};}
  return {status:'waiting',ownerMessage:null};
 }
 notify() { for(const listeners of this.waiting.values())for(const f of [...listeners])f(); }
 get deadline() { const times=[this.engine.deadline,...Object.values(this.endings).flatMap(e=>e.speechStatus==='pending'?[e.speechDeadline]:!e.delivered&&((e.ownerDeadline??0)>Date.now())?[e.ownerDeadline??null]:[])].filter((x):x is number=>x!==null);return times.length?Math.min(...times):null; }
}
