import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventsService, sign } from './index.mjs';
const secret='whsec_'+Buffer.alloc(32,5).toString('base64');
function fixture(fetcher) {
 const map=new Map(); let now=100000; let revoked=false; const schedules=[];
 const storage={get:async k=>structuredClone(map.get(k)),put:async(k,v)=>{map.set(k,structuredClone(v));},delete:async k=>map.delete(k),list:async({prefix})=>new Map([...map].filter(([k])=>k.startsWith(prefix)))};
 const calls=[];
 const service=new EventsService({storage,now:()=>now,schedule:async at=>schedules.push(at),authorize:async(p,a)=>!revoked&&(a.aiToken==='token'||p==='owner')?'owner':null,webhookFetch:fetcher?async(url,init)=>{calls.push(init); return fetcher(JSON.parse(init.body),init);}:undefined});
 const params={name:'turn.ready',arguments:{roomId:'r',seatId:'s',aiToken:'token'},delivery:{mode:'webhook',url:'https://callback.example/events',secret},cursor:null};
 return {service,params,map,calls,schedules,tick:n=>{now+=n;},revoke:()=>{revoked=true;}};
}
const ok=b=>new Response(JSON.stringify({challenge:b.challenge}),{status:200});
const event={eventId:'evt1',name:'turn.ready',data:{roomId:'r',seatId:'s',publicEvent:{type:'turn'}}};
test('signature matches independent Node HMAC',async()=>{
 const body='{"hello":"海"}';
 assert.equal(await sign(secret,'evt',123,body),'v1,'+createHmac('sha256',Buffer.alloc(32,5)).update('evt.123.'+body).digest('base64'));
});
test('verification, deterministic identity, persistent retry, ID preserved',async()=>{
 let deliveries=0; const f=fixture(b=>b.type==='verification'?ok(b):new Response('',{status:++deliveries===1?503:200}));
 const first=await f.service.handle('events/subscribe',f.params);
 assert.equal((await f.service.handle('events/subscribe',{...f.params,arguments:{aiToken:'token',seatId:'s',roomId:'r'}})).id,first.id);
 assert.equal(f.calls.length,1);
 await f.service.onPublicEvent(event); await f.service.drain();
 f.tick(1000); await f.service.drain();
 assert.equal(f.calls.length,3);
 assert.equal(f.calls[1].headers['webhook-id'],f.calls[2].headers['webhook-id']);
 assert.notEqual(f.calls[1].headers['webhook-signature'],f.calls[2].headers['webhook-signature']);
 await f.service.onPublicEvent(event); await f.service.drain(); assert.equal(f.calls.length,3);
});
test('wrong challenge and absent secure transport fail closed',async()=>{
 const f=fixture(()=>ok({challenge:'wrong'}));
 await assert.rejects(f.service.handle('events/subscribe',f.params),e=>e.code===-32015);
 assert.equal([...f.map.keys()].filter(k=>k.startsWith('events:sub:')).length,0);
 const g=fixture(); await assert.rejects(g.service.handle('events/subscribe',g.params),e=>e.data.reason==='transport_unavailable');
});
test('authorization, matching filter, revocation, unsubscribe are enforced',async()=>{
 const f=fixture(ok);
 await assert.rejects(f.service.handle('events/subscribe',{...f.params,arguments:{...f.params.arguments,aiToken:'bad'}}),e=>e.code===-32001);
 await f.service.handle('events/subscribe',f.params); assert.equal(await f.service.ready('r','s'),true);
 await f.service.onPublicEvent({...event,data:{...event.data,seatId:'other'}}); await f.service.drain(); assert.equal(f.calls.length,1);
 f.revoke(); assert.equal(await f.service.ready('r','s'),false);
 await f.service.onPublicEvent(event); await f.service.drain(); assert.equal(f.calls.length,1);
});
test('410 stops subscription, 413 stops job, TTL expires',async()=>{
 for(const status of [410,413]) { const f=fixture(b=>b.type==='verification'?ok(b):new Response('',{status})); await f.service.handle('events/subscribe',f.params); await f.service.onPublicEvent(event); await f.service.drain(); f.tick(60000); await f.service.drain(); assert.equal(f.calls.length,2); if(status===410) assert.equal(await f.service.ready('r','s'),false); }
 const f=fixture(ok); await f.service.handle('events/subscribe',{...f.params,ttlMs:500}); f.tick(501); assert.equal(await f.service.ready('r','s'),false);
});
test('only turn subscription marks ready; token never persists; unsubscribe idempotent',async()=>{
 const f=fixture(ok);
 const closing={...f.params,name:'owner.message'};
 await f.service.handle('events/subscribe',closing); assert.equal(await f.service.ready('r','s'),false);
 await f.service.handle('events/subscribe',f.params); assert.equal(await f.service.ready('r','s'),true);
 assert.equal(JSON.stringify([...f.map]).includes('aiToken'),false);
 await f.service.handle('events/unsubscribe',f.params); await f.service.handle('events/unsubscribe',f.params);
 assert.equal(await f.service.ready('r','s'),false);
});
test('pending queue and subscription recover in new service instance',async()=>{
 const f=fixture(ok); await f.service.handle('events/subscribe',f.params); await f.service.onPublicEvent(event);
 let delivered=0;
 const recovered=new EventsService({storage:f.service.storage,now:f.service.now,authorize:f.service.authorize,webhookFetch:async()=>{delivered++;return new Response('',{status:200});}});
 await recovered.drain(); assert.equal(delivered,1); await recovered.drain(); assert.equal(delivered,1);
});
