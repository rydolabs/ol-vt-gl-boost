/**
 * R80 pre-merge visual/cadence and soak gates for the unchanged R79 renderer.
 * 8/32-layer Stock OL and Boost are measured in isolated ABBA pages. CPU
 * submission timing alone is NOT accepted as evidence of display performance:
 * report requestAnimationFrame scheduling cadence, screenshot parity, and
 * post-measurement GL error. Requires real pixel output, not mocked layers.
 *
 * rAF measures JS scheduling, not scanout/presentation. performance.memory
 * reports JS heap only, never GPU VRAM. Physical NVIDIA testing is separate.
 */
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=resolve(process.argv[2]||'.');
const output=resolve(process.argv[3]||join(root,'artifacts/r80-merge-gates'));
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
const software=process.env.R80_ALLOW_SOFTWARE_GL==='1';
const durationMs=Math.max(3000,Math.min(30000,Number(process.env.R80_CASE_MS||7000)));
const soakMs=Math.max(20000,Math.min(180000,Number(process.env.R80_SOAK_MS||60000)));
const port=4195,origin='http://127.0.0.1:'+port;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const requireTrue=(v,msg)=>{if(!v)throw Error(msg)};
const avg=a=>a.reduce((x,y)=>x+y,0)/(a.length||1);
const pct=(values,p)=>{const a=[...values].sort((x,y)=>x-y);
  return a.length?a[Math.min(a.length-1,Math.max(0,Math.ceil(a.length*p)-1))]:null};
const median=values=>{const a=[...values].sort((x,y)=>x-y),n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):null};
const round=x=>x==null?null:Math.round(x*100)/100;
const result={schema:'r80-merge-visual-cadence-v1',sha:process.env.R80_CANDIDATE_SHA||null,
  gpuMode:software?'software-webgl':'physical-rtx',durationMs,soakMs,
  cases:[],comparisons:[],soak:null,errors:[],hardGates:[],performanceObservations:[],pass:false};
await mkdir(output,{recursive:true});
const server=spawn(process.execPath,[join(root,'examples/compare/serve.mjs')],{
  cwd:root,env:{...process.env,OLVT_EXAMPLE_PORT:String(port)},stdio:'pipe'
});
let textLog='',browser=null;
server.stdout.on('data',b=>textLog+=b.toString());
server.stderr.on('data',b=>textLog+=b.toString());
const loadImage=async(page,png)=>{
  const b64=png.toString('base64');
  return page.evaluate(async s=>{
    const im=new Image();im.src='data:image/png;base64,'+s;await im.decode();
    const canvas=document.createElement('canvas');
    canvas.width=im.naturalWidth;canvas.height=im.naturalHeight;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(im,0,0);
    return [...ctx.getImageData(0,0,canvas.width,canvas.height).data];
  },b64);
};
function pixelCompare(a,b){
  requireTrue(a.length===b.length,'Pixel arrays have unequal sizes');
  let differing=0,largerThan10=0,sum=0,max=0;
  for(let i=0;i<a.length;i+=4){
    let mismatch=false,big=false;
    for(let ch=0;ch<3;ch++){
      const v=Math.abs(a[i+ch]-b[i+ch]);sum+=v;max=Math.max(max,v);
      if(v) mismatch=true;if(v>10)big=true;
    }
    if(mismatch)differing++;if(big)largerThan10++;
  }
  const pixels=a.length/4;
  return {pixels,pixelDifferencePercent:round(100*differing/pixels),
    largePixelDifferencePercent:round(100*largerThan10/pixels),
    meanAbsChannel:round(sum/(pixels*3)),maxChannelDelta:max};
}
async function attach(page,renderer,count){
  const errors=[];
  page.on('pageerror',e=>errors.push('pageerror '+String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push('console '+m.text())});
  await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
  await page.goto(origin+'/examples/webgl-vector-tiles-benchmark/index.html?renderer='+renderer+'&count='+count,
    {waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForFunction(()=>{
    const x=globalThis.__webglExampleBenchmark;
    return x?.ready===true||x?.errors?.length>0;
  },null,{timeout:50000});
  const st=await page.evaluate(()=>{
    const x=globalThis.__webglExampleBenchmark,b=x.map?.boost;
    const gl=b?.backend?.gl,ext=gl?.getExtension('WEBGL_debug_renderer_info');
    return {ready:x.ready,errors:x.errors,loaded:x.loadedCount,
      exclusive:b?.exclusiveActive??false,
      policy:b?.backend?.glErrorCheckMode??null,
      glErrorChecked:b?.snapshot?.().frameStats?.glErrorChecked??null,
      glError:b?.snapshot?.().frameStats?.glError??null,
      programs:b?.backend?.programs?.size??null,
      tiles:b?.snapshot?.().tileCount??null,
      gpuName:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null};
  });
  requireTrue(st.ready&&st.errors.length===0&&st.loaded>=count&&errors.length===0,
    'Scene did not load '+JSON.stringify({renderer,count,st,errors}));
  if(renderer==='boost'){
    requireTrue(st.exclusive&&st.policy==='nonblocking'&&st.glErrorChecked===false
      &&st.glError===null&&st.tiles>=count,'Boost silent fallback or incorrect GL policy '+JSON.stringify(st));
    if(!software)requireTrue(/NVIDIA.*RTX 5060 Ti/i.test(st.gpuName||''),
      'Not physical NVIDIA RTX 5060 Ti '+st.gpuName);
  }
  return {errors,st};
}
async function measure(page,milliseconds){
  return page.evaluate(async milliseconds=>{
    const s=globalThis.__webglExampleBenchmark,map=s.map,view=s.view,
      orig=[...view.getCenter()],b=map.boost;
    const startFrames=b?.scene?.frames??null, beforeTiles=b?.snapshot?.().tileCount??null;
    const startHeap=performance.memory?.usedJSHeapSize??null;
    const raf=[],submit=[],frames=[];
    let previous=null,started=performance.now(),n=0,lastDrawPackets=null;
    let errors0=s.errors.length;
    while(performance.now()-started<milliseconds){
      const time=await new Promise(r=>requestAnimationFrame(r));
      if(previous!==null)raf.push(time-previous);
      previous=time;
      // Travel 8px in both directions, then return. No new sources required.
      view.setCenter([orig[0]+(n%3===0?512:(n%3===1?-512:0)),orig[1]]);
      const t=performance.now();
      map.renderSync();
      submit.push(performance.now()-t);
      n++;
      if(b&&n%45===0){
        const snap=b.snapshot();frames.push({iteration:n,tiles:snap.tileCount,
          drawPackets:snap.drawPackets,programs:b.backend.programs.size,
          checked:snap.frameStats?.glErrorChecked??null});
        lastDrawPackets=snap.drawPackets;
      }
    }
    view.setCenter(orig);map.renderSync();
    const heap=performance.memory?.usedJSHeapSize??null;
    const after=b?.snapshot?.()??null;
    const q=a=>{const x=[...a].sort((a,b)=>a-b),n=x.length;
      if(!n)return null;return x[Math.min(n-1,Math.max(0,Math.ceil(n*0.95)-1))]};
    const half=a=>{const x=[...a].sort((a,b)=>a-b),n=x.length;
      return n?(n%2?x[(n-1)/2]:(x[n/2-1]+x[n/2])/2):null};
    const mean=a=>a.reduce((x,y)=>x+y,0)/(a.length||1);
    // This is a post-measurement diagnostic. It may block and drain the
    // software renderer; its elapsed time is reported separately.
    const t=performance.now(),diagnostic=b?.backend?.checkGlError?.()??null;
    const diagnosticMs=performance.now()-t;
    return {elapsedMs:performance.now()-started,iterations:n,
      raf:{n:raf.length,meanMs:mean(raf),p50Ms:half(raf),p95Ms:q(raf),
        maxMs:Math.max(0,...raf),estimatedRafHz:1000/mean(raf)},
      submission:{n:submit.length,meanMs:mean(submit),p50Ms:half(submit),p95Ms:q(submit)},
      scene:{framesRendered:b?.scene?.frames-startFrames??null,
        tilesBefore:beforeTiles,tilesAfter:after?.tileCount??null,
        glErrorChecked:after?.frameStats?.glErrorChecked??null,
        glError:after?.frameStats?.glError??null,programs:b?.backend?.programs?.size??null,
        samples:frames,lastDrawPackets},
      jsHeap:{beforeBytes:startHeap,afterBytes:heap,deltaBytes:
        startHeap!==null&&heap!==null?heap-startHeap:null},
      postDiagnostic:{error:diagnostic,elapsedMs:diagnosticMs},
      errors:s.errors.slice(errors0)};
  },milliseconds);
}
try{
  let up=false;
  for(let i=0;i<160;i++){
    if(server.exitCode!==null)throw Error('Server failed '+textLog);
    try{if((await fetch(origin+'/examples/webgl-vector-tiles-benchmark/index.html')).ok){up=true;break}}catch{}
    await wait(150);
  }
  requireTrue(up,'Local server unavailable '+textLog);
  browser=await chromium.launch({executablePath:process.env.M5_BROWSER||
    'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,
    args:software?['--enable-webgl','--enable-unsafe-swiftshader','--use-angle=swiftshader',
      '--enable-precise-memory-info','--disable-background-networking']:
      ['--enable-webgl','--disable-software-rasterizer','--enable-precise-memory-info','--disable-background-networking']});
  // One ABBA cycle at each tier. The two repetitions of each renderer control
  // for shared host cache and thermal/driver changes.
  for(const count of [8,32]){
    const order=['stock','boost','boost','stock'];
    for(let phase=0;phase<order.length;phase++){
      const renderer=order[phase],page=await browser.newPage({
        viewport:{width:1100,height:700},deviceScaleFactor:1});
      try{
        const {st,errors}=await attach(page,renderer,count);
        const before=await page.locator('#map').screenshot();
        const metrics=await measure(page,durationMs);
        // Software SwiftShader may schedule only ~2 Hz at 32 sources.
        // Record the actual degradation rather than discarding that case.
        requireTrue(metrics.iterations>=5&&metrics.raf.n>=4,
          'Insufficient rAF observations '+JSON.stringify({renderer,count,metrics}));
        requireTrue(metrics.errors.length===0&&errors.length===0,
          'Browser error in pan '+JSON.stringify({renderer,count,metrics:metrics.errors,errors}));
        if(renderer==='boost'){
          requireTrue(metrics.scene.tilesAfter>=count&&metrics.scene.programs>0&&
           metrics.scene.framesRendered>=metrics.iterations,
           'Boost did not render every requested pan '+JSON.stringify(metrics.scene));
          requireTrue(metrics.scene.glErrorChecked===false&&metrics.scene.glError===null&&
           metrics.postDiagnostic.error===0,
           'Incorrect nonblocking GL diagnostic '+JSON.stringify(metrics.scene));
        }
        await page.evaluate(()=>{
          const s=globalThis.__webglExampleBenchmark,view=s.view;
          view.setCenter([view.getCenter()[0]+512,view.getCenter()[1]]);
          s.map.renderSync();
        });
        const after=await page.locator('#map').screenshot();
        const tag=count+'-'+phase+'-'+renderer;
        await writeFile(join(output,'before-'+tag+'.png'),before);
        await writeFile(join(output,'after-'+tag+'.png'),after);
        const beforePx=await loadImage(page,before),afterPx=await loadImage(page,after);
        const motion=pixelCompare(beforePx,afterPx);
        requireTrue(motion.pixelDifferencePercent>0.01,
          'Pan did not change pixels '+JSON.stringify({tag,motion}));
        result.cases.push({count,phase,renderer,st,metrics,motion,
          before:'before-'+tag+'.png',after:'after-'+tag+'.png'});
        console.log('R80_CADENCE_CASE_PASS',JSON.stringify({count,phase,renderer,
          rafHz:round(metrics.raf.estimatedRafHz),
          rafP95:round(metrics.raf.p95Ms),cpuSubmit:round(metrics.submission.p50Ms),
          diagnostic:round(metrics.postDiagnostic.elapsedMs),
          motionPercent:motion.pixelDifferencePercent,
          heapDeltaBytes:metrics.jsHeap.deltaBytes}));
      }finally{await page.close();}
    }
    // Decode actual screenshots into pixel arrays and compare the same
    // map state across Stock OL and Boost for both ABBA repetitions.
    const cases=result.cases.filter(c=>c.count===count);
    const pictures=new Map();
    const decoder=await browser.newPage();
    try{
      for(const c of cases){
        const buf=await import('node:fs/promises').then(fs=>fs.readFile(join(output,c.after)));
        pictures.set(c.phase,await loadImage(decoder,buf));
      }
    }finally{await decoder.close();}
    for(const [stockPhase,boostPhase] of [[0,1],[3,2]]){
      const comparison=pixelCompare(pictures.get(stockPhase),pictures.get(boostPhase));
      result.comparisons.push({count,stockPhase,boostPhase,...comparison});
      requireTrue(comparison.pixelDifferencePercent<=8&&comparison.meanAbsChannel<=0.75,
        'Stock OL and Boost visual parity threshold failed '+JSON.stringify(comparison));
      console.log('R80_STOCK_BOOST_PIXEL_PARITY_PASS',JSON.stringify({count,...comparison}));
    }
    const stock=cases.filter(c=>c.renderer==='stock'),
      boosted=cases.filter(c=>c.renderer==='boost');
    const p95Stock=median(stock.map(c=>c.metrics.raf.p95Ms)),
      p95Boost=median(boosted.map(c=>c.metrics.raf.p95Ms));
    const perf={count,stockRafP95Ms:round(p95Stock),boostRafP95Ms:round(p95Boost),
      boostSchedulingRegression:p95Boost>p95Stock*1.5+8,
      stockMeanRafHz:round(avg(stock.map(c=>c.metrics.raf.estimatedRafHz))),
      boostMeanRafHz:round(avg(boosted.map(c=>c.metrics.raf.estimatedRafHz)))};
    result.performanceObservations.push(perf);
    console.log('R80_RAF_COMPARISON_OBSERVATION',JSON.stringify(perf));
  }
  // Dedicated longer continuous Boost soak. No stock comparator in this
  // segment. Require stable GL error policy and fresh onscreen geometry.
  const page=await browser.newPage({viewport:{width:1100,height:700},deviceScaleFactor:1});
  try{
    const {st,errors}=await attach(page,'boost',32);
    const metrics=await measure(page,soakMs);
    requireTrue(metrics.iterations>=75&&metrics.errors.length===0&&errors.length===0,
      'Continuous pan soak failed '+JSON.stringify({st,metrics,errors}));
    requireTrue(metrics.scene.tilesAfter>=32&&metrics.scene.framesRendered>=metrics.iterations&&
      metrics.postDiagnostic.error===0,'Continuous GL stability gate failed '+JSON.stringify(metrics.scene));
    // Do not call this GPU VRAM verification; it is JS-heap-only.
    const heapDelta=metrics.jsHeap.deltaBytes;
    requireTrue(heapDelta===null||heapDelta<256*1024*1024,
      'Catastrophic JS heap growth '+heapDelta);
    result.soak={renderer:'boost',count:32,metrics,status:st};
    console.log('R80_SOFTWARE_WEBGL_SOAK_PASS',JSON.stringify({
      seconds:round(metrics.elapsedMs/1000),frames:metrics.iterations,
      rafHz:round(metrics.raf.estimatedRafHz),rafP95:round(metrics.raf.p95Ms),
      jsHeapDeltaBytes:heapDelta,postGLDiagnostic:metrics.postDiagnostic
    }));
  }finally{await page.close()}
  result.pass=result.cases.length===8&&result.comparisons.length===4&&
    result.soak?.metrics?.iterations>=75&&result.errors.length===0;
}catch(e){
  result.errors.push(String(e?.stack||e));
  console.error('R80_MERGE_GATE_FAILED',result.errors.at(-1));
}finally{
  await writeFile(join(output,'summary.json'),JSON.stringify(result,null,2)+'\n');
  try{await browser?.close()}catch{}
  if(server.exitCode===null){server.kill();await wait(300)}
}
console.log('R80_MERGE_GATE_SUMMARY',JSON.stringify({
  pass:result.pass,cases:result.cases.length,comparisons:result.comparisons,
  perf:result.performanceObservations,soakFrames:result.soak?.metrics.iterations??0,
  errors:result.errors
}));
if(!result.pass)process.exitCode=1;
