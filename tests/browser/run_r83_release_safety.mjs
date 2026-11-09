/** R83 release safety: observe actual OL renderer restoration with SwiftShader or RTX.
 * Reproduces non-context-loss GL failure and live tree/style invalidation.
 * This does not establish broad visual parity or physical monitor FPS.
 */
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.argv[2]||'.');
const dest=resolve(process.argv[3]||join(root,'artifacts/r83-safety'));
const software=process.env.R83_ALLOW_SOFTWARE_GL==='1',port=4239,origin='http://127.0.0.1:'+port;
const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href);
const result={schema:'r83-browser-release-safety-v1',sourceSha:process.env.R83_CANDIDATE_SHA||null,
 gpu:software?'swiftshader':'physical-rtx',cases:[],errors:[],pass:false};
await mkdir(dest,{recursive:true});
const nap=ms=>new Promise(r=>setTimeout(r,ms));
const requireTrue=(ok,m)=>{if(!ok)throw Error(m)};
const server=spawn(process.execPath,[join(root,'examples/compare/serve.mjs')],{
 cwd:root,env:{...process.env,OLVT_EXAMPLE_PORT:String(port)},stdio:'pipe'});
let serverOutput='',browser;
server.stdout.on('data',b=>serverOutput+=String(b));
server.stderr.on('data',b=>serverOutput+=String(b));
try{
 let up=false;
 for(let i=0;i<180;i++){
  if(server.exitCode!==null)throw Error('server terminated: '+serverOutput);
  try{if((await fetch(origin+'/examples/webgl-vector-tiles-benchmark/index.html')).ok){up=true;break}}catch{}
  await nap(150);
 }
 requireTrue(up,'server did not start '+serverOutput);
 browser=await chromium.launch({
  executablePath:process.env.M5_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless:true,args:software?
   ['--enable-webgl','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-background-networking']:
   ['--enable-webgl','--disable-software-rasterizer','--disable-background-networking']
 });
 const cases=['strict-noncontext-error','mixed-raster-layer','supported-vector-added',
   'style-variables-same-ref','unsupported-style-same-ref'];
 for(const [index,kind] of cases.entries()){
  const page=await browser.newPage({viewport:{width:1100,height:700},deviceScaleFactor:1});
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(String(error)));
  page.on('console',msg=>{if(msg.type()==='error')pageErrors.push('console: '+msg.text())});
  await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
  try{
   await page.goto(origin+'/examples/webgl-vector-tiles-benchmark/index.html?renderer=boost&count=8&check=strict',
    {waitUntil:'domcontentloaded',timeout:60000});
   await page.waitForFunction(()=>{
    const s=window.__webglExampleBenchmark;
    return s?.ready||s?.errors?.length;
   },null,{timeout:70000});
   const start=await page.evaluate(()=>{
    const s=window.__webglExampleBenchmark,b=s.map?.boost;
    const g=b?.backend?.gl,ext=g?.getExtension('WEBGL_debug_renderer_info');
    return {ready:s.ready,errors:s.errors,loaded:s.loadedCount,tiles:b?.snapshot?.().tileCount,
      exclusive:b?.exclusiveActive,policy:b?.backend?.glErrorCheckMode,
      glErrorChecked:b?.snapshot?.().frameStats?.glErrorChecked,
      gpu:ext?g.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,
      layerCount:s.map.getAllLayers().length,
      intercepts:s.map.getAllLayers().every(l=>Object.hasOwn(l,'render'))};
   });
   requireTrue(start.ready&&!start.errors.length&&start.loaded>=8&&start.tiles>=8&&
     start.exclusive&&start.policy==='strict'&&start.glErrorChecked&&start.intercepts,
     'Initial strict scene invalid '+JSON.stringify({kind,start}));
   if(!software)requireTrue(/NVIDIA.*RTX 5060 Ti/i.test(start.gpu||''),
     'RTX 5060 Ti not active: '+start.gpu);
   const mutation=await page.evaluate(async kind=>{
    const s=window.__webglExampleBenchmark,map=s.map;
    const layers=map.getAllLayers(),first=layers[0],view=map.getView();
    const before={center:[...view.getCenter()],resolution:view.getResolution(),rotation:view.getRotation()};
    if(kind==='strict-noncontext-error'){
      const gl=map.boost.backend.gl,orig=gl.getError.bind(gl);
      gl.getError=function(){gl.getError=orig;return gl.INVALID_OPERATION};
      try{map.renderSync()}catch{}
    } else if(kind==='mixed-raster-layer'){
      const {default:TileLayer}=await import('/vendor/openlayers-10.10.0-runtime/node_modules/ol/layer/Tile.js');
      map.addLayer(new TileLayer({}));
    } else if(kind==='supported-vector-added'){
      const NewLayer=first.constructor;
      map.addLayer(new NewLayer({source:first.getSource(),
        style:{'stroke-color':'#3586a2','stroke-width':2},disableHitDetection:true}));
    } else if(kind==='style-variables-same-ref'){
      const ref=first.style_;
      first.styleVariables_={accent:'#f00'};
      first.changed();
      if(first.style_!==ref)throw Error('Style reference unexpectedly changed');
    } else if(kind==='unsupported-style-same-ref'){
      const ref=first.style_;
      ref['text-value']=['get','name'];
      first.changed();
      if(first.style_!==ref)throw Error('Style reference unexpectedly changed');
    }
    const status=map.getBoostStatus();
    // Stock rendering must resume at exactly the original view and layer objects.
    for(let i=0;i<2;i++)try{map.renderSync()}catch(error){
      throw Error('Stock fallback threw: '+String(error?.stack||error));
    }
    const after={center:[...view.getCenter()],resolution:view.getResolution(),rotation:view.getRotation()};
    return {before,after,status,boostInstance:map.boost!==null,
      restoredOriginalRenderer:!Object.hasOwn(first,'render')&&typeof first.render==='function',
      visibleStock:!map.getViewport().classList.contains('olvt-boost-exclusive'),
      originalLayerPresent:map.getAllLayers().includes(first),
      layerCount:map.getAllLayers().length,errors:[...s.errors]};
   },kind);
   requireTrue(mutation.status.enabled===false&&!mutation.boostInstance&&
      mutation.restoredOriginalRenderer&&mutation.visibleStock&&mutation.originalLayerPresent,
      'Fail-closed renderer restoration failed '+JSON.stringify({kind,mutation}));
   requireTrue(JSON.stringify(mutation.before)===JSON.stringify(mutation.after),
      'View state changed during fallback '+JSON.stringify({kind,mutation}));
   requireTrue(mutation.errors.length===0&&pageErrors.length===0,
      'Unhandled page/console errors '+JSON.stringify({kind,mutation,pageErrors}));
   requireTrue(kind!=='strict-noncontext-error'||/runtime fallback|error|render/i.test(mutation.status.reason||''),
     'GL error fallback reason not preserved');
   requireTrue(kind==='strict-noncontext-error'||kind==='style-variables-same-ref'||
     kind==='unsupported-style-same-ref'||mutation.layerCount===
       (kind==='mixed-raster-layer'||kind==='supported-vector-added'?9:8),
     'Layer tree count unexpectedly changed');
   const filename='r83-'+kind+'.png';
   const image=await page.locator('#map').screenshot({path:join(dest,filename)});
   requireTrue(image.length>1000,'Stock fallback screenshot empty');
   result.cases.push({kind,start,mutation,screenshot:filename,imageBytes:image.length,pass:true});
   console.log('R83_SAFETY_CASE_PASS',kind,JSON.stringify({
     enabled:mutation.status.enabled,reason:mutation.status.reason,
     stockRestored:mutation.restoredOriginalRenderer,layerCount:mutation.layerCount}));
  }finally{await page.close()}
 }
 result.pass=result.cases.length===cases.length&&result.errors.length===0;
}catch(error){result.errors.push(String(error?.stack||error));
 console.error('R83_SAFETY_FAILED',result.errors.at(-1));
}finally{
 await writeFile(join(dest,'summary.json'),JSON.stringify(result,null,2)+'\n');
 try{await browser?.close()}catch{}
 if(server.exitCode===null){server.kill();await nap(300)}
}
console.log('R83_SAFETY_SUMMARY',JSON.stringify({pass:result.pass,cases:result.cases.length,
 errors:result.errors}));
if(!result.pass)process.exitCode=1;
