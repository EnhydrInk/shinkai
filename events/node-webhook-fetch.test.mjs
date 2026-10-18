import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, publicDestination, nodeWebhookFetch } from './node-webhook-fetch.mjs';

test('blocks local, reserved, documentation, mapped and transition addresses',()=>{
 for(const ip of ['127.0.0.1','10.1.1.1','100.100.100.200','169.254.169.254','172.31.0.1','192.168.0.1','192.0.0.8','198.18.0.1','192.0.2.1','198.51.100.2','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','fc00::1','fe80::1','ff02::1','2001:db8::1','2001::1','2002:0808:0808::1','3fff::1','invalid']) assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isPublicAddress(ip),true,ip);
});
test('rejects a mixed public/private DNS answer; pins exact validated object',async()=>{
 await assert.rejects(publicDestination('callback.example',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),/not public/);
 const answer={address:'8.8.8.8',family:4};
 assert.equal(await publicDestination('callback.example',async()=>[answer]),answer);
 await assert.rejects(publicDestination('callback.example',async()=>[]),/not public/);
});
test('rejects non-HTTPS, credentials, fragments, IPs, ports and redirect opt-out before network',async()=>{
 for(const url of ['http://example.com','https://u:p@example.com','https://example.com/#a','https://127.0.0.1','https://[::1]','https://example.com:444']) await assert.rejects(nodeWebhookFetch(url,{method:'POST',redirect:'error',body:'{}'}),/HTTPS DNS hostname/);
 await assert.rejects(nodeWebhookFetch('https://example.com',{method:'POST',redirect:'follow',body:'{}'}),/Unsupported/);
});
