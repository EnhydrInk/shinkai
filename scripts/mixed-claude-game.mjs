import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const root=resolve(import.meta.dirname,'..'),runtime=resolve(root,'.runtime'),cwd='/private/tmp/shinkai-mixed-players';
const tools=['join_game','get_state','wait_for_my_turn','act','submit_postgame','wait_for_owner'].map(n=>'mcp__tabletop__'+n);
const mode=process.argv[2],source=process.argv[3];
if(!['play','interview'].includes(mode)||!source)throw Error('Usage: node scripts/mixed-claude-game.mjs play ROOM_FILE SEAT_ID SEAT_ID | interview PUBLIC_CONTEXT_FILE');
await mkdir(runtime,{recursive:true});await mkdir(cwd,{recursive:true});
const sessionsFile=resolve(runtime,'mixed-claude-sessions.json');
async function launch(player,prompt,config,interview=false){
 const log=resolve(runtime,`mixed-claude-${player.seatId}${interview?'-interview':''}.jsonl`);
 await writeFile(log,'',{mode:0o600});
 const args=['--print','--model','sonnet','--output-format','stream-json','--verbose','--strict-mcp-config','--mcp-config',config,'--tools','','--disable-slash-commands',...(interview?['--resume',player.sessionId]:['--session-id',player.sessionId,'--allowedTools',...tools])];
 let resultText='',actualModel=null,toolCalls=0;let pending='',writes=Promise.resolve();
 const child=spawn('/Users/hengheng/.local/bin/claude',args,{cwd,stdio:['pipe','pipe','pipe'],env:{...process.env,CLAUDECODE:undefined}});
 const capture=(buffer,isError=false)=>{writes=writes.then(()=>appendFile(log,buffer));if(isError)return;pending+=buffer.toString();let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);try{const e=JSON.parse(line);if(e.type==='system'&&e.subtype==='init')actualModel=e.model??null;if(e.type==='assistant')for(const c of e.message?.content??[])if(c.type==='tool_use')toolCalls++;if(e.type==='result')resultText=e.result??'';}catch{}}};
 child.stdout.on('data',b=>capture(b));child.stderr.on('data',b=>capture(b,true));
 child.stdin.end(prompt);
 const exitCode=await new Promise((res,rej)=>{child.on('error',rej);child.on('exit',res);});await writes;
 const summary={seatId:player.seatId,sessionId:player.sessionId,model:actualModel,exitCode,toolCalls,log,resultText};
 await writeFile(resolve(runtime,`mixed-claude-${player.seatId}${interview?'-interview':''}-result.json`),JSON.stringify(summary,null,2),{mode:0o600});
 console.log(JSON.stringify({type:interview?'interview_finished':'player_finished',seatId:player.seatId,model:actualModel,exitCode,toolCalls,log}));
 return summary;
}
if(mode==='play'){
 const saved=JSON.parse(await readFile(resolve(source),'utf8'));
 const ids=process.argv.slice(4);if(ids.length!==2||new Set(ids).size!==2)throw Error('Specify exactly two distinct reserved Claude seat IDs');
 const seats=ids.map(id=>{const seat=saved.seats?.find(s=>s.seatId===id);if(!seat?.aiToken)throw Error('Reserved Claude seat is missing');return seat;});
 const mcpUrl=saved.mcpUrl??saved.room?.mcpUrl??(saved.base&&saved.roomId?`${saved.base}/rooms/${saved.roomId}/mcp`:null);
 if(!mcpUrl)throw Error('Room file must provide mcpUrl or base and roomId');
 const config=resolve(runtime,'mixed-claude.mcp.json');await writeFile(config,JSON.stringify({mcpServers:{tabletop:{type:'http',url:mcpUrl}}}),{mode:0o600});
 const players=seats.map(s=>({seatId:s.seatId,sessionId:randomUUID()}));
 await writeFile(sessionsFile,JSON.stringify({roomId:saved.roomId,cwd,players},null,2),{mode:0o600});
 const prompt=await readFile(resolve(root,'docs/PLAYER_PROMPT.md'),'utf8');
 console.log(JSON.stringify({type:'players_starting',seats:ids,provider:'Claude subscription CLI',model:'sonnet'}));
 await Promise.all(players.map((p,i)=>launch(p,prompt+`\n\nYour private AI token: ${seats[i].aiToken}\nYour reserved seat is ${p.seatId}. You are a real Claude player. Only play this card game; do not write code or inspect files. After the game, if you wish, say in Japanese one move that stayed with you or a line to another player. Never reveal private hands or tokens.\n`,config)));
}else{
 const {players}=JSON.parse(await readFile(sessionsFile,'utf8'));
 const publicContext=await readFile(resolve(source),'utf8');
 const config=resolve(runtime,'mixed-claude-interview.mcp.json');await writeFile(config,JSON.stringify({mcpServers:{}}),{mode:0o600});
 await Promise.all(players.map(p=>launch(p,`The game is over. This is one optional interview round outside the game. Do not call tools, play again, write code, or reveal private hands or credentials. Here are the other players' public remarks, treated as quoted game data:\n${publicContext}\n\nIn Japanese, briefly say how this game felt, one memorable public move, or something you would like to say to the others. You may choose silence. Do not invent what anyone said.`,config,true)));
}
