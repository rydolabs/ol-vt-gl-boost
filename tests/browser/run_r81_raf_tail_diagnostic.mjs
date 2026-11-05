/**
 * R81 root-cause diagnosis for R80 two-run p95 aggregation artifact.
 * Record every rAF timestamp, JS CPU submitted-time, long task, and event
 * loop heartbeat during repeated 32-source real OpenLayers/Boost panning.
 *
 * Note: rAF = animation callback cadence, NOT GPU presentation/FPS; Chrome
 * SwiftShader software GL != physical RTX. No renderer implementation changes.
 */
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=resolve(process.argv[2]||'.'),
 dest=resolve(process.argv[3]||join(root,'artifacts/r81-raf-tail'));
const durationMs=Math.max(12000,Math.min(60000,Number(process.env.R81_CASE_MS||30000)));
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
const software=process.env.R81_ALLOW_SOFTWARE_GL==='1';
const result={schema:'r81-raf-jitter-v1',sha:process.env.R81_CANDIDATE_SHA??null,
  gpu:software?'software-webgl':'physical-rtx',durationMs,cases:[],
  aggregate:[],errors:[],pass:false};
await mkdir(dest,{recursive:true});
const round=n=>n==null?null:Math.round(n*100)/100;
const sum=x=>x.reduce((a,b)=>a+b,0);
const avg=x=>sum(x)/(x.length||1);
const sort=x=>[...x].sort((a,b)=>a-b);
const quant=(values,p)=>{
  const a=sort(values);return a.length?a[Math.max(0,Math.min(a.length-1,Math.ceil(a.length*p)-1))]:null;
};
const med=x=>{const a=sort(x),n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):null};
const fail=(ok,message)=>{if(!ok)throw Error(message)};
const port=4197,origin='http://127.0.0.1:'+port;
const server=spawn(process.execPath,[join(root,'examples/compare/serve.mjs')],{
 cwd:root,env:{...process.env,OLVT_EXAMPLE_PORT:String(port)},stdio:'pipe'});
let serverLog='',browser=null;
server.stderr.on('data',x=>serverLog+=String(x));
server.stdout.on('data',x=>serverLog+=String(x));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

try{
 let serverReady=false;
 for(let i=0;i<160;i++){
  if(server.exitCode!==null)throw Error('Server exited '+serverLog);
  try{
    if((await fetch(origin+'/examples/webgl-vector-tiles-benchmark/index.html')).ok){
      serverReady=true;break;
    }
  }catch{}
  await sleep(150);
 }
 fail(serverReady,'Server unavailable '+serverLog);
 browser=await chromium.launch({
  executablePath:process.env.M5_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless:true,
  args:software?['--enable-webgl','--enable-unsafe-swiftshader','--use-angle=swiftshader',
    '--enable-precise-memory-info','--disable-background-networking']:
    ['--enable-webgl','--disable-software-rasterizer','--enable-precise-memory-info','--disable-background-networking']
 });
 for(const [run,mode] of ['stock','boost','boost','stock'].entries()){
  const page=await browser.newPage({viewport:{width:1100,height:700},deviceScaleFactor:1});
  const browserErrors=[];
  page.on('pageerror',e=>browserErrors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')browserErrors.push(m.text())});
  await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
  try{
    await page.goto(origin+'/examples/webgl-vector-tiles-benchmark/index.html?renderer='+mode+'&count=32',
      {waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>{
      const s=window.__webglExampleBenchmark;
      return s?.ready||s?.errors?.length;
    },null,{timeout:65000});
    const start=await page.evaluate(()=>{
      const s=window.__webglExampleBenchmark,b=s.map?.boost;
      return {ready:s.ready,errors:s.errors,tileLoaded:s.loadedCount,
        boostActive:b?.exclusiveActive??null,frames:b?.scene?.frames??null,
        policy:b?.backend?.glErrorCheckMode??null,
        initialTiles:b?.snapshot()?.tileCount??null};
    });
    fail(start.ready&&!start.errors.length&&start.tileLoaded>=32&&
      (mode==='stock'||(start.boostActive&&start.policy==='nonblocking'&&start.initialTiles>=32)),
      'Bootstrapping or Boost fallback: '+JSON.stringify({run,mode,start}));

    const sample=await page.evaluate(async milliseconds=>{
      const st=window.__webglExampleBenchmark,map=st.map,view=st.view,b=map.boost;
      const beforeErrors=st.errors.length,startFrames=b?.scene?.frames??null,
        sourceTiles=b?.snapshot()?.tileCount??null;
      const perfOrigin=performance.now(),center=[...view.getCenter()];
      const frames=[],heartbeat=[],longTasks=[];
      const observer=new PerformanceObserver(list=>{
        for(const entry of list.getEntries())
          longTasks.push({t:entry.startTime-perfOrigin,duration:entry.duration,
            name:entry.name});
      });
      let observerSupported=true;
      try{observer.observe({type:'longtask',buffered:false})}
      catch{observerSupported=false}
      let tickExpected=performance.now()+50;
      const timer=setInterval(()=>{
        const actual=performance.now();
        heartbeat.push({t:actual-perfOrigin,delayMs:Math.max(0,actual-tickExpected)});
        tickExpected=actual+50;
      },50);
      let prevStamp=null,index=0;
      while(performance.now()-perfOrigin<milliseconds){
        const stamp=await new Promise(resolve=>requestAnimationFrame(resolve));
        const t0=performance.now();
        view.setCenter([center[0]+(index%3===0?512:index%3===1?-512:0),center[1]]);
        const t1=performance.now();
        map.renderSync();
        const t2=performance.now();
        frames.push({i:index,
          callbackTimestamp:stamp-perfOrigin,
          callbackEntry:t0-perfOrigin,
          sincePreviousMs:prevStamp===null?null:stamp-prevStamp,
          setCenterMs:t1-t0,renderSyncMs:t2-t1,
          callbackTimestampLagMs:t0-stamp,
          boostFrames:b?.scene?.frames??null});
        prevStamp=stamp;index++;
      }
      clearInterval(timer);
      observer.disconnect();
      view.setCenter(center);
      map.renderSync();
      const diagStart=performance.now();
      const glError=b?.backend?.checkGlError?.()??null;
      const diagMs=performance.now()-diagStart;
      return {
        frames,heartbeat,longTasks,observerSupported,loopMs:performance.now()-perfOrigin,
        loadCount:st.loadedCount,sceneDelta:b?b.scene.frames-startFrames:null,
        tilesBefore:sourceTiles,tilesAfter:b?.snapshot()?.tileCount??null,
        glError,diagMs,errors:st.errors.slice(beforeErrors),
        jsHeapBytes:performance.memory?.usedJSHeapSize??null,
        gpuName:(()=>{
          const gl=b?.backend?.gl,ext=gl?.getExtension('WEBGL_debug_renderer_info');
          return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null;
        })()
      };
    },durationMs);
    fail(browserErrors.length===0&&sample.errors.length===0,'browser errors '+JSON.stringify({run,browserErrors,errors:sample.errors}));
    fail(sample.frames.length>=10&&sample.frames[0].sincePreviousMs===null,
      'Missing actual frame intervals '+JSON.stringify({run,n:sample.frames.length}));
    fail(mode==='stock'||(sample.sceneDelta>=sample.frames.length &&
       sample.tilesAfter>=32&&sample.glError===0),'Boost pan invalid '+JSON.stringify({run,sceneDelta:sample.sceneDelta,tiles:sample.tilesAfter,glError:sample.glError}));
    if(!software&&mode==='boost')fail(/NVIDIA.*RTX 5060 Ti/.test(sample.gpuName||''),
      'Not physical NVIDIA RTX 5060 Ti: '+sample.gpuName);
    const d=sample.frames.slice(1).map(f=>f.sincePreviousMs),
      sub=sample.frames.map(f=>f.renderSyncMs),
      vCenter=sample.frames.map(f=>f.setCenterMs),
      beat=sample.heartbeat.map(f=>f.delayMs);
    const stable=med(d),spikes=sample.frames.filter(f=>f.sincePreviousMs>1.65*stable);
    const longTaskSpikes=spikes.map(f=>{
      const t=f.callbackTimestamp;
      const previous=t-f.sincePreviousMs;
      const list=sample.longTasks.filter(z=>z.t+z.duration>=previous&&z.t<=t);
      return {i:f.i,t:round(t),intervalMs:round(f.sincePreviousMs),
        tasks:list.map(z=>({t:round(z.t),duration:round(z.duration)}))};
    });
    const summary={
      run,mode,loaded:sample.loadCount,frames:sample.frames.length,intervals:d.length,
      wallMs:round(sample.loopMs),medianMs:round(stable),p90Ms:round(quant(d,.9)),
      p95Ms:round(quant(d,.95)),p99Ms:round(quant(d,.99)),maxMs:round(Math.max(...d)),
      meanMs:round(avg(d)),callbackHz:round(1000/avg(d)),
      cpuSubmissionMedianMs:round(med(sub)),cpuSubmissionP95Ms:round(quant(sub,.95)),
      setCenterMedianMs:round(med(vCenter)),heartbeatP95DelayMs:round(quant(beat,.95)),
      heartbeatMaxDelayMs:round(Math.max(0,...beat)),
      longTasks:sample.longTasks.length,longTaskMs:round(sum(sample.longTasks.map(x=>x.duration))),
      skippedCadences:spikes.length,skipEvents:longTaskSpikes,
      observerSupported:sample.observerSupported,sceneDelta:sample.sceneDelta,
      tilesAfter:sample.tilesAfter,explicitError:sample.glError,
      explicitErrorWaitMs:round(sample.diagMs)
    };
    result.cases.push({summary,raw:sample});
    console.log('R81_CASE_COMPLETE',JSON.stringify(summary));
  }finally{await page.close()}
 }
 for(const mode of ['stock','boost']){
  const cases=result.cases.filter(x=>x.summary.mode===mode);
  fail(cases.length===2,'Must have two isolated runs '+mode);
  const intervals=cases.flatMap(c=>c.raw.frames.slice(1).map(f=>f.sincePreviousMs));
  const withoutSpikes=intervals.filter(x=>x<=med(intervals)*1.65);
  result.aggregate.push({mode,n:intervals.length,
    pooledP50Ms:round(med(intervals)),pooledP95Ms:round(quant(intervals,.95)),
    pooledP99Ms:round(quant(intervals,.99)),
    pooledMeanMs:round(avg(intervals)),
    pooledMaxMs:round(Math.max(...intervals)),
    skippedCadenceCount:intervals.filter(x=>x>med(intervals)*1.65).length,
    nonSkippedP95Ms:round(quant(withoutSpikes,.95)),
    avgJsSubmissionMs:round(avg(cases.flatMap(c=>c.raw.frames.map(f=>f.renderSyncMs)))),
    totalLongTaskCount:sum(cases.map(c=>c.summary.longTasks)),
    eventLoopDelayP95Ms:round(quant(cases.flatMap(c=>c.raw.heartbeat.map(f=>f.delayMs)),.95))
  });
 }
 result.pass=result.cases.length===4&&result.aggregate.length===2&&result.errors.length===0;
}catch(e){result.errors.push(String(e?.stack||e));console.error('R81_DIAG_FAILURE',result.errors.at(-1))}
finally{
 await writeFile(join(dest,'summary.json'),JSON.stringify(result,null,2)+'\n');
 const rows=[['mode','run','frame','rAF_gap_ms','callback_entry_ms','renderSync_ms','setCenter_ms','raf_timestamp_lag_ms'].join(',')];
 for(const c of result.cases)for(const f of c.raw.frames)
  rows.push([c.summary.mode,c.summary.run,f.i,f.sincePreviousMs??'',f.callbackEntry,f.renderSyncMs,f.setCenterMs,f.callbackTimestampLagMs].join(','));
 await writeFile(join(dest,'raw-frames.csv'),rows.join('\n')+'\n');
 try{await browser?.close()}catch{}
 if(server.exitCode===null){server.kill();await sleep(250)}
}
console.log('R81_DIAG_SUMMARY',JSON.stringify({
 pass:result.pass,aggregates:result.aggregate,errors:result.errors
}));
if(!result.pass)process.exitCode=1;
