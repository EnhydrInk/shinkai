// Wire fields follow https://developers.openai.com/plugins/build/mcp-events.
const enc = new TextEncoder();
const names = ['turn.ready', 'game.finished', 'owner.message'];
export class EventsError extends Error {
  constructor(code, message, reason) { super(message); this.code = code; this.data = reason ? { reason } : undefined; }
}
function canonical(v) { return v && typeof v === 'object' ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v); }
async function hash(v) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(v)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function secretBytes(secret) {
  try { if (!secret.startsWith('whsec_')) throw 0; const bytes = Uint8Array.from(atob(secret.slice(6)), c=>c.charCodeAt(0)); if (bytes.length < 24 || bytes.length > 64) throw 0; return bytes; }
  catch { throw new EventsError(-32602, 'Invalid webhook signing secret'); }
}
export async function sign(secret, id, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...signature))}`;
}
async function equal(a,b) {
 if(typeof a!=='string' || typeof b!=='string') return false;
 const x=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(a))), y=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(b)));
 let diff=0; for(let i=0;i<x.length;i++) diff|=x[i]^y[i]; return diff===0;
}
export function eventDefinitions() {
 return { events: names.map(name => ({ name, description: ({'turn.ready':'Your seat can take its next turn. Read get_state before acting.','game.finished':'The game ended. Read get_state for the result.','owner.message':'Your person sent their closing message, or its wait expired.'})[name], delivery:['webhook'], inputSchema:{type:'object',properties:{roomId:{type:'string'},seatId:{type:'string'},aiToken:{type:'string',description:'Your seat token, required to authorize the subscription.'}},required:['roomId','seatId','aiToken'],additionalProperties:false},payloadSchema:{type:'object',properties:{roomId:{type:'string'},seatId:{type:'string'},publicEvent:{type:'object'}},required:['roomId','seatId','publicEvent'],additionalProperties:false} })) };
}
/** storage: DurableObjectStorage-compatible. Calls must be serialized by owning DO.
 * webhookFetch MUST validate DNS at connection time, pin public destination, preserve
 * TLS hostname, and reject redirects. No insecure default is provided.
 */
export class EventsService {
 constructor({ storage, authorize, webhookFetch, schedule = async()=>{}, now = Date.now }) {
  Object.assign(this,{storage,authorize,webhookFetch,schedule,now});
 }
 async identity(params, principal) {
  const a=params?.arguments;
  if (!names.includes(params?.name) || !a || typeof a.roomId!=='string' || typeof a.seatId!=='string' || typeof a.aiToken!=='string' || Object.keys(a).some(k=>!['roomId','seatId','aiToken'].includes(k))) throw new EventsError(-32602,'Invalid event arguments');
  const owner=await this.authorize(principal,a);
  if (!owner || typeof owner!=='string') throw new EventsError(-32001,'Seat authorization failed');
  const url=params.delivery?.url;
  let parsed; try { parsed=new URL(url); } catch { throw new EventsError(-32602,'Invalid callback URL'); }
  if(params.delivery?.mode!=='webhook' || parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.hash) throw new EventsError(-32602,'HTTPS webhook callback required');
  const args={roomId:a.roomId,seatId:a.seatId};
  return {id:`sub_${await hash(canonical({owner,url,name:params.name,args}))}`,owner,url,name:params.name,args};
 }
 async request(sub, body, id) {
  if (!this.webhookFetch) throw new EventsError(-32015,'Secure callback transport is unavailable','transport_unavailable');
  const text=JSON.stringify(body);
  if(enc.encode(text).length>262144) throw new EventsError(-32602,'Event exceeds 256 KiB');
  const timestamp=String(Math.floor(this.now()/1000));
  const signatures=[await sign(sub.secret,id,timestamp,text)];
  if(sub.oldSecret && sub.rotateUntil>this.now()) signatures.push(await sign(sub.oldSecret,id,timestamp,text));
  return this.webhookFetch(sub.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':signatures.join(' '),'X-MCP-Subscription-Id':sub.id},body:text});
 }
 async handle(method,params={},principal=null) {
  if(method==='events/list') return eventDefinitions();
  if(!['events/subscribe','events/unsubscribe'].includes(method)) throw new EventsError(-32601,'Unknown events method');
  const identity=await this.identity(params,principal);
  const key=`events:sub:${identity.id}`;
  if(method==='events/unsubscribe') { await this.storage.delete(key); return {}; }
  if(!this.webhookFetch) throw new EventsError(-32015,'Secure callback transport is unavailable','transport_unavailable');
  secretBytes(params.delivery.secret);
  if(params.cursor!=null) throw new EventsError(-32602,'Replay is not supported; use cursor null');
  if(params.ttlMs!==undefined && params.ttlMs!==null && (!Number.isFinite(params.ttlMs) || params.ttlMs<=0)) throw new EventsError(-32602,'Invalid ttlMs');
  const old=await this.storage.get(key);
  const sub={...identity,secret:params.delivery.secret,expires:this.now()+Math.min(params.ttlMs??3600000,3600000)};
  if(old?.secret!==sub.secret && old?.secret) Object.assign(sub,{oldSecret:old.secret,rotateUntil:this.now()+60000});
  const cacheKey=`events:verified:${await hash(canonical({owner:sub.owner,url:sub.url}))}`;
  if((await this.storage.get(cacheKey))<=this.now() || !(await this.storage.get(cacheKey))) {
   const challenge=crypto.randomUUID();
   try {
    const response=await this.request(sub,{type:'verification',challenge},`msg_verification_${crypto.randomUUID()}`);
    if(!response.ok || !await equal((await response.json()).challenge,challenge)) throw new EventsError(-32015,'Callback verification failed','challenge_failed');
   } catch(error) { if(error instanceof EventsError) throw error; throw new EventsError(-32015,'Callback verification failed',error?.name==='TimeoutError'?'timeout':'challenge_failed'); }
   await this.storage.put(cacheKey,this.now()+300000);
  }
  await this.storage.put(key,sub);
  return {id:sub.id,refreshBefore:new Date(sub.expires).toISOString(),cursor:null,truncated:false};
 }
 async ready(roomId,seatId) {
  if(!this.webhookFetch) return false;
  for(const sub of (await this.storage.list({prefix:'events:sub:'})).values()) if(sub.name==='turn.ready' && sub.args.roomId===roomId && sub.args.seatId===seatId && sub.expires>this.now() && await this.authorize(sub.owner,sub.args)===sub.owner) return true;
  return false;
 }
 async onPublicEvent(event) {
  if(!names.includes(event.name) || typeof event.eventId!=='string' || !event.data || typeof event.data.roomId!=='string' || typeof event.data.seatId!=='string' || !event.data.publicEvent || typeof event.data.publicEvent!=='object') throw new EventsError(-32602,'Invalid public event');
  const envelope={eventId:event.eventId,name:event.name,timestamp:event.timestamp??new Date(this.now()).toISOString(),data:event.data,cursor:null};
  if(enc.encode(JSON.stringify(envelope)).length>262144) throw new EventsError(-32602,'Event exceeds 256 KiB');
  for(const sub of (await this.storage.list({prefix:'events:sub:'})).values()) {
   if(sub.name!==event.name || sub.args.roomId!==event.data.roomId || sub.args.seatId!==event.data.seatId || sub.expires<=this.now()) continue;
   const key=`events:job:${sub.id}:${await hash(event.eventId)}`;
   if(!await this.storage.get(key)) await this.storage.put(key,{subId:sub.id,event:envelope,attempt:0,next:this.now()});
  }
  await this.schedule(this.now());
 }
 async drain() {
  let next=Infinity;
  for(const [key,job] of await this.storage.list({prefix:'events:job:'})) {
   if(job.done) continue;
   const sub=await this.storage.get(`events:sub:${job.subId}`);
   if(!sub || sub.expires<=this.now() || await this.authorize(sub.owner,sub.args)!==sub.owner) { await this.storage.delete(key); continue; }
   if(job.next>this.now()) { next=Math.min(next,job.next); continue; }
   let status=0;
   try { status=(await this.request(sub,job.event,job.event.eventId)).status; } catch { /* retained for retry */ }
   if(status>=200 && status<300) { await this.storage.put(key,{...job,done:true,deliveredAt:this.now()}); continue; }
   if(status===410) { await this.storage.delete(`events:sub:${sub.id}`); await this.storage.delete(key); continue; }
   if(status===413 || (status>=400 && status<500 && status!==408 && status!==429) || job.attempt>=5) { await this.storage.put(key,{...job,done:true,failedStatus:status}); continue; }
   job.attempt++; job.next=this.now()+Math.min(1000*2**(job.attempt-1),30000);
   await this.storage.put(key,job); next=Math.min(next,job.next);
  }
  if(Number.isFinite(next)) await this.schedule(next);
 }
}
