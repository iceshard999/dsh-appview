/** Real DSH UI smoke test, always against the project's isolated install. */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const testHome=resolve(root,'.test-home');
if(!testHome.startsWith(resolve(root)+'/'))throw Error('Unsafe test home');
const installed=JSON.parse(await readFile(join(testHome,'profiles/web/node_modules/dsh-appview/package.json'),'utf8'));assert.equal(installed.version,'0.3.1');
const artifacts=join(root,'.verify-browser/artifacts');await mkdir(artifacts,{recursive:true});await mkdir(join(testHome,'workspace'),{recursive:true});
const env={...process.env,DSH_HOME:testHome,XDG_CONFIG_HOME:join(testHome,'xdg/config'),XDG_DATA_HOME:join(testHome,'xdg/data'),XDG_CACHE_HOME:join(testHome,'xdg/cache'),XDG_STATE_HOME:join(testHome,'xdg/state'),PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH??join(root,'.verify-browser/browsers')};
const command=process.env.DSH_CLI??'dsh';
const child=spawn(command,['--profile','web','--host','127.0.0.1','--port','0','--no-open'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser;
try{
 let url;
 for(let i=0;i<100;i++){
  url=log.replace(/\x1b\[[0-9;]*m/g,'').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._~-]+/)?.[0];
  if(url)break;if(child.exitCode!==null)throw Error('Isolated DSH exited before serving the UI');await sleep(300);
 }
 if(!url)throw Error('Isolated DSH did not announce an authenticated URL');
 process.env.PLAYWRIGHT_BROWSERS_PATH=env.PLAYWRIGHT_BROWSERS_PATH;
 const require=createRequire(import.meta.url);
 const {chromium}=require(process.env.PLAYWRIGHT_PATH??'playwright');
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url);await page.waitForTimeout(3000);
 const hostRead=await page.evaluate(async()=>{
  const response=await fetch('/api/dsh-appview/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'gui-smoke',method:'dsh-appview/read',payload:{}})});
  return {status:response.status,body:await response.text()};
 });
 assert.equal(hostRead.status,200);assert.equal(JSON.parse(hostRead.body).result.ok,true);
 const notice=page.getByRole('button',{name:'Continue',exact:true});if(await notice.count())await notice.click();
 await page.waitForTimeout(500);
 const close=page.getByRole('button',{name:'Close',exact:true});if(await close.count())await close.click();
 if(!await page.getByRole('button',{name:'Open right sidebar',exact:true}).count()){
  await page.getByRole('button',{name:'Choose workspace',exact:true}).click();
  await page.getByRole('button',{name:'Edit path',exact:true}).click();
  const pathInput=page.locator('[role="dialog"] input').first();
  await pathInput.fill(join(testHome,'workspace'));await pathInput.press('Enter');
  await page.getByRole('button',{name:'Open',exact:true}).click();
 }
 await page.getByRole('button',{name:'Open right sidebar',exact:true}).click();
 await page.locator('.dsl-root').waitFor();
 await page.waitForFunction(()=>document.querySelector('.dsl-notice')?.textContent === '');
 const tiles=page.locator('.dsl-tile');assert.equal(await tiles.count(),2);
 const read=()=>page.evaluate(async()=>{
  const response=await fetch('/api/dsh-appview/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'gui-check',method:'dsh-appview/read',payload:{}})});
  return(await response.json()).result.value;
 });
 const before=await read();
 const first=await tiles.first().boundingBox(),last=await tiles.last().boundingBox();
 await page.mouse.move(first.x+first.width/2,first.y+first.height/2);await page.mouse.down();
 await page.mouse.move(last.x+last.width/2,last.y+last.height/2,{steps:8});await page.mouse.up();
 await page.waitForFunction(()=>!document.querySelector('.dsl-notice').textContent.includes('正在保存'));
 const saved=await read();assert.deepEqual(saved.keys,[...before.keys].reverse());
 const box=await page.locator('.dsl-root').boundingBox();
 const tileKeys=await tiles.evaluateAll(nodes=>nodes.map(n=>n.dataset.dslKey));assert.deepEqual(tileKeys,saved.keys);
 await page.screenshot({path:join(artifacts,'dsh-isolated-desktop.png')});
 await page.reload();await page.waitForTimeout(2500);
 const accountClose=page.getByRole('button',{name:'Close',exact:true});if(await accountClose.count())await accountClose.click();
 const openSidebar=page.getByRole('button',{name:'Open right sidebar',exact:true});if(await openSidebar.count())await openSidebar.click();
 await page.locator('.dsl-root').waitFor();
 assert.deepEqual(await tiles.evaluateAll(nodes=>nodes.map(n=>n.dataset.dslKey)),saved.keys);
 await page.locator('.dsl-tile[data-dsl-tile="files"]').click();
 await page.locator('.dsl-root').waitFor({state:'detached'});
 const panel = page.locator('[data-sidebar-right-panel]:visible');
 const measurements = [];
 const bounds = () => panel.boundingBox();
 const sameBounds = (a, b) => { for (const key of ['x','y','width','height']) assert.ok(Math.abs(a[key]-b[key]) < 0.5, `${key} changed: ${a[key]} -> ${b[key]}`); };
 async function closeToDesktop(label) {
  const before = await bounds(), mode = await panel.getAttribute('data-sidebar-right-panel');
  await panel.evaluate(node => {
   window.closeTrace = [];
   window.closeObserver = new MutationObserver(records => window.closeTrace.push(...records.map(record => record.attributeName)));
   closeObserver.observe(node,{attributes:true,attributeFilter:['data-sidebar-right-open','data-sidebar-right-panel']});
  });
  await panel.getByRole('button',{name:'Close',exact:true}).last().click();
  await page.locator('.dsl-root').waitFor({state:'visible'});
  await page.waitForTimeout(350);
  sameBounds(before, await bounds());
  assert.equal(await panel.getAttribute('data-sidebar-right-panel'),mode);
  assert.notEqual(await panel.getAttribute('data-sidebar-right-open'),null);
  assert.deepEqual(await page.evaluate(() => { closeObserver.disconnect(); return closeTrace; }),[],'panel collapsed or changed mode during close');
  measurements.push({label,mode,bounds:before}); console.log('Verified close to desktop:',label,JSON.stringify(before));
 }
 const openFiles = async () => { await page.locator('.dsl-tile[data-dsl-tile="files"]').click(); await page.locator('.dsl-root').waitFor({state:'detached'}); };
 await closeToDesktop('ordinary');
 const defaultBounds = await bounds(), handle = await page.locator('[data-side="rightbar"]').boundingBox();
 await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2); await page.mouse.down();
 await page.mouse.move(handle.x+handle.width/2+85,handle.y+handle.height/2,{steps:8}); await page.mouse.up();
 await page.waitForTimeout(700);
 assert.ok(Math.abs((await bounds()).width-defaultBounds.width)>40,'right sidebar drag did not resize');
 await openFiles(); await closeToDesktop('custom width');
 await panel.locator('[data-sidebar-right-mode="fullscreen"]').click(); await page.waitForTimeout(700);
 await openFiles(); await closeToDesktop('manual fullscreen');
 assert.equal(await panel.getAttribute('data-sidebar-right-panel'),'fullscreen');
 await panel.locator('[data-sidebar-right-mode="push"]').click(); await page.waitForTimeout(700);
 await openFiles();
 const add = panel.getByRole('button',{name:'New tab',exact:true});
 await add.click(); await page.locator('.dsl-root').waitFor({state:'visible'});
 await page.locator('.dsl-tile[data-dsl-tile="terminal"]').click(); await page.locator('.dsl-root').waitFor({state:'detached'});
 assert.equal(await panel.getByRole('button',{name:'Close',exact:true}).count(),2);
 await panel.getByRole('button',{name:'Close',exact:true}).last().click();
 assert.equal(await page.locator('.dsl-root').count(),0,'closing a non-final tool unexpectedly opened desktop');
 assert.equal(await panel.getByRole('button',{name:'Close',exact:true}).count(),1);
 await closeToDesktop('last of multiple tabs');
 await page.screenshot({path:join(artifacts,'dsh-close-to-desktop.png')});
 await panel.locator('[data-sidebar-right-toggle]').click();
 await page.getByRole('button',{name:'Open right sidebar',exact:true}).waitFor({state:'visible'});
 await page.getByRole('button',{name:'Open right sidebar',exact:true}).click(); await page.locator('.dsl-root').waitFor({state:'visible'});
 await page.setViewportSize({width:600,height:850}); await page.waitForTimeout(700);
 await openFiles(); await closeToDesktop('automatic fullscreen');
 assert.equal(await panel.getAttribute('data-sidebar-right-panel'),'fullscreen');
 console.log('Close-to-desktop GUI cases:',JSON.stringify(measurements));
 assert.deepEqual(errors,[]);
 assert.ok(!log.includes('dsh-appview (dsh-appview): Error:'),'AppView host activation failed');
 console.log('Real DSH smoke passed: host activation + authenticated layout RPC; actual guide mount and drag save; refresh restores order; native files entry opens; final close returns to desktop without size/mode changes; ordinary/custom width/fullscreen/multiple tabs/narrow viewport and manual collapse verified.');
 console.log('DSH 0.2.1-rc.5; desktop bounds:',JSON.stringify(box),'Chromium',browser.version());
}catch(error){console.log('GUI_SMOKE_FAILURE:',String(error.stack??error.message).replace(/([?&]token=)[A-Za-z0-9._~-]+/g,'$1[redacted]'));process.exitCode=1;}finally{
 if(browser)await browser.close();
 child.kill('SIGTERM');
 for(let i=0;i<50&&child.exitCode===null;i++)await sleep(100);
 if(child.exitCode===null)child.kill('SIGKILL');
 // Redact the ephemeral login token before saving diagnostic output.
 await writeFile(join(artifacts,'dsh-isolated.log'),log.replace(/([?&]token=)[A-Za-z0-9._~-]+/g,'$1[redacted]'));
}
