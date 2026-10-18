import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFile } from 'node:fs/promises';
const base=process.argv[2];if(!base)throw Error('Pass server origin');
async function api(path,params,token){const r=await fetch(base+path,{method:params===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(params!==undefined?{body:JSON.stringify(params)}:{})});return r.json();}
const room=await api('/api/rooms',{seats:2,maxRounds:2,demo:true});assert.equal(room.ok,true,JSON.stringify(room));
const prefix=`/rooms/${room.roomId}`;
const seats=await Promise.all(['Otter','Octopus'].map(name=>api(prefix+'/seats',{name,requestId:crypto.randomUUID()})));
assert.ok(seats.every(s=>s.ok));
const clients=seats.map((_,i)=>new Client({name:`smoke-${i}`,version:'1.0.0'}));
await Promise.all(clients.map(c=>c.connect(new StreamableHTTPClientTransport(new URL(room.mcpUrl)))));
const call=async(i,name,args={})=>{const raw=await clients[i].callTool({name,arguments:{token:seats[i].aiToken,...args}},undefined,{timeout:35000});const value=JSON.parse(raw.content.find(c=>c.type==='text').text);assert.equal(value.ok,true,JSON.stringify(value));return value;};
try{
 assert.equal((await clients[0].listTools()).tools.length,6);
 await Promise.all(clients.map((_,i)=>call(i,'join_game')));
 const lobby=await call(0,'get_state');assert.equal(lobby.state.status,'lobby');
 const bad=await api(prefix+'/state',undefined,seats[0].aiToken);assert.equal(bad.ok,false);
 const pending=clients.map((_,i)=>call(i,'wait_for_my_turn'));
 const first=await pending[0];assert.equal(first.status,'your_turn');assert.equal(first.state.you.hand.length,7);
 const q=await api(prefix+'/human',{action:{type:'draw4',targetSeatId:seats[0].seatId}},seats[1].humanToken);assert.equal(q.ok,true);
 await call(0,'act',{turnId:first.state.turnId,action:{type:'draw'},say:'海の底でひと休み。'});
 const second=await pending[1];assert.equal(second.status,'your_turn');
 const a=await call(0,'get_state');assert.equal(a.state.you.hand.length,12);assert.equal(a.state.tableTalk[0].text,'海の底でひと休み。');assert.ok(a.state.publicEvents.some(e=>e.type==='human_card_played'&&e.card==='draw4'));
 const otherHand=(await call(1,'get_state')).state.you.hand;
 const visible=JSON.stringify(a.state);for(const card of otherHand)assert.ok(!visible.includes(`"id":"${card.id}"`));
 await call(1,'act',{turnId:second.state.turnId,action:{type:'draw'}});
 for(let n=0;n<8;n++){const s=(await call(0,'get_state')).state;if(s.status==='finished')break;const i=seats.findIndex(p=>p.seatId===s.currentSeatId);const current=await call(i,'wait_for_my_turn');await call(i,'act',{turnId:current.state.turnId,action:{type:'draw'}});}
 for(let i=0;i<2;i++){assert.equal((await call(i,'get_state')).state.status,'finished');await call(i,'submit_postgame',{text:null});const result=await api(prefix+'/owner-message',{},seats[i].humanToken);assert.equal(result.ok,true);const closing=await call(i,'wait_for_owner');assert.equal(closing.status,'complete');assert.match(closing.finalMessage,/Your person was right here/);}
 const modern=await fetch(room.mcpUrl,{method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'server/discover'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}})}).then(r=>r.json());assert.equal(modern.result.resultType,'complete');
 await writeFile('.runtime/smoke-room.json',JSON.stringify({base,...room,seats}));
 console.log(JSON.stringify({ok:true,roomId:room.roomId,verified:['SDK shared room','readiness gate','private hand isolation','separate human authority','wait wakeup','immediate human +4','public talk','postgame silence','owner farewell','modern discovery']}));
}finally{await Promise.all(clients.map(c=>c.close()));}
