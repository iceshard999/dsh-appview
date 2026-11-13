import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRuntime, packages } from './runtime.mjs';
import { createLayoutHandler } from '../lib/index.js';
import { createOrderStore } from '../src/order-store.js';
import { entryKey, reconcileOrder, moveTo, gridMetrics, pageCount, validSnapshot } from '../src/layout.js';
const scratch = new URL('../.verify-layout/', import.meta.url);
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(new URL('case-', scratch).pathname);
let count = 0;
const ok = label => { count++; console.log(`✔ ${label}`); };
const owner = { principal: { kind: 'owner' } };
let value = { revision: 0, keys: [] }, fail = false;
const service = createLayoutHandler({ global: { get: () => value, set: async next => {
  if (fail) throw new Error('disk failure'); value = structuredClone(next);
} }, close: async () => {} });
const call = (endpoint, payload, peer = owner) => service.handle(endpoint, payload, undefined, peer);
assert.notEqual(entryKey({ providerId:'a:b',id:'c' }),entryKey({providerId:'a',id:'b:c'}));
assert.deepEqual(reconcileOrder(['c','a','removed'],['a','b','c','new']),['c','a','b','new']);
assert.deepEqual(reconcileOrder(['c','a','removed'],['a','b'],false),['c','a','removed','b']);
ok('stable identities; additions append; removals preserve surviving relative order');
for (let n=1;n<80;n++) {
  const keys=Array.from({length:n},(_,i)=>String(i));
  for (let from=0;from<n;from+=7) for (let to=0;to<n;to+=5) {
    const moved=moveTo(keys,keys[from],to);
    assert.equal(moved[to],keys[from]); assert.equal(new Set(moved).size,n);
    assert.deepEqual(moved.filter(k=>k!==keys[from]),keys.filter(k=>k!==keys[from]));
  }
}
ok('reordering within and across pages preserves every entry and the order of other entries');
for (const [width,height] of [[176,96],[276,208],[600,500],[1100,820]]) {
  const m=gridMetrics(width,height);
  assert.ok(m.columns*84+(m.columns-1)*10<=width);
  assert.ok(m.rows*96+(m.rows-1)*16<=height);
  const keys=Array.from({length:73},(_,i)=>i), collected=[];
  for(let page=0;page<pageCount(keys.length,m.capacity);page++) collected.push(...keys.slice(page*m.capacity,(page+1)*m.capacity));
  assert.deepEqual(collected,keys);
}
ok('panel width and height determine capacity; pages contain no duplicate or missing entries');
assert.equal((await call('sync',{revision:0,keys:['a','b','c'],prune:true})).ok,true);
assert.equal(value.revision,1);
assert.equal((await call('sync',{revision:1,keys:['a','b','c'],prune:true})).value.revision,1);
const moved=await call('move',{revision:1,key:'a',before:null}); assert.deepEqual(moved.value.keys,['b','c','a']);
ok('host sync and move persist complete order; no-op requests do not write a new revision');
const concurrent=await Promise.all([call('move',{revision:2,key:'a',before:'b'}),call('move',{revision:2,key:'c',before:'b'})]);
assert.equal(concurrent.filter(result=>result.ok).length,1);
assert.equal(concurrent.find(result=>!result.ok).error.code,'conflict');
ok('simultaneous saves accept one revision and report the current layout to the stale writer');
const revision=value.revision;
for(const payload of [{revision,keys:['a','a'],prune:true},{revision,keys:[{}],prune:true},{revision,keys:['a']},{revision:-1,keys:[],prune:true}]) assert.equal((await call('sync',payload)).ok,false);
assert.equal((await call('move',{revision,key:'missing',before:null})).ok,false);
assert.equal((await call('read',{}, {principal:{kind:'guest'}})).error.code,'forbidden');
assert.equal((await call('unknown',{})).error.code,'not-found');
ok('malformed writes, duplicate keys, unknown targets and non-owner callers are rejected');
const beforeFailure=structuredClone(value); fail=true;
assert.equal((await call('move',{revision,key:value.keys[0],before:null})).error.code,'storage');
assert.deepEqual(value,beforeFailure); fail=false;
(await call('read',{})).value.keys.push('not-persisted'); assert.deepEqual(value,beforeFailure);
ok('failed durable writes preserve the prior revision; responses cannot mutate host state');
let runtime=await createRuntime(directory);
// Exercise the actual authenticated Connection HTTP bridge over the actual JSON domain.
const server=createServer(async(req,res)=>{try{if(!await runtime.route(req,res)){res.writeHead(404);res.end();}}catch(error){res.writeHead(500);res.end(String(error));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const { Context }=await import(pathToFileURL(join(packages,'cordis/lib/index.js')).href);
const { installConnection }=await import(pathToFileURL(join(packages,'dsh-client-connection/lib/client.node.js')).href);
const clientCtx=new Context();
installConnection(clientCtx,{transport:{fetch:(input,init)=>fetch(new URL(input,base),{...init,headers:{...init.headers,cookie:'appview-test=1'}})},location:{hostname:'127.0.0.1'}});
const rpc=(method,payload)=>clientCtx.connection.rpc.call('/api','dsh-appview/'+method,payload);
try {
  assert.equal((await fetch(base+'/api/dsh-appview/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'test-unauth',method:'dsh-appview/read',payload:{}})})).status,401);
  assert.equal((await rpc('sync',{revision:0,keys:['a','b','c'],prune:true})).ok,true);
  assert.equal((await rpc('move',{revision:1,key:'a',before:null})).ok,true);
  const disk=JSON.parse(await readFile(join(directory,'dsh_appview_layout.json'),'utf8'));
  assert.deepEqual(disk.global.keys,['b','c','a']);
  ok('real DSH Connection HTTP and client RPC save through the real JSON backend; unauthenticated requests get 401');
  await runtime.close(); runtime=await createRuntime(directory);
  assert.deepEqual((await rpc('read',{})).value,{revision:2,keys:['b','c','a']});
  ok('closing and reopening the host restores the durable order with no browser local storage');
} finally { await new Promise(resolve=>server.close(resolve));await clientCtx.fiber.dispose();await runtime.close(); }
function observable(initial) {
 let state=initial;const listeners=new Set();return {getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},set(next){state=next;for(const fn of listeners)fn();},get size(){return listeners.size;}};
}
const entries=['a','b','c'].map(id=>({providerId:'fixture',id}));
const registry=observable(entries);
const modules=observable({syncing:true,failures:[]});
const generation=observable({id:1});
let storeValue={revision:7,keys:[entryKey(entries[2]),entryKey(entries[0]),entryKey(entries[1])]};
let writes=0;
const fakeHost=createLayoutHandler({global:{get:()=>storeValue,set:async next=>{writes++;storeValue=structuredClone(next);}},close:async()=>{}});
const connection={generation,rpc:{call:async(channel,method,payload,signal)=>fakeHost.handle(method.replace('dsh-appview/',''),payload,signal,owner)}};
const store=createOrderStore({guide:registry.getSnapshot,subscribe:registry.subscribe},connection,{entries:{state:modules}});
await store.refresh();
assert.deepEqual(store.getSnapshot().keys,storeValue.keys);assert.equal(writes,0);
registry.set(entries.slice(0,1));await store.refresh();assert.equal(writes,0);
modules.set({syncing:false,failures:[{id:'loading',message:'fixture'}]});await store.refresh();assert.equal(writes,0);
registry.set(entries);modules.set({syncing:false,failures:[]});await store.refresh();
ok('boot and failed plugin loads preserve saved identities and order until the registry settles');
const next=moveTo(storeValue.keys,entryKey(entries[0]),0);await store.reorder(next,entryKey(entries[0]));assert.deepEqual(storeValue.keys,next);
registry.set([...entries,{providerId:'fixture',id:'new'}]);await store.refresh();assert.equal(storeValue.keys.at(-1),entryKey({providerId:'fixture',id:'new'}));
registry.set(entries.slice(1));await store.refresh();assert.deepEqual(storeValue.keys,next.filter(key=>key!==entryKey(entries[0])));
ok('client store saves drag order and persists registry additions/removals in the full list');
const store2=createOrderStore({guide:registry.getSnapshot,subscribe:registry.subscribe},connection,{entries:{state:modules}});await store2.refresh();
const secondBefore=store2.getSnapshot();
await store.reorder([...storeValue.keys].reverse(),storeValue.keys[0]);
await store2.reorder([...secondBefore.keys].reverse(),secondBefore.keys[0]);
assert.match(store2.getSnapshot().error,/其他客户端/);assert.deepEqual(store2.getSnapshot().keys,storeValue.keys);
ok('separate clients read one host order; a stale drag rolls back to the committed layout');
generation.set({id:2});await store.refresh();assert.deepEqual(store.getSnapshot().keys,storeValue.keys);
store.dispose();store2.dispose();assert.equal(registry.size,0);assert.equal(generation.size,0);assert.equal(modules.size,0);
ok('connection generations reload from the host; disposing releases shared subscriptions');
await service.close();await fakeHost.close();await rm(directory,{recursive:true,force:true});
console.log(`Phase-one check passed: ${count} checks verified.`);
