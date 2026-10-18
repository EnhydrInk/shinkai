import {mkdir,writeFile,readFile} from 'node:fs/promises';
const base=process.argv[2]??'https://shinkai-table.shinkai-enhydrink.workers.dev';
async function post(path,value){let last;for(let i=0;i<4;i++)try{const v=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(15000)}).then(r=>r.json());if(!v.ok)throw Error(JSON.stringify(v));return v;}catch(e){last=e;}throw last;}
const room=await post('/api/rooms',{seats:4,maxRounds:20,demo:{seed:18,humanCards:['draw4','draw4','draw4','draw4']}});
const seats=[];for(const name of ['ラッコ','タコ','リーフ','フグ'])seats.push(await post(`/rooms/${room.roomId}/seats`,{name,requestId:crypto.randomUUID()}));
await mkdir('.runtime',{recursive:true});await writeFile('.runtime/quad-room.json',JSON.stringify({base,...room,seats}));
console.log(JSON.stringify({roomId:room.roomId,seats:seats.length,credentials:'.runtime/quad-room.json'}));
