// Isolated public negative tests; credentials and signing keys stay in memory.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require=createRequire('/private/tmp/shinkai-modern-client/package.json');
const {Client,StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {z}=require('zod');
const origin='https://shinkai-table.shinkai-enhydrink.workers.dev';
let stage='create-room',client;
async function retryFetch(input,init){for(let attempt=0;;attempt++){try{return await fetch(input,init);}catch(error){if(error.cause?.code!=='ETIMEDOUT'||attempt>=2)throw error;}}}
async function post(path,value){const response=await retryFetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});const result=await response.json();if(!response.ok||result.ok===false)throw new Error(`HTTP ${response.status}: ${result.message??'request failed'}`);return result;}
try{
 const room=await post('/api/rooms',{seats:2,maxRounds:1});const base=`/rooms/${room.roomId}`;
 const seat=await post(`${base}/seats`,{name:'SDK negative smoke',requestId:crypto.randomUUID()});
 client=new Client({name:'shinkai-modern-negative-smoke',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
 stage='server/discover';await client.connect(new StreamableHTTPClientTransport(new URL(origin+base+'/mcp'),{fetch:retryFetch}));assert.equal(client.getProtocolEra(),'modern');
 stage='join_game';const joined=await client.callTool({name:'join_game',arguments:{token:seat.aiToken}});assert.notEqual(joined.isError,true);
 const params=token=>({name:'turn.ready',arguments:{roomId:room.roomId,seatId:seat.seatId,aiToken:token},delivery:{mode:'webhook',url:origin+'/health',secret:`whsec_${randomBytes(32).toString('base64')}`},cursor:null});
 async function expectFailure(label,token,code,reason){
  stage=label;let rejected=false;
  try{await client.request({method:'events/subscribe',params:params(token)},z.object({}).passthrough());}
  catch(error){rejected=true;assert.equal(error.code,code);if(reason)assert.equal(error.data?.reason,reason);console.log(`${label}: code=${error.code}${error.data?.reason?` reason=${error.data.reason}`:''} OK`);}
  assert.equal(rejected,true,'Subscription unexpectedly accepted');
 }
 await expectFailure('wrong-token',crypto.randomUUID(),-32001);
 await expectFailure('correct-token-non-echo-callback',seat.aiToken,-32015,'challenge_failed');
 console.log('PASS: official modern SDK subscription negative paths; no active subscription or Dot delivery');
}catch(error){console.error(JSON.stringify({stage,name:error.name,code:error.code??null,message:error.message,cause:error.cause?.code??null}));process.exitCode=1;}
finally{await client?.close();}
