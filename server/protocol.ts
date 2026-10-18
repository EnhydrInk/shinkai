export function protocolRequest(req:Request,rpc:any) {
 const claim=rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
 const header=req.headers.get('MCP-Protocol-Version');
 const modern=claim!==undefined||header==='2026-07-28'||rpc.method==='server/discover';
 if(!modern)return {modern:false};
 if(claim!==undefined&&claim!=='2026-07-28')return {modern:true,error:{code:-32022,message:'Unsupported protocol version'},status:400};
 if(rpc.id!==undefined) {
  const mirror=['tools/call','prompts/get'].includes(rpc.method)?rpc.params?.name:rpc.method==='resources/read'?rpc.params?.uri:undefined;
  if(header!=='2026-07-28'||req.headers.get('Mcp-Method')!==rpc.method||(mirror!==undefined&&req.headers.get('Mcp-Name')!==mirror))return {modern:true,error:{code:-32020,message:'MCP header/body mismatch'},status:400};
 }
 if(rpc.method==='initialize')return {modern:true,error:{code:-32601,message:'Modern MCP uses server/discover instead of initialize'},status:200};
 return {modern:true};
}
