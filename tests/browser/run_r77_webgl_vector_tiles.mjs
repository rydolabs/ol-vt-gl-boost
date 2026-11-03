/**
 * R77 fair warm-PBF performance smoke for a Mapbox-like local vector-tile map.
 *
 * Engines run in isolated pages, in alternating ABBA order. Network/PBF
 * download is explicitly excluded from first completed scene time. Pan numbers
 * measure JS main-thread map.renderSync() submission, not full GPU frames/FPS.
 * Physical RTX assertions stay mandatory unless software explicitly opted in.
 */
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]||'.'),dir=resolve(process.argv[3]||join(root,'artifacts/r77-example'));
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
const software=process.env.R77_ALLOW_SOFTWARE_GL==='1';
const candidate=process.env.R77_CANDIDATE_SHA||null;
const host='http://127.0.0.1:4187';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(x,message)=>{if(!x)throw Error(message)};
const server=spawn(process.execPath,[join(root,'examples/compare/serve.mjs')],{
 cwd:root,env:{...process.env,OLVT_EXAMPLE_PORT:'4187'},stdio:'pipe'
});
let serverLog='',browser=null;
server.stdout.on('data',x=>serverLog+=x.toString());
server.stderr.on('data',x=>serverLog+=x.toString());
const summary={schema:'r77-example-ol-vs-boost-1',candidate,mode:software?'software-webgl':'physical-rtx',
 source:'MapLibre/OpenMapTiles distinct locally preloaded MVT 32 tiles; NOT original Mapbox Streets',
 olVersion:'10.10.0',dimensions:[512,512],cycles:2,
 measurements:[],aggregates:[],errors:[],pass:false};
await mkdir(dir,{recursive:true});
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const median=a=>{const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;};
const round=v=>Math.round(v*100)/100;
try{
 let online=false;
 for(let i=0;i<150;i++){
  if(server.exitCode!==null)throw Error('Server exited: '+serverLog);
  try{if((await fetch(host+'/examples/webgl-vector-tiles-benchmark/index.html')).ok){online=true;break}}catch{}
  await sleep(150);
 }
 check(online,'Local benchmark server did not start: '+serverLog);
 browser=await chromium.launch({
  executablePath:process.env.M5_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless:true,
  args:software
   ?['--enable-webgl','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-background-networking']
   :['--enable-webgl','--disable-software-rasterizer','--disable-background-networking']
 });
 for(const count of [1,8,16,32]){
  for(let cycle=0;cycle<2;cycle++){
   const order=cycle%2===0?['stock','boost','boost','stock']:['boost','stock','stock','boost'];
   for(let phase=0;phase<order.length;phase++){
    const renderer=order[phase];
    const page=await browser.newPage({viewport:{width:1100,height:700},deviceScaleFactor:1});
    const pageErrors=[];
    page.on('pageerror',e=>pageErrors.push(String(e)));
    page.on('console',m=>{if(m.type()==='error')pageErrors.push('console: '+m.text())});
    await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
    try{
     await page.goto(host+'/examples/webgl-vector-tiles-benchmark/index.html?renderer='+renderer+'&count='+count,
       {waitUntil:'domcontentloaded',timeout:45000});
     await page.waitForFunction(()=>{
       const s=globalThis.__webglExampleBenchmark;
       return s?.ready===true||s?.errors?.length>0;
     },null,{timeout:40000});
     const initial=await page.evaluate(()=>{
      const s=globalThis.__webglExampleBenchmark,map=s.map,boost=map?.boost;
      const gl=boost?.backend?.gl;
      const ext=gl?.getExtension('WEBGL_debug_renderer_info');
      return {ready:s.ready,errors:s.errors,renderer:s.renderer,count:s.count,
       firstCompleteFrameMs:s.firstCompleteFrameMs,
       uniqueTileHashes:new Set(s.tiles.map(x=>x.sha256)).size,
       loadedCount:s.loadedCount,
       boostStatus:map?.getBoostStatus?.()??null,
       exclusive:boost?.exclusiveActive??false,
       workerEnabled:boost?.workerEnabled??false,
       programCache:boost?.backend?.programs?.size??null,
       glCalls:{...s.glCalls},
       reportedGpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null};
     });
     check(initial.ready&&initial.errors.length===0&&pageErrors.length===0,
       'Rendering did not complete: '+JSON.stringify({count,cycle,renderer,initial,pageErrors}));
     check(initial.uniqueTileHashes===count&&initial.loadedCount>=count&&
       initial.firstCompleteFrameMs>0,'Unfair or incomplete local source render: '+JSON.stringify(initial));
     if(renderer==='boost'){
      check(initial.boostStatus?.enabled&&initial.exclusive&&initial.programCache>0&&
       !initial.workerEnabled,'Boost silently fell back: '+JSON.stringify(initial));
      if(!software)check(/NVIDIA.*RTX 5060 Ti/i.test(initial.reportedGpu||''),
       'Missing physical RTX 5060 Ti '+initial.reportedGpu);
     }else{
      check(initial.boostStatus===null&&initial.programCache===null,'Stock accidentally instrumented as Boost');
     }
     const pan=await page.evaluate(()=>globalThis.__webglExampleBenchmark.runPan(24));
     check(Number.isFinite(pan.medianMs)&&Number.isFinite(pan.p95Ms)&&pan.count===24,
       'Missing pan samples '+JSON.stringify(pan));
     const stable=await page.evaluate(()=>{
      const s=globalThis.__webglExampleBenchmark,map=s.map,b=map?.boost;
      return {loadedCount:s.loadedCount,errors:s.errors,boostActive:b?.exclusiveActive??false,
        frameError:b?.snapshot?.().frameStats?.glError??0,
        glCalls:{...s.glCalls}};
     });
     check(stable.errors.length===0&&stable.frameError===0,
       'WebGL draw failed '+JSON.stringify(stable));
     const imageName='case-'+count+'-'+cycle+'-'+phase+'-'+renderer+'.png';
     const png=await page.locator('#map').screenshot({path:join(dir,imageName)});
     check(png.length>1000,'Empty screenshot '+imageName);
     const row={count,cycle,phase,renderer,...initial,pan,stable,screen:imageName,pageErrors};
     summary.measurements.push(row);
     console.log('R77_CASE_PASS',JSON.stringify({
       count,cycle,phase,renderer,firstMs:round(initial.firstCompleteFrameMs),
       panP50Ms:round(pan.medianMs),panP95Ms:round(pan.p95Ms),
       uniqueTiles:initial.uniqueTileHashes,programCreates:initial.glCalls.createProgram
     }));
    }finally{await page.close();}
   }
  }
 }
 for(const count of [1,8,16,32]){
  const group=summary.measurements.filter(x=>x.count===count);
  check(group.length===8,'Expected 8 ABBA samples per source count');
  const stock=group.filter(x=>x.renderer==='stock'),boost=group.filter(x=>x.renderer==='boost');
  check(stock.length===4&&boost.length===4,'Unbalanced ABBA sample count');
  const metric=r=>({
   firstCompletedMsMedian:round(median(r.map(x=>x.firstCompleteFrameMs))),
   firstCompletedMsMean:round(mean(r.map(x=>x.firstCompleteFrameMs))),
   panSubmitP50MsMedian:round(median(r.map(x=>x.pan.medianMs))),
   panSubmitP95MsMedian:round(median(r.map(x=>x.pan.p95Ms))),
   programCreatesMedian:round(median(r.map(x=>x.glCalls.createProgram))),
   shaderCreatesMedian:round(median(r.map(x=>x.glCalls.createShader))),
   programUseCallsMedian:round(median(r.map(x=>x.stable.glCalls.useProgram)))
  });
  const a=metric(stock),b=metric(boost);
  summary.aggregates.push({
   count,stock:a,boost:b,firstCompleteReductionPct:round(100*(1-b.firstCompletedMsMedian/a.firstCompletedMsMedian)),
   panSubmissionReductionPct:round(100*(1-b.panSubmitP50MsMedian/a.panSubmitP50MsMedian))
  });
 }
 summary.pass=summary.measurements.length===32&&summary.aggregates.length===4&&summary.errors.length===0;
}catch(error){summary.errors.push(String(error?.stack||error));console.error('R77_BENCHMARK_FAIL',summary.errors.at(-1));}
finally{
 await writeFile(join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
 const rows=[['count','cycle','phase','renderer','firstCompleteFrameMs','panSubmitMedianMs',
   'panSubmitP95Ms','createProgram','createShader','useProgram','drawElements','drawArrays','uniqueTileHashes'].join(',')];
 for(const x of summary.measurements)rows.push([
  x.count,x.cycle,x.phase,x.renderer,round(x.firstCompleteFrameMs),
  round(x.pan.medianMs),round(x.pan.p95Ms),x.glCalls.createProgram,x.glCalls.createShader,
  x.stable.glCalls.useProgram,x.stable.glCalls.drawElements,x.stable.glCalls.drawArrays,
  x.uniqueTileHashes
 ].join(','));
 await writeFile(join(dir,'samples.csv'),rows.join('\n')+'\n');
 try{await browser?.close()}catch{}
 if(server.exitCode===null){server.kill();await sleep(350)}
}
console.log('R77_BENCHMARK_SUMMARY',JSON.stringify({pass:summary.pass,cases:summary.measurements.length,
 mode:summary.mode,aggregates:summary.aggregates,errors:summary.errors}));
if(!summary.pass)process.exitCode=1;
