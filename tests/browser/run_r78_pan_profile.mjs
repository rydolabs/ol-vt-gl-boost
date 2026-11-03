/**
 * R78 diagnostic ONLY. Instrument precisely where a warm BoostMap frame
 * spends main-thread time. Uses the R77 local MVT example unchanged.
 * This is NOT a renderer patch or a release benchmark.
 *
 * Temporary noFbo/noGetError/noDraw variants deliberately relax output
 * fidelity/validation to isolate costs. Never ship them as optimizations.
 */
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]||'.');
const out=resolve(process.argv[3]||join(root,'artifacts/r78-profile'));
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
const software=process.env.R78_ALLOW_SOFTWARE_GL==='1',port=4191;
const base='http://127.0.0.1:'+port;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const median=a=>{const b=[...a].sort((x,y)=>x-y),n=b.length;return n? (n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2):0;};
const mean=a=>a.reduce((s,x)=>s+x,0)/(a.length||1);
const rnd=x=>Math.round(x*100)/100;
await mkdir(out,{recursive:true});
const summary={schema:'r78-profile-v1',sha:process.env.R78_CANDIDATE_SHA||null,mode:software?'software-webgl':'physical-gpu',
 cases:[],errors:[],pass:false};
const server=spawn(process.execPath,[join(root,'examples/compare/serve.mjs')],{cwd:root,env:{...process.env,OLVT_EXAMPLE_PORT:String(port)},stdio:'pipe'});
let serverText='',browser;
server.stdout.on('data',b=>serverText+=b.toString());
server.stderr.on('data',b=>serverText+=b.toString());
try{
 let live=false;
 for(let i=0;i<150;i++){
  if(server.exitCode!==null)throw Error('Server exit '+serverText);
  try{if((await fetch(base+'/examples/webgl-vector-tiles-benchmark/index.html')).ok){live=true;break}}catch{}
  await sleep(150);
 }
 if(!live)throw Error('Server unavailable '+serverText);
 browser=await chromium.launch({
  executablePath:process.env.M5_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless:true,args:software?
   ['--enable-webgl','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-background-networking']:
   ['--enable-webgl','--disable-software-rasterizer','--disable-background-networking']});
 for(const count of [8,32]){
  const page=await browser.newPage({viewport:{width:1100,height:700},deviceScaleFactor:1});
  const pageErrors=[];
  page.on('pageerror',e=>pageErrors.push(String(e)));
  try{
   await page.goto(base+'/examples/webgl-vector-tiles-benchmark/index.html?renderer=boost&count='+count,{
    waitUntil:'domcontentloaded',timeout:45000
   });
   await page.waitForFunction(()=>globalThis.__webglExampleBenchmark?.ready ||
     globalThis.__webglExampleBenchmark?.errors?.length,null,{timeout:60000});
   const data=await page.evaluate(async()=>{
    const rnd=x=>Math.round(x*100)/100;
    const median=a=>{const b=[...a].sort((x,y)=>x-y),n=b.length;return n?(n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2):0;};
    const mean=a=>a.reduce((v,x)=>v+x,0)/(a.length||1);
    const s=globalThis.__webglExampleBenchmark;
    if(!s.ready||s.errors.length)throw Error('Scene not ready '+JSON.stringify(s.errors));
    const map=s.map,boost=map.boost,scene=boost.scene,backend=boost.backend,pipeline=scene.bridge.pipeline;
    const diag={frames:[],current:null,phase:'',callErrors:[]};
    globalThis.__r78diag=diag;
    const originals=[];
    const track=(object,key,label)=>{
      const original=object[key];
      if(typeof original!=='function')throw Error('Cannot instrument '+label);
      const wrapped=function(...args){
       const started=performance.now();
       try{return original.apply(this,args)}
       finally{
        if(diag.current){
         const stat=diag.current[label]??(diag.current[label]={calls:0,ms:0});
         stat.calls++;stat.ms+=performance.now()-started;
        }
       }
      };
      object[key]=wrapped;
      originals.push(()=>{object[key]=original});
    };
    track(scene,'renderFrame','sceneRender');
    track(scene,'buildSchedule','buildSchedule');
    track(scene,'canSkipDisjointLayerFbo','fboCheck');
    track(scene,'_renderCompositedLayers','fboComposition');
    track(pipeline,'draw','pipelineDraw');
    track(backend,'beginFrame','beginFrame');
    track(backend,'endFrame','endFrame');
    for(const state of scene.layers.values())track(state.pruner,'sync','prune');
    if(boost.exclusiveHost)track(boost.exclusiveHost,'prime','prime');
    const gl=backend.gl,proto=WebGLRenderingContext.prototype;
    for(const [key,name] of [['flush','glFlush'],['getError','glGetError'],['drawElements','glDrawElements'],
      ['scissor','glScissor']]){
      track(proto,key,name);
    }
    const ext=backend.ext;if(ext)track(ext,'drawElementsInstancedANGLE','glInstancedDraw');
    const originalRender=map.renderSync;
    map.renderSync=function(...args){
      const record={phase:diag.phase,sceneFramesBefore:scene.frames,
       scheduleCacheBefore:scene.scheduleCacheHits,
       scheduleBuildsBefore:scene.scheduleBuilds};
      diag.current=record;
      const start=performance.now();
      try{return originalRender.apply(this,args)}
      finally{
       record.totalMs=performance.now()-start;
       record.sceneFrames=scene.frames-record.sceneFramesBefore;
       record.scheduleCacheHits=scene.scheduleCacheHits-record.scheduleCacheBefore;
       record.scheduleBuilds=scene.scheduleBuilds-record.scheduleBuildsBefore;
       record.drawPackets=scene.lastSchedule.length;
       record.stats={...scene.lastFrameStats};
       record.fboBypass=scene.lastFrameStats?.layerFboBypassed??null;
       delete record.sceneFramesBefore;
       delete record.scheduleCacheBefore;
       delete record.scheduleBuildsBefore;
       diag.frames.push(record);
       diag.current=null;
      }
    };
    originals.push(()=>map.renderSync=originalRender);
    const originalCache=scene.cacheSceneSchedule,originalFbo=scene.vectorTileOptions.olLayerFboComposition;
    const originalDraw=pipeline.draw,originalGetError=proto.getError;
    const phases=['baselineA','cacheSchedule','withoutFbo','skipGlGetError','skipPipelineDraw','baselineB'];
    const outputs=[];
    const runPhase=async(name)=>{
      diag.phase=name;
      scene.cacheSceneSchedule=name==='cacheSchedule';
      scene._scheduleDirty=true;
      scene._cachedSchedule=null;
      scene.vectorTileOptions.olLayerFboComposition=name!=='withoutFbo';
      pipeline.draw=name==='skipPipelineDraw'?()=>{}:originalDraw;
      if(name==='skipGlGetError')proto.getError=function(){return this.NO_ERROR};
      else proto.getError=originalGetError;
      const start=diag.frames.length;
      const pan=await s.runPan(12);
      const values=diag.frames.slice(start);
      const stat=key=>({calls:values.reduce((n,v)=>n+(v[key]?.calls||0),0),
       meanPerFrameMs:rnd(mean(values.map(v=>v[key]?.ms||0))),
       medianPerFrameMs:rnd(median(values.map(v=>v[key]?.ms||0)))});
      const measured=values.filter(x=>x.sceneFrames>0);
      outputs.push({
       name,pan,sampleFrames:values.length,renderedFrames:measured.length,
       totalMsMedian:rnd(median(values.map(v=>v.totalMs))),
       totalMsMean:rnd(mean(values.map(v=>v.totalMs))),
       scheduleBuilds:values.reduce((n,v)=>n+v.scheduleBuilds,0),
       scheduleCacheHits:values.reduce((n,v)=>n+v.scheduleCacheHits,0),
       fboBypassed:values.map(v=>v.fboBypass),
       packetsMedian:rnd(median(values.map(v=>v.drawPackets))),
       lastFrameStats:values.at(-1)?.stats,
       stages:Object.fromEntries(['sceneRender','buildSchedule','fboCheck','fboComposition','prune',
        'pipelineDraw','beginFrame','endFrame','glFlush','glGetError',
        'glDrawElements','glInstancedDraw','glScissor','prime'].map(k=>[k,stat(k)]))
      });
      await new Promise(r=>setTimeout(r,60));
    };
    for(const phase of phases)await runPhase(phase);
    pipeline.draw=originalDraw;proto.getError=originalGetError;
    scene.cacheSceneSchedule=originalCache;
    scene.vectorTileOptions.olLayerFboComposition=originalFbo;
    scene._scheduleDirty=true;scene._cachedSchedule=null;
    map.renderSync=originalRender;
    for(const undo of originals.reverse())try{undo()}catch{}
    return {renderer:map.boost?.backend?.gl?.getParameter?.(
      backend.gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL)||null,
      count:s.count,tiles:boost.snapshot().tileCount,phaseResults:outputs,errors:s.errors};
   });
   if(data.errors.length||data.tiles<count||data.phaseResults.length!==6||pageErrors.length)
    throw Error('Incomplete profile '+JSON.stringify({data,pageErrors}));
   summary.cases.push(data);
   for(const phase of data.phaseResults)console.log('R78_PROFILE_PHASE',JSON.stringify({
    count,phase:phase.name,totalMs:phase.totalMsMedian,drawMs:phase.stages.pipelineDraw.medianPerFrameMs,
    fboMs:phase.stages.fboComposition.medianPerFrameMs,errMs:phase.stages.glGetError.medianPerFrameMs,
    instancedMs:phase.stages.glInstancedDraw.medianPerFrameMs,instancedCalls:phase.stages.glInstancedDraw.calls,
    buildMs:phase.stages.buildSchedule.medianPerFrameMs,
    bypass:phase.fboBypassed.at(-1),scheduleCacheHits:phase.scheduleCacheHits}));
  }finally{await page.close();}
 }
 summary.pass=summary.cases.length===2&&summary.errors.length===0;
}catch(error){
 summary.errors.push(String(error?.stack||error));
 console.error('R78_PROFILE_FAILED',summary.errors.at(-1));
}finally{
 await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
 try{await browser?.close()}catch{}
 if(server.exitCode===null){server.kill();await sleep(350)}
}
console.log('R78_PROFILE_SUMMARY',JSON.stringify({
 pass:summary.pass,cases:summary.cases.length,errors:summary.errors}));
if(!summary.pass)process.exitCode=1;
