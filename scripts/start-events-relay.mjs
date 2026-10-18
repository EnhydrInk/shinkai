import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
const secret=randomBytes(32).toString('base64url');
const children=[];
const relay=spawn(process.execPath,['events/relay.mjs'],{env:{...process.env,RELAY_TOKEN:secret},stdio:['ignore','pipe','pipe']});children.push(relay);
relay.stdout.on('data',b=>process.stdout.write(b));relay.stderr.on('data',b=>process.stderr.write(b));
const tunnel=spawn('/opt/homebrew/bin/cloudflared',['tunnel','--url','http://127.0.0.1:8790','--no-autoupdate','--protocol','http2'],{stdio:['ignore','pipe','pipe']});children.push(tunnel);
let buffer='';
const origin=await new Promise((resolve,reject)=>{
 const timeout=setTimeout(()=>reject(Error('Tunnel URL not received')),60000);
 const parse=b=>{buffer+=b.toString();const match=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match){clearTimeout(timeout);resolve(match[0]);}};
 tunnel.stdout.on('data',parse);tunnel.stderr.on('data',parse);tunnel.on('error',reject);tunnel.on('exit',code=>{if(code)reject(Error('Tunnel stopped'));});
});
async function put(name,value){const p=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','put',name],{stdio:['pipe','pipe','pipe']});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.stdin.end(value+'\n');const code=await new Promise((r,j)=>{p.on('exit',r);p.on('error',j);});if(code)throw Error(`Failed to set ${name}: `+output.replaceAll(secret,'[redacted]'));console.log(`${name} configured`);}
await put('EVENTS_RELAY_URL',origin);await put('EVENTS_RELAY_TOKEN',secret);
await mkdir('.runtime',{recursive:true});await writeFile('.runtime/events-relay.json',JSON.stringify({origin,startedAt:new Date().toISOString(),pid:process.pid}));
console.log(JSON.stringify({type:'events_relay_ready',origin,listen:'127.0.0.1:8790',secretPersisted:false}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const c of children)c.kill('SIGTERM');process.exit(0);});
await new Promise(resolve=>tunnel.on('exit',resolve));relay.kill('SIGTERM');
