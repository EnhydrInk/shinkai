import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base=process.argv[2]??'http://127.0.0.1:8787';
async function api(path,value,token){return fetch(base+path,{method:value===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})}).then(r=>r.json());}
for(const type of ['swap','peek']){
 const room=await api('/api/rooms',{seats:2,maxRounds:2,demo:{seed:1,humanCards:[type,'draw4']}});assert.ok(room.ok);
 const path='/rooms/'+room.roomId;const seats=await Promise.all(['Otter','Octopus'].map(name=>api(path+'/seats',{name,requestId:crypto.randomUUID()})));
 const clients=seats.map((_,i)=>new Client({name:`human-card-${i}`,version:'1.0.0'}));await Promise.all(clients.map(c=>c.connect(new StreamableHTTPClientTransport(new URL(room.mcpUrl)))));
 const call=async(i,name,args={})=>{const raw=await clients[i].callTool({name,arguments:{token:seats[i].aiToken,...args}},undefined,{timeout:35000});return raw.structuredContent??JSON.parse(raw.content.find(c=>c.type==='text').text);};
 try{
  await Promise.all(clients.map((_,i)=>call(i,'join_game')));
  const waits=clients.map((_,i)=>call(i,'wait_for_my_turn'));const first=await waits[0];assert.equal(first.status,'your_turn');
  const action=type==='swap'?{type,cardId:first.state.you.hand[0].id}:{type,targetSeatId:seats[1].seatId};
  const locked=await api(path+'/human',{action},seats[0].humanToken);assert.equal(locked.code,'HUMAN_LOCKED');
  await call(0,'act',{turnId:first.state.turnId,action:{type:'draw'}});const second=await waits[1];assert.equal(second.status,'your_turn');
  const before=(await api(path+'/state',undefined,seats[0].humanToken)).state;
  const bad=await api(path+'/human',{action},seats[0].aiToken);assert.equal(bad.code,'INVALID_TOKEN');
  assert.ok((await api(path+'/human',{action},seats[0].humanToken)).ok);
  await call(1,'act',{turnId:second.state.turnId,action:{type:'draw'}});
  const human=(await api(path+'/state',undefined,seats[0].humanToken)).state;assert.equal(human.humanCard.used,true);
  if(type==='swap'){assert.equal(human.you.hand.length,before.you.hand.length);assert.ok(!human.you.hand.some(c=>c.id===action.cardId));}
  else{
   assert.ok(human.you.peek);const failed=await call(0,'act',{turnId:999,action:{type:'draw'}});assert.equal(failed.code,'STALE_TURN');assert.ok(failed.state.you.peek);
   const next=await call(0,'get_state');assert.equal(next.state.you.peek,null);assert.deepEqual((await api(path+'/state',undefined,seats[0].humanToken)).state.you.peek,human.you.peek);
  }
  console.log(JSON.stringify({type,ok:true,verified:['human authority','own-turn lock','scheduled effect',...(type==='peek'?['single AI delivery including error state','human retained original notice']:['selected card replaced','hand count conserved'])]}));
 }finally{await Promise.all(clients.map(c=>c.close()));}
}
