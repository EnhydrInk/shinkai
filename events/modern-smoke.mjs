// Public smoke on an isolated room. No credentials are written or printed.
// Dependency: npm install --prefix /private/tmp/shinkai-modern-client @modelcontextprotocol/client@2.1.0
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require=createRequire('/private/tmp/shinkai-modern-client/package.json');
const {Client,StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {z}=require('zod');
const eventsSchema=z.object({events:z.array(z.object({name:z.string(),delivery:z.array(z.literal('webhook')),inputSchema:z.object({}).passthrough(),payloadSchema:z.object({}).passthrough()}).passthrough())});
const origin='https://shinkai-table.shinkai-enhydrink.workers.dev';
const clients=[];let stage='create-room';
async function retryFetch(input,init){
 let name;try{name=JSON.parse(init?.body??'{}').params?.name;}catch{}
 for(let attempt=0;;attempt++){
  try{return await fetch(input,init);}catch(error){if(error.cause?.code!=='ETIMEDOUT'||attempt>=2||name==='act')throw error;}
 }
}
async function post(path,value,token){
 const response=await retryFetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(value)});
 const result=await response.json();if(!response.ok||result.ok===false)throw new Error(`HTTP ${response.status}: ${result.message??'request failed'}`);return result;
}
async function call(client,seat,name,args={}){
 stage=name;const result=await client.callTool({name,arguments:{token:seat.aiToken,...args}});
 const value=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
 if(result.isError||value.ok===false)throw new Error(`${value.code??'tool_error'}: ${value.message}`);
 return value;
}
try {
 const room=await post('/api/rooms',{seats:2,maxRounds:1});
 const base=`/rooms/${room.roomId}`;
 const seats=await Promise.all([0,1].map(i=>post(`${base}/seats`,{name:`SDK smoke ${i+1}`,requestId:crypto.randomUUID()})));
 for(let i=0;i<2;i++){
  const client=new Client({name:'shinkai-modern-smoke',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});clients.push(client);
  stage='server/discover';await client.connect(new StreamableHTTPClientTransport(new URL(origin+base+'/mcp'),{fetch:retryFetch}));
  assert.equal(client.getProtocolEra(),'modern');
  console.log(`client ${i+1}: pinned modern connect OK`);
 }
 stage='tools/list';const tools=await clients[0].listTools();assert.ok(['join_game','get_state','wait_for_my_turn','act','submit_postgame','wait_for_owner'].every(name=>tools.tools.some(tool=>tool.name===name)));console.log(`tools/list: ${tools.tools.length} tools decoded`);
 stage='events/list';const events=await clients[0].request({method:'events/list',params:{}},eventsSchema);assert.equal(events.events.length,3);console.log('events/list: 3 event definitions decoded');
 for(let i=0;i<2;i++){await call(clients[i],seats[i],'join_game');await call(clients[i],seats[i],'get_state');}
 console.log('join_game/get_state: both seats OK');
 await Promise.all(clients.map((client,i)=>call(client,seats[i],'wait_for_my_turn',{waitMs:250})));
 let moves=0,finished=false;
 for(let n=0;n<10;n++){
  const state=(await call(clients[0],seats[0],'get_state')).state;
  if(state.status==='finished'){finished=true;break;}
  const i=seats.findIndex(seat=>seat.seatId===state.currentSeatId);assert.ok(i>=0);
  await call(clients[i],seats[i],'act',{turnId:state.turnId,action:{type:'draw'}});moves++;
 }
 assert.equal(finished,true);console.log(`wait/act: completed maxRounds=1 game in ${moves} draw moves`);
 for(let i=0;i<2;i++){
  await call(clients[i],seats[i],'submit_postgame',{text:null});
  stage='human-owner-message';await post(`${base}/owner-message`,{},seats[i].humanToken);
  const close=await call(clients[i],seats[i],'wait_for_owner',{waitMs:0});
  assert.equal(close.status,'complete');assert.ok(close.finalMessage||close.farewell||close.message);
 }
 console.log('submit_postgame / owner-message / wait_for_owner: both closing flows OK');
 console.log('PASS: official MCP v2 modern SDK public-room smoke; no Dot webhook delivery tested');
}catch(error){console.error(JSON.stringify({stage,name:error.name,code:error.code??null,message:error.message,cause:error.cause?.code??null}));process.exitCode=1;}
finally{await Promise.allSettled(clients.map(client=>client.close()));}
