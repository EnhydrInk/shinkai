import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRelay } from './relay.mjs';
const token='test-only-not-a-real-relay-key-123456789';
const envelope=()=>({url:'https://callback.example/events',init:{headers:{'Content-Type':'application/json','webhook-id':'evt_test','webhook-timestamp':'123','webhook-signature':'v1,test','X-MCP-Subscription-Id':'sub_test'},body:'{"eventId":"evt_test"}'}});
async function serverFor(t,options={}) {
 const server=createRelay({token,...options});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin=`http://127.0.0.1:${server.address().port}`;
 return {origin,post:(body,auth=`Bearer ${token}`)=>fetch(`${origin}/deliver`,{method:'POST',headers:{'content-type':'application/json',authorization:auth},body:typeof body==='string'?body:JSON.stringify(body)})};
}
test('relay rejects unauthorized requests before invoking transport; health reveals no config',async t=>{
 let called=false;const {post,origin}=await serverFor(t,{webhookFetch:async()=>{called=true;throw Error();}});
 assert.equal((await post(envelope(),'Bearer wrong')).status,401);
 assert.equal(called,false);
 assert.deepEqual(await (await fetch(`${origin}/health`)).json(),{ok:true});
});
test('relay validates envelope, whitelist, JSON, and byte cap before transport',async t=>{
 let called=false;const {post}=await serverFor(t,{webhookFetch:async()=>{called=true;throw Error();}});
 for(const value of [{},[],null,{...envelope(),method:'GET'}, {...envelope(),init:{...envelope().init,method:'GET'}}, {...envelope(),init:{...envelope().init,headers:{...envelope().init.headers,Authorization:'secret'}}},'invalid JSON']) assert.equal((await post(value)).status,400);
 assert.equal((await post('x'.repeat(300*1024+1))).status,413);
 assert.equal(called,false);
});
test('relay uses real secure transport to reject private callback URL',async t=>{
 const {post}=await serverFor(t);const value=envelope();value.url='https://127.0.0.1/private';
 const response=await post(value);assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'Callback delivery failed'});
});
test('relay preserves signature/body bytes and callback status without forwarding other headers',async t=>{
 const input=envelope();let received;
 const {post}=await serverFor(t,{webhookFetch:async(url,init)=>{received={url,init};return new Response('{"challenge":"test"}',{status:202,headers:{'content-type':'application/json','set-cookie':'private'}});}});
 const response=await post(input);assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{status:202,body:'{"challenge":"test"}',responseHeaders:{'content-type':'application/json'}});
 assert.equal(received.url,input.url);assert.equal(received.init.method,'POST');assert.equal(received.init.redirect,'error');
 assert.equal(received.init.body,input.init.body);assert.equal(received.init.headers['webhook-signature'],'v1,test');
});
test('relay refuses absent or short shared tokens at startup',()=>{
 assert.throws(()=>createRelay(),/RELAY_TOKEN/);assert.throws(()=>createRelay({token:'short'}),/RELAY_TOKEN/);
});

test('EventsService challenge and event survive actual local HTTP relay with independent signature verification',async t=>{
 const {EventsService}=await import('./index.mjs');const {createHmac}=await import('node:crypto');
 const key=Buffer.alloc(32,7),secret=`whsec_${key.toString('base64')}`,seen=[];
 const {post}=await serverFor(t,{webhookFetch:async(_url,init)=>{
  const headers=init.headers;const body=JSON.parse(init.body);
  assert.equal(headers['webhook-signature'],`v1,${createHmac('sha256',key).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${init.body}`).digest('base64')}`);
  assert.ok(headers['x-mcp-subscription-id'].startsWith('sub_'));seen.push(body);
  return new Response(body.type==='verification'?JSON.stringify({challenge:body.challenge}):'',{status:200,headers:{'content-type':'application/json'}});
 }});
 const map=new Map();const storage={get:async key=>map.get(key),put:async(key,value)=>map.set(key,value),delete:async key=>map.delete(key),list:async({prefix})=>new Map([...map].filter(([key])=>key.startsWith(prefix)))};
 const service=new EventsService({storage,authorize:async()=> 'owner',webhookFetch:async(url,init)=>{
  const response=await post({url,init:{headers:init.headers,body:init.body}});assert.equal(response.status,200);
  const value=await response.json();return new Response(value.body,{status:value.status,headers:value.responseHeaders});
 }});
 await service.handle('events/subscribe',{name:'turn.ready',arguments:{roomId:'r',seatId:'s',aiToken:'test'},delivery:{mode:'webhook',url:'https://callback.example/events',secret},cursor:null});
 await service.onPublicEvent({eventId:'evt_relay',name:'turn.ready',timestamp:'2026-10-18T05:00:00Z',data:{roomId:'r',seatId:'s',publicEvent:{type:'turn_started',turnId:1}}});await service.drain();
 assert.equal(seen.length,2);assert.equal(seen[0].type,'verification');
 assert.deepEqual(seen[1],{eventId:'evt_relay',name:'turn.ready',timestamp:'2026-10-18T05:00:00Z',data:{roomId:'r',seatId:'s',publicEvent:{type:'turn_started',turnId:1}},cursor:null});
});
