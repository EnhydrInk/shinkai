import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const base=process.argv[2];const count=Number(process.argv[3]??2);const agentCount=Math.min(count,Number(process.argv[4]??2));
if(!base||![2,3,4].includes(count))throw Error('Usage: node scripts/model-game.mjs ORIGIN [2|3|4]');
await mkdir('.runtime',{recursive:true});await mkdir('/private/tmp/shinkai-players',{recursive:true});
async function api(path,data,token){let last;for(let attempt=0;attempt<4;attempt++){try{return await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(15000)}).then(r=>r.json());}catch(e){last=e;await new Promise(r=>setTimeout(r,1000));}}throw last;}
let room,seats=[];
if(process.env.SHINKAI_ROOM_FILE){const saved=JSON.parse(await readFile(process.env.SHINKAI_ROOM_FILE,'utf8'));room=saved;seats=saved.seats;}
else{room=await api('/api/rooms',{seats:count,maxRounds:10,demo:true});if(!room.ok)throw Error(JSON.stringify(room));
for(let i=0;i<agentCount;i++){const s=await api(`/rooms/${room.roomId}/seats`,{name:['Ritsu Otter','Ritsu Octopus','Ritsu Leaf','Ritsu Puffer'][i],requestId:crypto.randomUUID()});if(!s.ok)throw Error(JSON.stringify(s));seats.push(s);}}
await writeFile('.runtime/model-room.json',JSON.stringify({base,...room,seats}));
const prompt=await readFile('docs/PLAYER_PROMPT.md','utf8');
const runs=seats.map(async(s,i)=>{
 const output=[];
 const child=spawn('/opt/homebrew/bin/codex',['exec','--skip-git-repo-check','--ephemeral','-C','/private/tmp/shinkai-players','-c',`mcp_servers.tabletop.url=${JSON.stringify(room.mcpUrl)}`,'-c','mcp_servers.tabletop.tool_timeout_sec=40','-c','mcp_servers.tabletop.startup_timeout_sec=30','-c','model_reasoning_effort="low"','-'],{stdio:['pipe','pipe','pipe']});
 child.stdout.on('data',b=>output.push(b));child.stderr.on('data',b=>output.push(b));
 child.stdin.end(prompt+`\n\nYour private AI token: ${s.aiToken}\nYour player name is ${s.name}. The seat is already reserved; do not create a new seat.\n`);
 const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
 await writeFile(`.runtime/model-player-${i}.log`,Buffer.concat(output));return {seatId:s.seatId,exitCode:code};
});
console.log(JSON.stringify({type:'started',roomId:room.roomId,players:agentCount,totalSeats:count,mcpUrl:room.mcpUrl,...(count>2?{dotSeatStored:'.runtime/model-room.json'}:{})}));
let humanUsed=false,lastTurn=0,checking=false;
const monitor=setInterval(async()=>{if(checking)return;checking=true;try{
 const states=await Promise.all(seats.map(s=>api(`/rooms/${room.roomId}/state`,undefined,s.humanToken)));
 const state=states[0]?.state;
 if(!state)return;
 if(process.env.SHINKAI_MANUAL_HUMAN!=='1'&&!humanUsed&&state.status==='playing') {const index=states.findIndex(x=>x.state?.currentSeatId!==x.state?.you.seatId&&x.state?.humanCard&&!x.state?.humanCard.used&&!x.state?.humanCard.pending);if(index>=0){const result=await api(`/rooms/${room.roomId}/human`,{action:{type:'draw4',targetSeatId:seats[(index+1)%seats.length].seatId}},seats[index].humanToken);humanUsed=!!result.ok;}}
 if(state.turnId!==lastTurn){lastTurn=state.turnId;console.log(JSON.stringify({type:'progress',status:state.status,turnId:state.turnId,counts:state.players.map(p=>p.handCount),firstTurnDelivered:state.firstTurnDelivered,humanUsed}));}
 if(process.env.SHINKAI_MANUAL_HUMAN!=='1'&&state.status==='finished') {for(let i=0;i<seats.length;i++)if(states[i].state.ending?.speechStatus!=='pending')await api(`/rooms/${room.roomId}/owner-message`,{},seats[i].humanToken);}
}catch(error){console.log(JSON.stringify({type:'monitor_error',message:error.message}));}finally{checking=false;}},1000);
try {const result=await Promise.all(runs);console.log(JSON.stringify({type:'players_exited',result}));const final=await api(`/rooms/${room.roomId}/state`,undefined,seats[0].humanToken);await writeFile('.runtime/model-result.json',JSON.stringify({roomId:room.roomId,result,state:final.state}));console.log(JSON.stringify({type:'result',status:final.state?.status,winners:final.state?.result?.winners,steps:final.state?.completedSteps,firstTurnDelivered:final.state?.firstTurnDelivered,humanUsed}));}finally{clearInterval(monitor);}
