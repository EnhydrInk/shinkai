import { DurableObject } from 'cloudflare:workers';
import { Table, type TableData } from './table.js';
import { GameError, type Action, type HumanAction, type Rules } from '../proto/src/engine.js';
import { TOOLS, PLAYER_INSTRUCTIONS } from './tools.js';
import { protocolRequest } from './protocol.js';
import { EventsService, EventsError } from '../events/index.mjs';
interface Env { ROOMS:DurableObjectNamespace<TableRoom>; EVENTS_RELAY_URL?:string; EVENTS_RELAY_TOKEN?:string }
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}});
const MAX_BODY=16_384;
async function body(req:Request):Promise<any> {const raw=await req.text();if(raw.length>MAX_BODY)throw new GameError('BODY_TOO_LARGE','Request body too large');return JSON.parse(raw);}
export default {
 async fetch(req:Request,env:Env):Promise<Response> {
  const url=new URL(req.url);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,MCP-Protocol-Version,Mcp-Method,Mcp-Name','Access-Control-Max-Age':'86400'}});
  if(url.pathname==='/health')return json({ok:true,name:'shinkai'});
  if(url.pathname==='/api/rooms'&&req.method==='POST') {
   try { const p=await body(req);const id=crypto.randomUUID();const stub=env.ROOMS.get(env.ROOMS.idFromName(id));return stub.fetch(new Request(`${url.origin}/rooms/${id}/init`,{method:'POST',body:JSON.stringify({seats:p.seats,maxRounds:p.maxRounds,demo:p.demo===true||(p.demo&&typeof p.demo==='object')?p.demo:false})})); }catch(e){return json({ok:false,message:e instanceof Error?e.message:'Invalid room request'},400);}
  }
  const match=url.pathname.match(/^\/rooms\/([a-f0-9-]{36})(?:\/|$)/);
  if(!match)return json({ok:false,message:'Create a room using POST /api/rooms, then use its private seat credentials.'},404);
  return env.ROOMS.get(env.ROOMS.idFromName(match[1]!)).fetch(req);
 }
};
export class TableRoom extends DurableObject<Env> {
 table:Table|undefined;
 events:EventsService;
 eventAlarm:number|null=null;
 constructor(ctx:DurableObjectState,env:Env) {
  super(ctx,env);
  this.events=new EventsService({storage:ctx.storage as any,
  ...(env.EVENTS_RELAY_URL&&env.EVENTS_RELAY_TOKEN?{webhookFetch:async(url:string,init:RequestInit)=>{
   const response=await fetch(env.EVENTS_RELAY_URL+'/deliver',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.EVENTS_RELAY_TOKEN}`},body:JSON.stringify({url,init:{headers:Object.fromEntries(new Headers(init.headers)),body:init.body}}),signal:init.signal??AbortSignal.timeout(10000)});
   if(!response.ok)throw new Error('Secure callback relay unavailable');
   const result=await response.json() as {status:number;body:string;responseHeaders:Record<string,string>};
   return new Response([204,205,304].includes(result.status)?null:result.body,{status:result.status,headers:result.responseHeaders});
  }}:{}),authorize:async(principal,args)=>{
   if(!this.table||args.roomId!==this.table.roomId)return null;
   if(args.aiToken){try {const seat=this.table.auth(args.aiToken);return seat.bound&&seat.seatId===args.seatId?seat.seatId:null;}catch{return null;}}
   return this.table.seats.some(s=>s.seatId===principal&&s.seatId===args.seatId&&s.bound)?principal:null;
  },schedule:async(at)=>{this.eventAlarm=this.eventAlarm===null?at:Math.min(this.eventAlarm,at);await this.schedule();}});
  ctx.blockConcurrencyWhile(async()=>{const data=await ctx.storage.get<TableData>('table');if(data)this.table=new Table(data.roomId,{},data.demo,data);});
 }
 async schedule() {
  const times=[this.table?.deadline??null,this.eventAlarm].filter((x):x is number=>x!==null);
  if(times.length)await this.ctx.storage.setAlarm(Math.max(Date.now()+10,Math.min(...times)));
  else await this.ctx.storage.deleteAlarm();
 }
 async save() {if(this.table)await this.ctx.storage.put('table',this.table.export());await this.schedule();}
 async changed() {
  const table=this.table!,fresh=table.tick();
  for(const event of fresh) {
   const recipients=event.type==='turn_started'?[event.seatId]:event.type==='game_finished'?table.seats.map(s=>s.seatId):[];
   for(const seatId of recipients)table.outbox.push({eventId:`${table.roomId}:${event.type}:${event.type==='turn_started'?event.turnId:'end'}:${seatId}`,name:event.type==='turn_started'?'turn.ready':'game.finished',data:{roomId:table.roomId,seatId,publicEvent:event.type==='game_finished'?{type:event.type,winners:event.winners}:event as unknown as Record<string,unknown>}});
  }
  for(const [seatId,ending] of Object.entries(table.endings)) {
   if(ending.speechStatus==='pending'||table.ownerNotified.has(seatId)||(!ending.ownerMessage&&Date.now()<(ending.ownerDeadline??Infinity)))continue;
   const result=table.ownerResult(table.seats.find(s=>s.seatId===seatId)!);
   table.outbox.push({eventId:`${table.roomId}:owner:${seatId}`,name:'owner.message',data:{roomId:table.roomId,seatId,publicEvent:{type:'owner_message',...result}}});
   table.ownerNotified.add(seatId);
  }
  // The snapshot and its outbound notifications persist together before delivery.
  await this.save();
  for(const event of [...table.outbox]) {
   await this.events.onPublicEvent(event);
   table.outbox=table.outbox.filter(item=>item.eventId!==event.eventId);
   await this.save();
  }
  table.notify();
  for(const ws of this.ctx.getWebSockets()){try{const attachment=ws.deserializeAttachment() as {seatId:string};const s=table.seats.find(s=>s.seatId===attachment.seatId);if(s)ws.send(JSON.stringify({type:'state',state:table.view(s,true)}));}catch{ws.close(1011,'Reconnect');}}
 }
 async alarm(){this.eventAlarm=null;await this.changed();await this.events.drain();await this.schedule();}
 async fetch(req:Request):Promise<Response> {
  const url=new URL(req.url),path=url.pathname.split('/').slice(3).join('/');
  try {
   if(path==='init'&&req.method==='POST') {
    if(this.table)throw new GameError('EXISTS','Room exists');const p=await body(req);const roomId=url.pathname.split('/')[2]!;
    this.table=new Table(roomId,{seats:p.seats??4,maxRounds:p.maxRounds??10},(p.demo===true||(p.demo&&typeof p.demo==='object'))?p.demo:false);await this.save();return json({ok:true,roomId,mcpUrl:`${url.origin}/rooms/${roomId}/mcp`});
   }
   if(!this.table)return json({ok:false,message:'Room not found'},404);
   if(path==='mcp')return await this.mcp(req);
   if(path==='socket'&&req.headers.get('Upgrade')?.toLowerCase()==='websocket') {
    const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({seatId:null});return new Response(null,{status:101,webSocket:pair[0]});
   }
   await this.changed();
   if(path==='seats'&&req.method==='POST'){const p=await body(req);const value=this.table.reserve(p.name,p.requestId);await this.changed();return json({ok:true,...value});}
   const auth=req.headers.get('Authorization')?.replace(/^Bearer /,'')??'';
   if(path==='state'&&req.method==='GET')return json({ok:true,state:this.table.state(auth,true)});
   if(path==='human'&&req.method==='POST'){const p=await body(req);this.table.humanAct(auth,p.action as HumanAction);await this.changed();return json({ok:true,state:this.table.state(auth,true)});}
   if(path==='owner-message'&&req.method==='POST'){this.table.ownerMessage(auth);await this.changed();return json({ok:true,state:this.table.state(auth,true)});}
   if(path==='instructions'&&req.method==='GET'){this.table.auth(auth,true);return json({ok:true,instructions:PLAYER_INSTRUCTIONS});}
   return json({ok:false,message:'Unknown endpoint'},404);
  }catch(e){return json({ok:false,code:e instanceof GameError?e.code:'BAD_REQUEST',message:e instanceof Error?e.message:'Invalid request'},400);}
 }
 async webSocketMessage(ws:WebSocket,message:string|ArrayBuffer) {
  try {const p=JSON.parse(typeof message==='string'?message:new TextDecoder().decode(message));if(p.type!=='authenticate')throw new Error('Authenticate first');const seat=this.table!.auth(p.token,true);ws.serializeAttachment({seatId:seat.seatId});ws.send(JSON.stringify({type:'state',state:this.table!.view(seat,true)}));}catch{ws.close(1008,'Invalid human credential');}
 }
 async webSocketClose(ws:WebSocket,code:number){ws.close(code);}
 async wait(token:string,waitMs:number,owner=false) {
  const table=this.table!,seat=table.auth(token);
  if(!seat.bound)throw new GameError('NOT_JOINED','Call join_game first');
  if(!owner)for(const s of table.seats){if(await this.events.ready(table.roomId,s.seatId))table.eventReady.add(s.seatId);else table.eventReady.delete(s.seatId);}
  const duration=Math.min(25000,Math.max(0,Number.isFinite(waitMs)?waitMs:25000));
  return await new Promise<any>((resolve,reject)=>{
   let settled=false;let timeout:ReturnType<typeof setTimeout>|undefined;
   const listeners=table.waiting.get(seat.seatId)??new Set<()=>void>();table.waiting.set(seat.seatId,listeners);
   const cleanup=()=>{settled=true;if(timeout)clearTimeout(timeout);listeners.delete(check);};
   const check=(force=false)=>{if(settled)return;try{
    const state=table.view(seat);const result=owner?table.ownerResult(seat):{status:state.status==='finished'?'finished':state.currentSeatId===seat.seatId?'your_turn':'waiting',state};
    if(force||result.status!=='waiting'){if(!owner&&result.status==='your_turn'&&state.turnId===1)table.firstTurnDelivered=true;cleanup();resolve(result);}
   }catch(e){cleanup();reject(e);}};
   listeners.add(check);timeout=setTimeout(()=>check(true),duration);
   if(!owner)table.maybeStart(Date.now());
   void this.changed().then(()=>check()).catch(e=>{cleanup();reject(e);});
  });
 }
 async mcp(req:Request):Promise<Response> {
  if(req.method==='GET'||req.method==='DELETE')return new Response(null,{status:405,headers:{Allow:'POST'}});
  if(req.method!=='POST')return new Response(null,{status:405});
  let rpc:any;try{rpc=await body(req);}catch{return json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},400);}
  const id=rpc.id??null;const method=rpc.method;const p=rpc.params??{};
  const protocol=protocolRequest(req,rpc);
  if(protocol.error)return json({jsonrpc:'2.0',id,error:protocol.error},protocol.status);
  const modern=protocol.modern;
  const complete=(value:any)=>modern?{...value,resultType:'complete',_meta:{'io.modelcontextprotocol/serverInfo':{name:'shinkai',version:'1.0.0'}}}:value;
  const response=(value:any)=>json({jsonrpc:'2.0',id,result:complete(value)});
  try {
   if(method==='initialize')return response({protocolVersion:modern?'2026-07-28':'2025-11-25',capabilities:{tools:{},...(modern?{events:{}}:{})},serverInfo:{name:'shinkai',version:'1.0.0'},instructions:PLAYER_INSTRUCTIONS});
   if(method?.startsWith('notifications/'))return new Response(null,{status:202});
   if(method==='ping')return response({});
   if(method==='server/discover')return response({supportedVersions:['2026-07-28'],capabilities:{tools:{},events:{}},instructions:PLAYER_INSTRUCTIONS,ttlMs:0,cacheScope:'private'});
   if(method?.startsWith('events/')){const result=await this.events.handle(method,p,p.arguments?.aiToken??null);for(const s of this.table!.seats)if(await this.events.ready(this.table!.roomId,s.seatId))this.table!.eventReady.add(s.seatId);else this.table!.eventReady.delete(s.seatId);this.table!.maybeStart(Date.now());await this.changed();return response(result);}
   if(method==='tools/list')return response({tools:TOOLS,ttlMs:0,cacheScope:'private'});
   if(method!=='tools/call')throw new EventsError(-32601,'Unknown method');
   const a=p.arguments??{},table=this.table!;let value:any;
   try{
    await this.changed();
    switch(p.name){
     case 'join_game':value=table.join(a.token);break;
     case 'get_state':{const s=table.auth(a.token);if(table.engine.view(s.seatId).turnId===1&&table.engine.view(s.seatId).currentSeatId===s.seatId)table.firstTurnDelivered=true;value={state:table.view(s)};break;}
     case 'wait_for_my_turn':value=await this.wait(a.token,a.waitMs??25000);break;
     case 'act':table.act(a.token,a.turnId,a.action as Action,a.say);value={state:table.state(a.token)};break;
     case 'submit_postgame':value={state:table.submitSpeech(a.token,a.text)};break;
     case 'wait_for_owner':value=await this.wait(a.token,a.waitMs??25000,true);break;
     default:throw new GameError('UNKNOWN_TOOL','Unknown tool');
    }
    await this.changed();
    // Refresh the returned state after public events and ending prompts were collected.
    if(value.state){value.state=table.state(a.token);const s=table.auth(a.token);if(value.state.you.peek){table.engine.consumePeek(s.seatId);await this.save();}}
    return response({content:[{type:'text',text:JSON.stringify({ok:true,...value})}],structuredContent:{ok:true,...value},isError:false});
   }catch(e){await this.changed();let state;try{state=table.state(a.token);if(state.you.peek){table.engine.consumePeek(table.auth(a.token).seatId);await this.save();}}catch{}const value={ok:false,code:e instanceof GameError?e.code:'BAD_REQUEST',message:e instanceof Error?e.message:'Invalid request',...(state?{state}:{})};return response({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:true});}
  }catch(e){return json({jsonrpc:'2.0',id,error:{code:e instanceof EventsError?e.code:-32603,message:e instanceof Error?e.message:'Internal error',...(e instanceof EventsError&&e.data?{data:e.data}:{})}});}
 }
}
