/** R63 real Chromium RTX OpenLayers fallback acceptance.
 * Deliberately injects a product-level M5 failure, demands actual M5 scene
 * teardown and continued stock OL painting/input at the SAME View.
 * Not a spontaneous GL context-loss test or release installer proof.
 */
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,sep,extname,join} from 'node:path';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
const root=resolve(process.argv[2]||'.'),out=resolve(process.argv[3]||join(root,'RESULTS','R63_FALLBACK'));
await mkdir(out,{recursive:true});
const result={pass:false,checks:[],screens:{},snapshots:{},errors:[]};
let server,browser,page;
const requireThat=(yes,text)=>{if(!yes)throw Error('R63 '+text);result.checks.push(text)};
try{
 server=createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://127.0.0.1');
   if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
   const path=resolve(root,'.'+decodeURIComponent(url.pathname));
   if(req.method!=='GET'||!path.startsWith(root+sep)||!existsSync(path))throw Error('forbidden or not found');
   const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.pbf':'application/octet-stream'};
   res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(await readFile(path));
  }catch(e){res.writeHead(404);res.end(String(e));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 browser=await chromium.launch({executablePath:process.env.M5_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--disable-software-rasterizer','--disable-background-networking','--window-size=1120,720']});
 page=await browser.newPage({viewport:{width:1120,height:720},deviceScaleFactor:1});
 page.on('pageerror',e=>result.errors.push('pageerror '+String(e)));
 page.on('console',m=>{if(m.type()==='error')result.errors.push('console '+m.text())});
 await page.goto('http://127.0.0.1:'+server.address().port+'/tests/rtx/real_ol_fallback.html',{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.__r53?.ready||window.__r53?.errors?.length,null,{timeout:45000});
 await page.waitForFunction(()=>{const s=window.__r53Snapshot?.();return s?.sourceLoads>=32&&s?.painted>0||s?.errors?.length>0},null,{timeout:10000});
 const init=await page.evaluate(()=>__r53Snapshot());result.snapshots.before=init;
 requireThat(init.ready&&init.sourceLoads===32&&init.drawPackets>=32&&init.painted>0&&init.glError===0&&init.errors.length===0,'32 MVT sources render initial M5 frame without GL errors');
 requireThat(/NVIDIA.*RTX 5060 Ti/i.test(init.renderer||''),'physical NVIDIA RTX 5060 Ti');
 const mode0=await page.evaluate(()=>__r63Snapshot());
 requireThat(mode0.workerDefaultOff===true&&mode0.mode==='m5'&&mode0.m5Visible,'Worker OFF is actual M5 default');
 requireThat(mode0.gateActive===true&&mode0.gateOverrideCount===32,'R73 source-only gate suppresses all 32 stock OL layers');
 // Stock OL is alive while M5 is showing; screenshot after fallback shows OL.
 const fault=await page.evaluate(()=>__r63Fallback('injected-production-render-error'));
 result.snapshots.fault=fault;
 requireThat(fault.mode==='ol'&&fault.rollbackCount===1&&fault.bindingStopped===true&&fault.workerDefaultOff===true,'M5 scene actually stops; OL takes over with Worker OFF');
 requireThat(fault.gateStopped===true,'R73 gate restores exact stock OL layer render methods at fault');
 requireThat(JSON.stringify(fault.lastViewBefore)===JSON.stringify(fault.lastViewAfter),'fallback preserves OL center/resolution/rotation exactly');
 const after=await page.evaluate(()=>__r63Snapshot());result.snapshots.after=after;
 requireThat(after.mode==='ol'&&!after.m5Visible&&after.mapTargetAttached&&after.webglCanvasCount>0,'stock OpenLayers WebGL canvas is visible at fallback target');
 await page.waitForTimeout(800);
 const image=await page.screenshot({path:join(out,'ol-fallback.png'),clip:{x:0,y:0,width:512,height:512}});
 result.screens.fallbackBytes=image.length;
 // A user input after fallback must move OL, not revive M5.
 await page.mouse.move(240,215);await page.mouse.down();await page.mouse.move(160,230,{steps:10});await page.mouse.up();
 await page.waitForTimeout(650);
 const drag=await page.evaluate(()=>__r63Snapshot());result.snapshots.drag=drag;
 requireThat(drag.mode==='ol'&&drag.bindingStopped&&drag.frames>after.frames&&
  Math.abs(drag.view.center[0]-after.view.center[0])>30,'pointer drag remains responsive on stock OL after failure');
 const wheelBefore=drag.view.resolution;
 await page.mouse.move(240,215);await page.mouse.wheel(0,-330);await page.waitForTimeout(900);
 const wheel=await page.evaluate(()=>__r63Snapshot());result.snapshots.wheel=wheel;
 requireThat(wheel.mode==='ol'&&wheel.bindingStopped&&Math.abs(wheel.view.resolution-wheelBefore)>0.01,
  'wheel zoom remains responsive on stock OL and does not re-enable M5');
 requireThat(wheel.sourceErrors===0&&wheel.errors.length===0,'fallback introduces zero OL tile/source errors');
 result.pass=result.errors.length===0;
}catch(e){result.error=String(e.stack||e);result.pass=false}
finally{
 if(result.errors.length){result.pass=false;result.error=(result.error||'')+' Browser console '+JSON.stringify(result.errors)}
 await writeFile(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
 try{await page?.close()}catch{}try{await browser?.close()}catch{}
 if(server?.listening)await new Promise(ok=>server.close(ok));
}
console.log(result.pass?'R63_OL_ROLLBACK_PASS':'R63_OL_ROLLBACK_FAIL',JSON.stringify({checks:result.checks,error:result.error}));
if(!result.pass)process.exitCode=1;