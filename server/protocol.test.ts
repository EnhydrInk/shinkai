import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolRequest} from './protocol.js';
const modern=(method='server/discover',name?:string)=>({jsonrpc:'2.0',id:1,method,params:{...(name?{name}:{}),_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}});
const req=(method='server/discover',name?:string)=>new Request('https://example.com/mcp',{method:'POST',headers:{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(name?{'Mcp-Name':name}:{})}});
test('legacy initialize stays legacy; modern discovery and named tool validate',()=>{
 assert.deepEqual(protocolRequest(new Request('https://example.com'),{id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}}),{modern:false});
 assert.deepEqual(protocolRequest(req(),modern()),{modern:true});
 assert.deepEqual(protocolRequest(req('tools/call','act'),modern('tools/call','act')),{modern:true});
});
test('modern era cannot bypass required headers, mismatches or unsupported body revision',()=>{
 assert.equal(protocolRequest(new Request('https://example.com'),modern()).error?.code,-32020);
 assert.equal(protocolRequest(req('tools/call','other'),modern('tools/call','act')).error?.code,-32020);
 const rpc=modern();rpc.params._meta['io.modelcontextprotocol/protocolVersion']='2027-01-01';assert.equal(protocolRequest(req(),rpc).error?.code,-32022);
 assert.equal(protocolRequest(req('initialize'),modern('initialize')).error?.code,-32601);
});

test('event name is not a standard Mcp-Name mirror',()=>{
 const rpc=modern('events/subscribe','turn.ready');
 assert.deepEqual(protocolRequest(req('events/subscribe'),rpc),{modern:true});
});
