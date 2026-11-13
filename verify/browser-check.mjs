import assert from 'node:assert/strict';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { devResolve } from '../scripts/dev-deps.mjs';
import { createRuntime } from './runtime.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=join(root,'.verify-browser');
process.env.PLAYWRIGHT_BROWSERS_PATH??=join(directory,'browsers');
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PATH??'playwright');
await mkdir(join(directory,'artifacts'),{recursive:true});
await rm(join(directory,'storage'),{recursive:true,force:true});
const runtime=await createRuntime(join(directory,'storage'));
let registryIds=Array.from({length:36},(_,i)=>`app-${String(i+1).padStart(2,'0')}`);
const server=createServer(async(req,res)=>{
 try {
  if(await runtime.route(req,res))return;
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  const files={'/':join(root,'verify/browser.html'),'/client.js':join(root,'lib/client.js'),
   '/react.js':join(dirname(devResolve('react/package.json')),'umd/react.development.js'),'/react-dom.js':join(dirname(devResolve('react-dom/package.json')),'umd/react-dom.development.js')};
  if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
  if(!files[pathname]){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':'text/html;charset=utf-8');
  let content=await readFile(files[pathname],'utf8');
  if(pathname==='/'){res.setHeader('Set-Cookie','appview-test=1; SameSite=Strict; Path=/');content=content.replace('window.rows=[];',`window.initialIds=${JSON.stringify(registryIds)};window.rows=[];`);}
  res.end(content);
 }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.DSH_APPVIEW_CHROMIUM});
const context=await browser.newContext({viewport:{width:1000,height:800},hasTouch:true});
const page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
let count=0;const ok=name=>{count++;console.log(`✔ ${name}`);};
const tiles=()=>page.locator('.dsl-tile');
const ids=()=>tiles().evaluateAll(nodes=>nodes.map(n=>n.dataset.dslId));
const hostIds=()=>runtime.snapshot.keys.map(key=>JSON.parse(key)[1]);
const revision=()=>runtime.snapshot.revision;
async function ready(p=page){await p.waitForFunction(()=>window.fixtureReady&&document.querySelector('.dsl-notice')?.textContent === '');}
async function waitFor(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}assert.ok(predicate(),'host state did not converge');}
async function settle(){await page.waitForFunction(()=>!document.querySelector('.dsl-notice')?.textContent.includes('正在保存'));}
async function center(locator){const b=await locator.boundingBox();assert.ok(b);return {x:b.x+b.width/2,y:b.y+b.height/2};}
async function mouseDrag(from,to){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();await settle();}
async function toPage(index){let current=Number(await page.locator('.dsl-root').getAttribute('data-dsl-page'));while(current!==index){await page.getByRole('button',{name:current>index?'上一页':'下一页',exact:true}).click();current=Number(await page.locator('.dsl-root').getAttribute('data-dsl-page'));}}
async function collect(){const list=[];await toPage(0);let pages=Number((await page.locator('[data-dsl-pages]').textContent()).match(/\/ (\d+)/)[1]);for(let i=0;i<pages;i++){list.push(...await ids());if(i+1<pages)await page.getByRole('button',{name:'下一页',exact:true}).click();}return list;}
const cdp=await context.newCDPSession(page);
async function touch(type,x,y){await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y,radiusX:2,radiusY:2,force:1,id:1}]});}
try{
 await page.goto(url);await ready();
 assert.equal(await tiles().count(),12);assert.equal(await page.locator('[data-dsl-pages]').textContent(),'第 1 / 3 页');
 await tiles().first().click();await tiles().nth(1).press('Enter');await tiles().nth(1).press('Space');
 assert.equal(await page.evaluate(()=>openCalls.length),3);ok('initial pages and native mouse/keyboard opening');
 let old=hostIds(),before=revision();
 await mouseDrag(await center(tiles().first()),await center(tiles().nth(5)));
 await waitFor(()=>revision()>before);assert.equal(hostIds()[5],old[0]);assert.deepEqual(await ids(),hostIds().slice(0,12));assert.equal(await page.evaluate(()=>openCalls.length),3);
 ok('same-page mouse drag snaps into a continuous order and never opens the app');
 old=hostIds();before=revision();
 const start=await center(tiles().first()),end=await center(tiles().nth(6));
 await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:8});await page.keyboard.press('Escape');await page.mouse.up();
 assert.equal(revision(),before);assert.deepEqual(hostIds(),old);ok('Escape cancels a drag without saving');
 assert.deepEqual(await collect(),hostIds());await toPage(0);ok('all three pages are reachable, continuous and agree with page indicators');
 old=hostIds();before=revision();
 let source=await center(tiles().first()),surface=await page.locator('.dsl-viewport').boundingBox();
 await page.mouse.move(source.x,source.y);await page.mouse.down();await page.mouse.move(surface.x+surface.width-3,source.y,{steps:10});
 await page.waitForFunction(()=>document.querySelector('.dsl-root').dataset.dslPage==='1');
 let target=await center(tiles().nth(2));await page.mouse.move(target.x,target.y,{steps:6});await page.mouse.up();await waitFor(()=>revision()>before);await settle();
 assert.equal(hostIds()[14],old[0]);assert.equal(await page.evaluate(()=>openCalls.length),3);ok('right-edge dwell crosses to the next page and commits the chosen slot');
 before=revision();source=await center(page.locator(`.dsl-tile[data-dsl-id="${old[0]}"]`));surface=await page.locator('.dsl-viewport').boundingBox();
 await page.mouse.move(source.x,source.y);await page.mouse.down();await page.mouse.move(surface.x+3,source.y,{steps:10});
 await page.waitForFunction(()=>document.querySelector('.dsl-root').dataset.dslPage==='0');target=await center(tiles().nth(1));
 await page.mouse.move(target.x,target.y,{steps:6});await page.mouse.up();await waitFor(()=>revision()>before);await settle();assert.equal(hostIds()[1],old[0]);
 ok('left-edge dwell crosses back to the preceding page without opening');
 await page.waitForTimeout(750);source=await center(tiles().first());
 await touch('touchStart',source.x,source.y);await touch('touchEnd');await page.waitForTimeout(60);assert.equal(await page.evaluate(()=>openCalls.length),4);
 before=revision();surface=await page.locator('.dsl-viewport').boundingBox();const cy=surface.y+surface.height/2;
 await touch('touchStart',surface.x+surface.width*.8,cy);await touch('touchMove',surface.x+surface.width*.5,cy);await touch('touchMove',surface.x+surface.width*.2,cy);await touch('touchEnd');
 await page.waitForFunction(()=>document.querySelector('.dsl-root').dataset.dslPage==='1');assert.equal(revision(),before);assert.equal(await page.evaluate(()=>openCalls.length),4);
 ok('touch tap opens once; a horizontal swipe pages without a save or accidental open');
 source=await center(tiles().first());target=await center(tiles().nth(5));old=hostIds();before=revision();
 await touch('touchStart',source.x,source.y);await page.waitForTimeout(500);await touch('touchMove',target.x,target.y);await touch('touchEnd');
 await waitFor(()=>revision()>before);await settle();assert.equal(hostIds()[17],old[12]);assert.equal(await page.evaluate(()=>openCalls.length),4);
 ok('touch long press reorders and suppresses tap opening');
 before=revision();source=await center(tiles().first());target=await center(tiles().nth(5));
 await touch('touchStart',source.x,source.y);await page.waitForTimeout(500);await touch('touchMove',target.x,target.y);await touch('touchCancel');assert.equal(revision(),before);
 ok('touch cancellation discards the preview');
 before=revision();old=hostIds();
 for(const [width,height] of [[200,264],[260,340],[720,620],[400,360]]){
  await page.locator('#panel').evaluate((n,s)=>{n.style.width=s[0]+'px';n.style.height=s[1]+'px';},[width,height]);
  await page.waitForTimeout(60);assert.deepEqual(await collect(),old);
  const overflow=await page.locator('.dsl-root').evaluate(n=>n.scrollHeight>n.clientHeight||n.scrollWidth>n.clientWidth);assert.equal(overflow,false);
  assert.ok(await tiles().evaluateAll(nodes=>nodes.every(n=>{const b=n.getBoundingClientRect(),v=n.closest('.dsl-viewport').getBoundingClientRect();return b.top>=v.top-.5&&b.bottom<=v.bottom+.5&&b.left>=v.left-.5&&b.right<=v.right+.5;})));
  await page.screenshot({path:join(directory,'artifacts',`panel-${width}x${height}.png`)});
 }
 assert.equal(revision(),before);ok('four wide/narrow and tall/short panel sizes show every entry exactly once without scrolling or saving');
 await page.getByRole('searchbox').fill('应用');await toPage(0);before=revision();old=hostIds();
 await mouseDrag(await center(tiles().first()),await center(tiles().nth(2)));assert.equal(revision(),before);assert.deepEqual(hostIds(),old);assert.equal(await page.evaluate(()=>openCalls.length),4);
 assert.deepEqual(await collect(),old);await page.getByRole('searchbox').fill('不存在');assert.match(await page.locator('.dsl-empty').textContent(),/没有匹配/);
 await page.getByRole('searchbox').press('Escape');assert.deepEqual(await collect(),old);assert.equal(revision(),before);ok('search results paginate in saved order; dragging, searching and clearing never write order');
 await page.reload();await ready();assert.deepEqual(await collect(),old);await toPage(0);
 await page.evaluate(()=>{tree.unmount();mount();});await ready();assert.deepEqual(await collect(),old);
 await page.evaluate(()=>reconnect());await page.waitForTimeout(100);assert.deepEqual(await collect(),old);
 ok('refresh, guide remount and connection reset restore the host order');
 const second=await context.newPage();second.on('pageerror',e=>errors.push(e.message));await second.goto(url);await ready(second);
 await second.locator('#panel').evaluate(n=>{n.style.width='260px';n.style.height='340px';});await second.waitForTimeout(60);
 assert.deepEqual(await second.locator('.dsl-tile').evaluateAll(ns=>ns.map(n=>n.dataset.dslId)),old.slice(0,Number(await second.locator('.dsl-root').getAttribute('data-dsl-capacity'))));await second.close();ok('a second client reads the same order and computes its own page capacity');
 await toPage(0);before=revision();old=hostIds();await page.route('**/api/dsh-appview/move',route=>route.abort());
 await mouseDrag(await center(tiles().first()),await center(tiles().nth(2)));await page.waitForFunction(()=>document.querySelector('.dsl-notice').textContent.includes('排序未保存'));
 assert.equal(revision(),before);assert.deepEqual(await ids(),old.slice(0,Number(await page.locator('.dsl-root').getAttribute('data-dsl-capacity'))));await page.unroute('**/api/dsh-appview/move');await page.locator('.dsl-retry').click();await ready();
 ok('failed saves restore the last host order and offer retry');
 registryIds.push('app-99');await page.evaluate(()=>setEntries([...entries,makeEntry('app-99')]));await waitFor(()=>hostIds().at(-1)==='app-99');
 assert.deepEqual(hostIds().slice(0,-1),old);
 const removed=[hostIds()[0],hostIds()[Math.floor(hostIds().length/2)],hostIds().at(-1)];registryIds=registryIds.filter(id=>!removed.includes(id));
 await page.evaluate(removed=>setEntries(entries.filter(e=>!removed.includes(e.id))),removed);await waitFor(()=>removed.every(id=>!hostIds().includes(id)));assert.deepEqual(hostIds(),[...old,'app-99'].filter(id=>!removed.includes(id)));
 const remaining=hostIds();await page.reload();await ready();assert.deepEqual(await collect(),remaining);ok('new entries append to the full list; removals compact every page and survive reload');
 const cap=Number(await page.locator('.dsl-root').getAttribute('data-dsl-capacity'));
 registryIds=remaining.slice(0,cap);await page.evaluate(ids=>setEntries(ids.map(makeEntry)),registryIds);await waitFor(()=>hostIds().length===cap);
 assert.equal(await page.locator('[data-dsl-pages]').textContent(),'第 1 / 1 页');assert.equal(await tiles().count(),cap);
 registryIds=remaining.slice(0,cap+1);await page.evaluate(ids=>setEntries(ids.map(makeEntry)),registryIds);await waitFor(()=>hostIds().length===cap+1);
 assert.equal(await page.locator('[data-dsl-pages]').textContent(),'第 1 / 2 页');await toPage(1);assert.equal(await tiles().count(),1);
 registryIds=[];await page.evaluate(()=>setEntries([]));await waitFor(()=>hostIds().length===0);
 assert.equal(await tiles().count(),0);assert.match(await page.locator('.dsl-empty').textContent(),/还没有/);assert.equal(await page.locator('[data-dsl-pages]').textContent(),'第 1 / 1 页');
 registryIds=remaining.slice(0,3);await page.evaluate(ids=>setEntries(ids.map(makeEntry)),registryIds);await waitFor(()=>hostIds().length===3);
 before=revision();await mouseDrag(await center(tiles().first()),await center(tiles().nth(1)));await waitFor(()=>revision()>before);await settle();
 before=revision();source=await center(tiles().first());target=await center(tiles().nth(2));
 await page.mouse.move(source.x,source.y);await page.mouse.down();await page.mouse.move(target.x,target.y,{steps:6});
 await page.locator('#panel').evaluate(n=>n.style.width='260px');await page.waitForTimeout(60);await page.mouse.up();assert.equal(revision(),before);assert.equal(await page.locator('.dsl-floating').count(),0);
 await page.locator('#panel').evaluate(n=>{n.style.width='100px';n.style.height='220px';});await page.waitForTimeout(60);
 assert.match(await page.locator('.dsl-empty').textContent(),/请增大面板/);assert.equal(revision(),before);
 ok('empty/exact/overflow page boundaries clamp correctly; resizing cancels a drag and tiny panels show a size notice');
 assert.deepEqual(errors,[]);ok('no browser runtime errors');
 console.log(`Browser check passed: ${count} checks verified. Chromium ${browser.version()}; touch is CDP-emulated, not real hardware.`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));await runtime.close();}
