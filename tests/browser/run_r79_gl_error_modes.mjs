/** R79: same local 32 unique MVT PBFs; strict vs nonblocking ABBA. */
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]||'.'),output=resolve(process.argv[3]||join(root,'artifacts/r79-modes'));
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
const software=process.env.R79_ALLOW_SOFTWARE_GL==='1',port=4189,origin='http://127.0.0.1:'+port;
const result={schema:'r79-error-modes-v1',sha:process.env.R79_CANDIDATE_SHA||null,
 gpu:software?'software-webgl':'physical-rtx',samples:[],fallbacks:[],aggregates:[],errors:[],pass:false};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(x,message)=>{if(!x)throw Error(message)};
const median=x=>{const a=[...x].sort((a,b)=>a-b),n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2};
const round=n=>Math.round(n*100)/100;
await mkdir(output,{recursive:true});
const server=spawn(process.execPath,[join(root,'examples/compare/serve.mjs')],{
 cwd:root,env:{...process.env,OLVT_EXAMPLE_PORT:String(port)},stdio:'pipe'});
let serverLog='',browser;
server.stdout.on('data',b=>serverLog+=b.toString());
server.stderr.on('data',b=>serverLog+=b.toString());
try{
 let online=false;
 for(let i=0;i<150;i++){
  if(server.exitCode!==null)throw Error('Server exit '+serverLog);
  try{if((await fetch(origin+'/examples/webgl-vector-tiles-benchmark/index.html')).ok){online=true;break}}catch{}
  await delay(150);
 }
 assert(online,'Benchmark server unavailable '+serverLog);
 browser=await chromium.launch({executablePath:process.env.M5_BROWSER||
   'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless:true,args:software?
   ['--enable-webgl','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-background-networking']:
   ['--enable-webgl','--disable-software-rasterizer','--disable-background-networking']});
 const cases=[];
 for(const count of [8,32])for(const mode of ['strict','nonblocking','nonblocking','strict'])cases.push({count,mode});
 for(let index=0;index<cases.length;index++){
  const {count,mode}=cases[index],page=await browser.newPage({
   viewport:{width:1100,height:700},deviceScaleFactor:1});
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(String(error)));
  page.on('console',msg=>{if(msg.type()==='error')pageErrors.push('console: '+msg.text())});
  await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
  await page.addInitScript(()=>{
    const proto=WebGLRenderingContext.prototype,orig=proto.getError;
    window.__r79Polls=0;
    proto.getError=function(...args){
      if(this===window.__webglExampleBenchmark?.map?.boost?.backend?.gl)window.__r79Polls++;
      return orig.apply(this,args);
    };
  });
  try{
   await page.goto(origin+'/examples/webgl-vector-tiles-benchmark/index.html?renderer=boost&count='+count+'&check='+mode,
    {waitUntil:'domcontentloaded',timeout:45000});
   await page.waitForFunction(()=>{
    const s=window.__webglExampleBenchmark;
    return s?.ready||s?.errors?.length;
   },null,{timeout:50000});
   const initial=await page.evaluate(()=>{
    const s=window.__webglExampleBenchmark,b=s.map?.boost,gl=b?.backend?.gl;
    const ext=gl?.getExtension('WEBGL_debug_renderer_info');
    return {ready:s.ready,errors:s.errors,loaded:s.loadedCount,
      tiles:b?.snapshot()?.tileCount,exclusive:b?.exclusiveActive,
      checkMode:b?.backend?.glErrorCheckMode,checked:b?.snapshot()?.frameStats?.glErrorChecked,
      programCount:b?.backend?.programs?.size,initialPolls:window.__r79Polls,
      renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null};
   });
   assert(initial.ready&&!initial.errors.length&&initial.exclusive&&initial.loaded>=count&&
    initial.tiles>=count&&initial.checkMode===mode&&initial.programCount>0,
    'Boost scene not ready '+JSON.stringify({index,initial}));
   assert(initial.checked===(mode==='strict'),'Wrong initial checked flag');
   if(!software)assert(/NVIDIA.*RTX 5060 Ti/i.test(initial.renderer||''),
     'Physical RTX unavailable '+initial.renderer);
   const pan=await page.evaluate(()=>window.__webglExampleBenchmark.runPan(24));
   const after=await page.evaluate(()=>{
    const s=window.__webglExampleBenchmark,b=s.map.boost;
    return {polls:window.__r79Polls,checked:b.snapshot().frameStats.glErrorChecked,
      glError:b.snapshot().frameStats.glError,errors:s.errors,
      drawPackets:b.snapshot().drawPackets,programs:b.backend.programs.size};
   });
   assert(!after.errors.length&&!pageErrors.length,'Browser runtime errors '+JSON.stringify({index,after,pageErrors}));
   const delta=after.polls-initial.initialPolls;
   assert(mode==='strict'?delta>=24:delta===0,'Hot-path GL error calls '+JSON.stringify({index,delta,mode}));
   assert(after.checked===(mode==='strict')&&
    (mode==='strict'?after.glError===0:after.glError===null),
    'Error state cannot be confused with an actual check '+JSON.stringify(after));
   const filename='r79-'+count+'-'+mode+'-'+index+'.png';
   const png=await page.locator('#map').screenshot({path:join(output,filename)});
   assert(png.length>1000,'Invalid screenshot');
   const diagnostic=await page.evaluate(()=>{
    const b=window.__webglExampleBenchmark.map.boost;
    const t=performance.now(),error=b.backend.checkGlError();
    return {error,elapsedMs:performance.now()-t};
   });
   assert(diagnostic.error===0,'Explicit post-pan GL error '+JSON.stringify(diagnostic));
   result.samples.push({index,count,mode,pan,initial,after,pollDelta:delta,diagnostic,filename});
   console.log('R79_GL_MODE_PASS',JSON.stringify({count,mode,
     panMedianMs:round(pan.medianMs),panP95Ms:round(pan.p95Ms),
     pollDelta:delta,programs:after.programs,explicitGLError:diagnostic.error}));
   if(index===3){
     await page.evaluate(()=>{
      const map=window.__webglExampleBenchmark.map,gl=map.boost.backend.gl;
      const orig=gl.getError.bind(gl);
      gl.getError=function(){gl.getError=orig;return gl.INVALID_OPERATION};
      try{map.renderSync()}catch{}
      try{map.renderSync()}catch{}
     });
     await page.waitForFunction(()=>{
      const map=window.__webglExampleBenchmark.map;
      return !map.getBoostStatus().enabled&&!map.boost &&
        map.getTargetElement().querySelectorAll('canvas.ol-layer, .ol-layer canvas').length>0;
     },null,{timeout:12000});
     const status=await page.evaluate(()=>window.__webglExampleBenchmark.map.getBoostStatus());
     result.fallbacks.push({kind:'forced-strict-error',status});
     console.log('R79_STRICT_ERROR_FALLBACK_PASS');
   }
   if(index===6){
     const kicked=await page.evaluate(()=>{
      const gl=window.__webglExampleBenchmark.map.boost.backend.gl,
        ext=gl.getExtension('WEBGL_lose_context');
      if(!ext)return false;
      ext.loseContext();
      return true;
     });
     assert(kicked,'WEBGL_lose_context unavailable');
     await page.waitForFunction(()=>{
      const map=window.__webglExampleBenchmark.map;
      return !map.getBoostStatus().enabled&&!map.boost &&
        map.getTargetElement().querySelectorAll('canvas.ol-layer, .ol-layer canvas').length>0;
     },null,{timeout:12000});
     const status=await page.evaluate(()=>window.__webglExampleBenchmark.map.getBoostStatus());
     assert(/contextlost/i.test(status.reason),'Wrong context-loss reason '+JSON.stringify(status));
     result.fallbacks.push({kind:'nonblocking-context-loss',status});
     console.log('R79_CONTEXT_LOSS_FALLBACK_PASS');
   }
  }finally{await page.close()}
 }
 for(const count of [8,32]){
   const old=result.samples.filter(x=>x.count===count&&x.mode==='strict');
   const fast=result.samples.filter(x=>x.count===count&&x.mode==='nonblocking');
   assert(old.length===2&&fast.length===2,'ABBA not balanced');
   const a=round(median(old.map(x=>x.pan.medianMs))),b=round(median(fast.map(x=>x.pan.medianMs)));
   result.aggregates.push({count,strictMedianMs:a,nonblockingMedianMs:b,
    submissionReductionPct:round(100*(1-b/a))});
 }
 result.pass=result.samples.length===8&&result.fallbacks.length===2&&result.errors.length===0;
}catch(error){
 result.errors.push(String(error?.stack||error));
 console.error('R79_MODE_TEST_FAILED',result.errors.at(-1));
}finally{
 await writeFile(join(output,'summary.json'),JSON.stringify(result,null,2)+'\n');
 try{await browser?.close()}catch{}
 if(server.exitCode===null){server.kill();await delay(350)}
}
console.log('R79_MODE_SUMMARY',JSON.stringify({pass:result.pass,samples:result.samples.length,
 fallbacks:result.fallbacks.length,aggregates:result.aggregates,errors:result.errors}));
if(!result.pass)process.exitCode=1;
