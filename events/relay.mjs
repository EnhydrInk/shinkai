import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { nodeWebhookFetch } from './node-webhook-fetch.mjs';

const MAX_REQUEST=300*1024;
const allowedHeaders=new Set(['content-type','webhook-id','webhook-timestamp','webhook-signature','x-mcp-subscription-id']);
const digest=value=>createHash('sha256').update(value).digest();
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const exactKeys=(value,keys)=>object(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
function invalid(message='Invalid relay request') { const error=new Error(message); error.status=400; return error; }
function parseEnvelope(value) {
 if(!exactKeys(value,['url','init']) || typeof value.url!=='string' || !exactKeys(value.init,['headers','body']) || !object(value.init.headers) || typeof value.init.body!=='string') throw invalid();
 if(Buffer.byteLength(value.init.body)>262144) throw invalid('Callback payload exceeds 256 KiB');
 const headers={};
 for(const [key,text] of Object.entries(value.init.headers)) {
  const lower=key.toLowerCase();
  if(!allowedHeaders.has(lower) || Object.hasOwn(headers,lower) || typeof text!=='string' || /[\r\n]/.test(text)) throw invalid();
  headers[lower]=text;
 }
 if([...allowedHeaders].some(key=>!headers[key]) || headers['content-type'].toLowerCase()!=='application/json') throw invalid();
 return {url:value.url,init:{method:'POST',redirect:'error',headers,body:value.init.body}};
}
function readBody(req) {
 return new Promise((resolve,reject)=>{
  let size=0,exceeded=false;const chunks=[];
  req.on('data',chunk=>{size+=chunk.length;if(size>MAX_REQUEST){if(!exceeded){exceeded=true;const error=new Error('Request too large');error.status=413;reject(error);}return;}chunks.push(chunk);});
  req.on('end',()=>{if(!exceeded)resolve(Buffer.concat(chunks).toString('utf8'));});
  req.on('error',reject);
 });
}
/** Injection exists for local tests; production always uses the pinned Node transport. */
export function createRelay({token,webhookFetch=nodeWebhookFetch,onDelivery=()=>{}}={}) {
 if(typeof token!=='string' || token.length<32 || /\s/.test(token)) throw new Error('RELAY_TOKEN must contain at least 32 non-whitespace characters');
 const expected=digest(`Bearer ${token}`);
 const server=createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
  if(req.url==='/health' && req.method==='GET')return send(200,{ok:true});
  if(req.url!=='/deliver' || req.method!=='POST')return send(404,{error:'Not found'});
  if(!timingSafeEqual(expected,digest(req.headers.authorization??'')))return send(401,{error:'Unauthorized'});
  if((req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')return send(400,{error:'JSON required'});
  try {
   if(Number(req.headers['content-length'])>MAX_REQUEST){req.resume();return send(413,{error:'Request too large'});}
   let value;try{value=JSON.parse(await readBody(req));}catch(error){if(error.status)throw error;throw invalid();}
   const envelope=parseEnvelope(value);
   const callback=await webhookFetch(envelope.url,envelope.init);
   const body=await callback.text();
   if(Buffer.byteLength(body)>65536)throw new Error('Callback response too large');
   const contentType=callback.headers.get('content-type');
   try{onDelivery({status:callback.status,ok:callback.ok});}catch{}
   return send(200,{status:callback.status,body,responseHeaders:contentType?{'content-type':contentType}:{}});
  }catch(error){try{onDelivery({status:0,ok:false});}catch{}return send(error.status??502,{error:error.status===413?'Request too large':error.status===400?'Invalid relay request':'Callback delivery failed'});}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=createRelay({token:process.env.RELAY_TOKEN,onDelivery:result=>process.stdout.write(JSON.stringify({type:'callback_result',...result})+'\n')});
 server.listen(8790,'127.0.0.1',()=>process.stdout.write('Events relay listening on 127.0.0.1:8790\n'));
}
