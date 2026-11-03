/** Actual pinned Chromium/RTX R76 one-class-swap integration, not a mock. */
import {spawn} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]||'.'),out=resolve(process.argv[3]||join(root,'artifacts/r76-dropin'));
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
await mkdir(out,{recursive:true});
const summary={schema:'r76-boost-map-rtx-smoke-v1',candidate:process.env.R76_CANDIDATE_SHA||null,
  scenes:[],errors:[],pass:false};
const port=4185,base='http://127.0.0.1:'+port;
const server=spawn(process.execPath,[join(root,'examples/compare/serve.mjs')],{cwd:root,env:{...process.env,OLVT_EXAMPLE_PORT:String(port)},stdio:'pipe'});
let output='',browser=null;
server.stdout.on('data',b=>output+=b.toString());server.stderr.on('data',b=>output+=b.toString());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(v,message)=>{if(!v)throw Error(message)};
async function auditScreenshot(page,name){
 const png=await page.locator('#map').screenshot({path:join(out,name+'.png')});
 const result=await page.evaluate(async data=>{
   const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
   const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
   const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
   const pixels=ctx.getImageData(0,0,c.width,c.height).data;
   let colored=0;const samples=new Set();
   for(let i=0;i<pixels.length;i+=4){
     if(pixels[i]!==11||pixels[i+1]!==18||pixels[i+2]!==32)colored++;
     if(i%64===0)samples.add(pixels[i]+','+pixels[i+1]+','+pixels[i+2]);
   }
   return {colored,colors:samples.size};
 },png.toString('base64'));
 check(result.colored>30&&result.colors>=3,'Blank or monochrome map at '+name+' '+JSON.stringify(result));
 return result;
}
try {
 let live=false;
 for(let i=0;i<120;i++){
   if(server.exitCode!==null)throw Error('Server exited '+output);
   try{if((await fetch(base+'/examples/dropin/index.html')).ok){live=true;break}}catch{}
   await sleep(150);
 }
 check(live,'Server did not start '+output);
 browser=await chromium.launch({executablePath:process.env.M5_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',
   headless:true,args:['--enable-webgl','--disable-software-rasterizer','--disable-background-networking','--window-size=620,650']});
 for(const count of [8,50]){
   const page=await browser.newPage({viewport:{width:520,height:560},deviceScaleFactor:1});
   const errors=[];
   page.on('pageerror',e=>errors.push('pageerror '+String(e)));
   page.on('console',m=>{if(m.type()==='error')errors.push('console '+m.text())});
   await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
   try{
     await page.goto(base+'/examples/dropin/index.html?count='+count,{waitUntil:'domcontentloaded',timeout:45000});
     await page.waitForFunction(()=>globalThis.__r76?.ready||globalThis.__r76?.errors?.length,{timeout:50000});
     const init=await page.evaluate(()=>{
       const r=globalThis.__r76,map=r.map;
       if(!map)return {errors:r.errors};
       const gl=map.boost?.backend?.gl,ext=gl?.getExtension('WEBGL_debug_renderer_info');
       return {errors:r.errors,expected:r.expectedLayers,layers:map.getAllLayers().length,
         status:map.getBoostStatus(),exclusive:map.boost?.exclusiveActive,
         renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,
         overlayMounted:map.boost?.scene?.canvasHost?.attached,
         cssActive:map.getViewport().classList.contains('olvt-boost-exclusive'),
         workerOff:map.boost?.workerEnabled===false,
         frames:map.boost?.scene?.frames??0,sourceLayer:map.getAllLayers()[0]===r.layers[0]};
     });
     check(init.errors.length===0&&init.status?.enabled,'Drop-in not enabled '+JSON.stringify(init));
     check(init.expected===count&&init.layers===count&&init.sourceLayer,'Existing OL layers not preserved');
     check(init.exclusive&&init.overlayMounted&&init.cssActive&&init.workerOff,'Missing shared GPU ownership '+JSON.stringify(init));
     check(/NVIDIA.*RTX 5060 Ti/i.test(init.renderer||''),'Not RTX 5060 Ti '+init.renderer);
     await page.waitForFunction(count=>{
       const r=globalThis.__r76,b=r?.map?.boost;
       return b?.scene?.snapshot()?.tileCount>=count && b?.scene?.frames>1;
     },count,{timeout:35000});
     const frames=await page.evaluate(()=>{
       const r=globalThis.__r76,boost=r.map.boost,snap=boost.snapshot();
       return {tileCount:snap.tileCount,layerCount:snap.layers.length,packets:snap.drawPackets,
         frames:snap.frames,glError:snap.frameStats?.glError||0,
         programCache:boost.backend.programs.size};
     });
     check(frames.layerCount===count&&frames.tileCount>=count&&frames.glError===0,'Incomplete shared scene '+JSON.stringify(frames));
     const initialPixels=await auditScreenshot(page,'boost-'+count);
     const updated=await page.evaluate(()=>{
       const r=globalThis.__r76,boost=r.map.boost,previous=r.layers[0].style_;
       r.layers[0].setStyle({'stroke-color':'#00ff00','stroke-width':5});
       r.map.renderSync();
       return {changed:r.layers[0].style_!==previous,status:r.map.getBoostStatus(),
         snapshot:r.map.boost?.snapshot()?.tileCount||0};
     });
     check(updated.changed&&updated.status?.enabled,'setStyle not compatible '+JSON.stringify(updated));
     const rollback=await page.evaluate(()=>{
       const r=globalThis.__r76,map=r.map,view=r.view;
       const before={center:[...view.getCenter()],resolution:view.getResolution()};
       map.disableBoost();map.renderSync();
       return {status:map.getBoostStatus(),boost:!!map.boost,
         cssActive:map.getViewport().classList.contains('olvt-boost-exclusive'),
         centerPreserved:JSON.stringify(before.center)===JSON.stringify(view.getCenter()),
         resolutionPreserved:before.resolution===view.getResolution(),
         olCanvasCount:map.getTargetElement().querySelectorAll('.ol-layer canvas').length};
     });
     check(!rollback.status.enabled&&!rollback.boost&&!rollback.cssActive&&
       rollback.centerPreserved&&rollback.resolutionPreserved&&rollback.olCanvasCount>0,
       'Stock OpenLayers rollback failed '+JSON.stringify(rollback));
     await page.waitForTimeout(300);
     const stockPixels=await auditScreenshot(page,'stock-'+count);
     const reenabled=await page.evaluate(()=>{
       const map=globalThis.__r76.map;map.enableBoost();map.renderSync();
       return {status:map.getBoostStatus(),exclusive:map.boost?.exclusiveActive};
     });
     check(reenabled.status.enabled&&reenabled.exclusive,'Cannot re-enable '+JSON.stringify(reenabled));
     check(!errors.length,'Browser errors '+JSON.stringify(errors));
     summary.scenes.push({count,init,frames,initialPixels,styleUpdated:updated,rollback,stockPixels,reenabled,errors});
     console.log('R76_PHYSICAL_DROPIN_SCENE_PASS',JSON.stringify({count,programCache:frames.programCache,rollback:rollback.status}));
   }finally{await page.close();}
 }
 summary.pass=summary.scenes.length===2;
}catch(e){summary.errors.push(String(e?.stack||e));console.error('R76_PHYSICAL_DROPIN_FAIL',summary.errors.at(-1))}
finally{
 await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
 try{await browser?.close()}catch{}
 if(server.exitCode===null){server.kill();await sleep(500)}
}
console.log('R76_PHYSICAL_DROPIN_SUMMARY',JSON.stringify({pass:summary.pass,scenes:summary.scenes.length,errors:summary.errors}));
if(!summary.pass)process.exitCode=1;
