// Node-only transport. Do not import into a Cloudflare Worker bundle.
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [network, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(network,bits,'ipv4');
// Conservatively support only global unicast; reject transition/special-use ranges.
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
for (const [network,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(network,bits,'ipv6');
export function isPublicAddress(address) {
 const family=isIP(address);
 return family===4 ? !blocked.check(address,'ipv4') : family===6 && global6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
// Resolve once per request, validate every result, then return the pinned address
// directly from the TLS connection's lookup callback. No second DNS resolution.
export async function publicDestination(hostname, resolve=lookup) {
 const addresses=await resolve(hostname,{all:true,verbatim:true});
 if(!addresses.length || addresses.some(({address})=>!isPublicAddress(address))) throw new Error('Callback destination is not public');
 return addresses[0];
}
export async function nodeWebhookFetch(input, init={}) {
 const url=new URL(input);
 if(url.protocol!=='https:' || url.username || url.password || url.hash || (url.port && url.port!=='443') || isIP(url.hostname) || url.hostname.startsWith('[')) throw new Error('Callback requires an HTTPS DNS hostname on port 443');
 if(init.method!=='POST' || init.redirect!=='error' || typeof init.body!=='string') throw new Error('Unsupported callback request');
 const signal=init.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
 signal.throwIfAborted();
 let abort;
 let destination;
 try {
  destination=await Promise.race([publicDestination(url.hostname),new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);
 } finally { if(abort) signal.removeEventListener('abort',abort); }
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{
   method:'POST',headers:init.headers,signal,agent:false,
   // Preserve original URL hostname for Host, SNI, and certificate verification.
   servername:url.hostname,rejectUnauthorized:true,
   lookup:(_hostname,options,callback)=>options?.all ? callback(null,[destination]) : callback(null,destination.address,destination.family),
  },res=>{
   const chunks=[]; let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>65536) res.destroy(new Error('Callback response exceeds 64 KiB'));else chunks.push(chunk);});
   res.on('error',reject);
   res.on('end',()=>{
    if(res.statusCode>=300 && res.statusCode<400) return reject(new Error('Callback redirects are forbidden'));
    const status=res.statusCode??502;
    resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:res.headers['content-type']?{'content-type':res.headers['content-type']}:{}}));
   });
  });
  req.on('error',reject);req.end(init.body);
 });
}
