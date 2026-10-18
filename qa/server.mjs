import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve('web/dist');
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.ttf':'font/ttf'};
createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1:5174');let data,type;
if(url.pathname==='/'){data=await readFile('qa/quad.html');type='text/html';}
else if(url.pathname==='/fixture.json'){data=await readFile('.runtime/quad-room.json');type='application/json';}
else if(url.pathname.startsWith('/app/')){const path=resolve(root,'.'+url.pathname.slice(4));if(!path.startsWith(root+'/'))throw Error('Bad path');data=await readFile(path);type=types[extname(path)]??'application/octet-stream';}
else if(url.pathname==='/snapshot'&&req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);await writeFile(url.searchParams.get('name')==='layout-bubbles'?'qa/quad-layout-bubbles.png':'qa/quad-latest.png',Buffer.concat(chunks));data=JSON.stringify({ok:true});type='application/json';}
else if(url.pathname==='/recording'&&req.method==='POST'){if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:5174')throw Error('Invalid origin');let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>256*1024*1024)throw Error('Recording too large');chunks.push(chunk)}await mkdir('recordings',{recursive:true});const extension=(req.headers['content-type']??'').includes('mp4')?'mp4':'webm';await writeFile('recordings/shinkai-four-views.'+extension,Buffer.concat(chunks));data=JSON.stringify({ok:true,bytes:size});type='application/json';}
else{res.writeHead(404).end();return;}
res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'}).end(data);
}catch{res.writeHead(500).end('Preview data unavailable');}}).listen(5174,'127.0.0.1',()=>console.log('Four-seat preview: http://127.0.0.1:5174'));
