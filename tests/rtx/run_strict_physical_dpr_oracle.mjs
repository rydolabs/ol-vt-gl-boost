/** R61 corrected physical DPR1/2 + 8/16/32 MVT strict clean B oracle with deterministic delay seeds.
 * This probes actual OL tile-loader cancellation/retry; it does NOT claim
 * production M5 Worker pipeline cancellation parity.
 */
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,sep,extname,join} from 'node:path';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
const root=resolve(process.argv[2]||'.'),out=resolve(process.argv[3]||join(root,'RESULTS','R55'));
await mkdir(out,{recursive:true});
const testedSourceCount=Number(process.env.M5_R57_SOURCES||32),testedDpr=Number(process.env.M5_R57_DPR||1),testedSeed=Number(process.env.M5_R57_SEED||1);
if(![8,16,32].includes(testedSourceCount)||![1,2].includes(testedDpr)||![1,2].includes(testedSeed))throw Error('Invalid R57 test variant');
const query='?sourceCount='+testedSourceCount+'&raceSeed='+testedSeed;
const TILE_TIMEOUT_MS=16000;
const runVariant={sources:testedSourceCount,dpr:testedDpr,seed:testedSeed};
let server,browser,page;
const report={pass:false,variant:runVariant,checks:[],errors:[],events:[],snapshots:{}};
try{
 const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.pbf':'application/octet-stream'};
 server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const file=resolve(root,'.'+decodeURIComponent(path));
  if(req.method!=='GET'||!file.startsWith(root+sep)||!existsSync(file))throw Error('not found');
  let body=await readFile(file);
  if(path==='/tests/rtx/actual_32_ol_ui.html'){
   let html=body.toString();
   const needle='  const style=part.layer===';
   // DPR2 uses a 512x512 physical backbuffer and 256x256 CSS OpenLayers map.
   // The prior R57 compared a 512 CSS-pixel OL map rendered at DPR2 into a
   // 512 physical-pixel GL buffer, inadvertently cropping the test canvas.
   if(testedDpr===2){
    const cssA='#olmap{position:absolute;top:0;left:540px;width:512px;height:512px}';
    const cssB='#m5{position:absolute;top:0;left:0;width:512px;height:512px}';
    if(!html.includes(cssA)||!html.includes(cssB))throw Error('DPR2 CSS anchors absent');
    html=html.replace(cssA,cssA.replace('width:512px;height:512px','width:256px;height:256px'));
    html=html.replace(cssB,cssB.replace('width:512px;height:512px','width:256px;height:256px'));
   }
   // Clean B begins at the final view; do not pollute its cache with A tiles.
   const viewAnchor='const view=new View({projection:proj,center:[16384,8192],resolution:64,constrainResolution:false});';
   if(!html.includes(viewAnchor))throw Error('R61 View anchor missing');
   html=html.replace(viewAnchor,"const q= new URL(location.href).searchParams.get('oracleView');const initial=q?JSON.parse(q):null; const view=new View({projection:proj,center:initial?.center||[16384,8192],resolution:initial?.resolution||64,rotation:initial?.rotation||0,constrainResolution:false});");

   const sourceCountAnchor=' const pbf=new Map();';
   if(html.split(sourceCountAnchor).length!==2)throw Error('R57 source count anchor missing/duplicate');
   html=html.replace(sourceCountAnchor,` const sourceCount=Number(new URL(location.href).searchParams.get('sourceCount')||32);if(![8,16,32].includes(sourceCount))throw Error('R57 source count');manifest.sources=manifest.sources.slice(0,sourceCount);\n const pbf=new Map();`);
   if(!html.includes(needle))throw Error('R53 fixture injection anchor changed');
   // Replace loader with delayed async Worker messages, generation guards,
   // intentional first-attempt failure, retry, and late old-generation response.
   const before='   tileLoadFunction:(tile,url)=>tile.setLoader((extent,resolution,projection)=>{';
   if(!html.includes(before))throw Error('R53 tile loader anchor changed');
   html=html.replace(before,`   tileLoadFunction:(tile,url)=>tile.setLoader((extent,resolution,projection)=>{
    const key=url.split('?')[0], seq=++globalThis.__r55.seq;
    globalThis.__r55.loaders[key]=()=>tile.setLoader((ex,res,proj)=>{tile.setFeatures(format.readFeatures(pbf.get(key).slice(0),{extent:ex,featureProjection:proj}));info.sourceLoads++;});
    const generation=globalThis.__r55.generation;
    globalThis.__r55.inflight.push({tile,key,generation,seq});
    const attempt=(globalThis.__r55.attempts[key]||0)+1;
    globalThis.__r55.attempts[key]=attempt;
    globalThis.__r55.events.push({type:'issued',key,seq,generation,attempt});
    const seed=Number(new URL(location.href).searchParams.get('raceSeed')||1);
    const delay=generation===0?3000+100*seed:20+10*seed;
    setTimeout(()=>{
     const stale=generation!==globalThis.__r55.generation;
     globalThis.__r55.events.push({type:stale?'late':'settled',key,seq,generation,attempt});
     if(stale)return;
     if(generation===1&&!globalThis.__r55.retried[key]){\n      globalThis.__r55.retried[key]=true;
      tile.setState(3); // Real OL source tileloaderror, not merely a synthetic log label.
      globalThis.__r55.events.push({type:'error-injected',key,seq,generation});
      setTimeout(()=>{
       if(generation!==globalThis.__r55.generation)return;
       try{tile.setState(0);tile.load();globalThis.__r55.events.push({type:'retry',key,seq,generation});}
       catch(e){info.sourceErrors++;info.errors.push(String(e));tile.setState(3)}
      },40);
      return;
     }
     try{tile.setFeatures(format.readFeatures(pbf.get(key).slice(0),{extent,featureProjection:projection}));info.sourceLoads++}
     catch(e){info.sourceErrors++;info.errors.push(String(e));tile.setState(3)}
    },delay);
    return;
   })/* R55_ASYNC */,`);
   // Existing synchronous body remains after injected callback: remove its exact tail.
   const start=html.indexOf('    const raw=pbf.get(url);',html.indexOf('R55_ASYNC'));
   const end=html.indexOf('   })',start);
   if(start<0||end<0)throw Error('R53 synchronous body removal failed');
   html=html.slice(0,start)+html.slice(end+6);
   html=html.replace('const layers=manifest.sources.map',`globalThis.__r55={seq:0,generation:0,attempts:{},retried:{},loaders:{},inflight:[],events:[]};
 const layers=manifest.sources.map`);
   html=html.replace(' globalThis.__r53Snapshot=()=>{',` globalThis.__r55.advance=()=>{
  globalThis.__r55.generation++;
  globalThis.__r55.events.push({type:'cancel',generation:0});
  // Release OpenLayers' default maxTilesLoading=16 queue slots. Merely
  // suppressing the late callback leaves 16 source tiles LOADING forever.
  // The delayed async callbacks remain scheduled to assert stale drop.
  for(const request of globalThis.__r55.inflight.filter(r=>r.generation===0)){
   if(request.tile.getState()===1){request.tile.setState(3);globalThis.__r55.events.push({type:'aborted',key:request.key,seq:request.seq,generation:0});}
  }
  layers.forEach((layer,i)=>{
   const source=layer.getSource();
   source.on('tileloaderror',e=>globalThis.__r55.events.push({type:'source-tileloaderror',index:i,generation:globalThis.__r55.generation,key:e.tile?.getTileUrl?.()}));
   const part=manifest.sources[i],gen=globalThis.__r55.generation;
   source.setTileUrlFunction(([,x,y])=>x===i%8&&y===Math.floor(i/8)?part.x+'/'+part.y+'?r55='+gen:undefined,'r55-generation-'+gen+'-source-'+i);
   source.refresh();
   globalThis.__r55.events.push({type:'source-rekeyed',index:i,key:source.getKey()});
  });
  map.renderSync();map.render();
  globalThis.__r55.events.push({type:'ol-source-refresh',view:{center:map.getView().getCenter(),resolution:map.getView().getResolution()}});
 };
globalThis.__r56FrameDump=()=>{
  if(!lastFrame)throw Error('R56 frameState absent');
  const stats=binding.renderFrame(lastFrame),gl=backend.gl,bytes=new Uint8Array(512*512*4);
  gl.finish();gl.readPixels(0,0,512,512,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
  if(stats.glError!==0||gl.getError()!==0)throw Error('R56 GPU readback error');
  const pieces=[];for(let j=0;j<bytes.length;j+=8192)pieces.push(String.fromCharCode(...bytes.subarray(j,j+8192)));
  const pngCanvas=document.createElement('canvas');pngCanvas.width=512;pngCanvas.height=512;
  const context=pngCanvas.getContext('2d');const image=context.createImageData(512,512);
  image.data.set(bytes);context.putImageData(image,0,0);
  return {raw:btoa(pieces.join('')),png:pngCanvas.toDataURL('image/png').split(',')[1]};
 };
 globalThis.__r56SetView=(state)=>{view.setCenter(state.center);view.setResolution(state.resolution);view.setRotation(state.rotation);map.renderSync();map.render();};
  globalThis.__r53Snapshot=()=>{`);
   body=Buffer.from(html);
  }
  res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
 }catch(e){res.writeHead(404);res.end(String(e))}});
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)});
 browser=await chromium.launch({executablePath:process.env.M5_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--disable-software-rasterizer','--disable-background-networking']});
 page=await browser.newPage({viewport:{width:1120,height:720},deviceScaleFactor:testedDpr});
 page.on('pageerror',e=>report.errors.push('pageerror '+e));
 page.on('console',m=>{if(m.type()==='error')report.errors.push('console '+m.text())});
 await page.goto('http://127.0.0.1:'+server.address().port+'/tests/rtx/actual_32_ol_ui.html'+query,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__r53?.ready||window.__r53?.errors?.length,{timeout:10000});
 const ready=await page.evaluate(()=>({ready:__r53.ready,errors:__r53.errors}));
 if(!ready.ready||ready.errors.length)throw Error('fixture not ready '+JSON.stringify(ready));
 // An old request must actually be in flight before triggering cancellation.
 await page.waitForFunction(()=>window.__r55?.events.some(e=>e.type==='issued'&&e.generation===0)||window.__r53?.errors?.length>0,null,{timeout:15000});
 const mouseX=testedDpr===2?660:790,mouseY=testedDpr===2?120:250;
 await page.mouse.move(mouseX,mouseY);await page.mouse.down();await page.mouse.move(mouseX-10,mouseY+5,{steps:3});await page.mouse.up();
 await page.evaluate(()=>__r55.advance());
 // Demand genuinely new grid tiles by dragging the real OL map across
 // more than one 64 CSS-pixel tile (the previous 10px drag reused old tiles).
 await page.mouse.move(testedDpr===2?675:800,mouseY);await page.mouse.down();
 await page.mouse.move(testedDpr===2?605:665,mouseY+22,{steps:12});await page.mouse.up();
 await page.waitForFunction(()=>window.__r55?.events.some(e=>e.type==='issued'&&e.generation===1)||window.__r53?.errors?.length>0,null,{timeout:4000}).catch(async e=>{report.events=await page.evaluate(()=>window.__r55?.events||[]);report.snapshots.timeout=await page.evaluate(()=>({generation:window.__r55?.generation,attempts:window.__r55?.attempts,ready:window.__r53?.ready,errors:window.__r53?.errors,frames:window.__r53?.frames}));report.checks.push('OpenLayers source refresh did not issue generation-1 requests; this is an observed gate failure');throw e});
 await page.mouse.move(mouseX,mouseY);await page.mouse.down();await page.mouse.move(mouseX-10,mouseY+5,{steps:3});await page.mouse.up();
 // Do not infer stale timing from sleeps; demand late generation-A callbacks.
 await page.waitForFunction(()=>window.__r55?.events.some(e=>e.type==='late')||window.__r53?.errors?.length>0,null,{timeout:TILE_TIMEOUT_MS});
 await page.waitForTimeout(400);
 report.events=await page.evaluate(()=>__r55.events);
 report.snapshots.final=await page.evaluate(()=>__r53Snapshot());
 const count=t=>report.events.filter(e=>e.type===t).length;
 if(count('issued')<Math.min(4,testedSourceCount)||count('cancel')<1||count('aborted')<1||count('late')<1||count('retry')<1||count('source-tileloaderror')<1||!report.events.some(e=>e.type==='issued'&&e.generation===1))throw Error('race coverage insufficient '+JSON.stringify({issued:count('issued'),cancel:count('cancel'),late:count('late'),retry:count('retry')}));
 report.checks.push('actual OL UI async tile issue, generation cancellation, late response and retry observed');
 if(report.snapshots.final.glError!==0||report.snapshots.final.painted<=0||report.snapshots.final.sourceErrors||report.snapshots.final.errors.length||!/NVIDIA.*RTX 5060 Ti/i.test(report.snapshots.final.renderer||''))throw Error('invalid framebuffer '+JSON.stringify(report.snapshots.final));
 report.checks.push('physical GL nonempty and error-free after delayed tile race');

 // Independent clean-generation B oracle: fresh page, same physical GPU,
 // same final OL viewState. Compare all 512x512 RGBA8 pixels, not only a hash.
 const raceDump=await page.evaluate(()=>__r56FrameDump());
 const raced=Buffer.from(raceDump.raw,'base64');
 await writeFile(join(out,'raced-B.png'),Buffer.from(raceDump.png,'base64'));
 await writeFile(join(out,'raced-B.rgba8'),raced);
 const clean=await browser.newPage({viewport:{width:1120,height:720},deviceScaleFactor:testedDpr});
 clean.on('pageerror',e=>report.errors.push('oracle pageerror '+String(e)));
 clean.on('console',m=>{if(m.type()==='error')report.errors.push('oracle console '+m.text())});
 try{
  const finalView=report.snapshots.final.view;
  const cleanQuery=query+'&oracleView='+encodeURIComponent(JSON.stringify(finalView));
  await clean.goto('http://127.0.0.1:'+server.address().port+'/tests/rtx/actual_32_ol_ui.html'+cleanQuery,{waitUntil:'domcontentloaded'});
  await clean.waitForFunction(()=>window.__r53?.ready||window.__r53?.errors?.length,{timeout:10000});
  const required=report.snapshots.final.drawPackets;
  await clean.waitForFunction(min=>{const s=window.__r53Snapshot?.();return s?.drawPackets>=min||s?.errors?.length>0},required,{timeout:10000});
  await clean.waitForTimeout(650);
  const cleanSnapshot=await clean.evaluate(()=>__r53Snapshot());
  report.snapshots.cleanOracle=cleanSnapshot;
  if(cleanSnapshot.glError!==0||cleanSnapshot.errors.length||cleanSnapshot.sourceErrors!==0||cleanSnapshot.painted<=0||cleanSnapshot.drawPackets<required)
   throw Error('R56 clean oracle did not settle '+JSON.stringify(cleanSnapshot));
  const raceIds=report.snapshots.final.tilePackets.map(x=>x.key).sort();
  const cleanIds=cleanSnapshot.tilePackets.map(x=>x.key).sort();
  report.tileAudit={raceIds,cleanIds,exact:JSON.stringify(raceIds)===JSON.stringify(cleanIds)};
  if(!report.tileAudit.exact)throw Error('R61 tile-ID completeness mismatch '+JSON.stringify({race:raceIds,clean:cleanIds}));
  report.checks.push('independent clean B tile ID set exactly equals raced B');
  const cleanDump=await clean.evaluate(()=>__r56FrameDump());
  const fresh=Buffer.from(cleanDump.raw,'base64');
  await writeFile(join(out,'clean-B.png'),Buffer.from(cleanDump.png,'base64'));
  await writeFile(join(out,'clean-B.rgba8'),fresh);
  if(fresh.length!==512*512*4||raced.length!==fresh.length)throw Error('R56 raw dimensions invalid');
  let diffPixels=0,changedChannels=0;
  const diff=Buffer.alloc(fresh.length);
  for(let i=0;i<fresh.length;i+=4){
   let changed=false;
   for(let c=0;c<4;c++){
    const delta=Math.abs(fresh[i+c]-raced[i+c]);
    if(delta){changedChannels++;changed=true;diff[i+c]=255}
   }
   if(changed){diffPixels++;diff[i+3]=255}
  }
  await writeFile(join(out,'B-diff.rgba8'),diff);
  report.pixelAudit={sources:testedSourceCount,dpr:testedDpr,seed:testedSeed,width:512,height:512,diffPixels,changedChannels,oracleDrawPackets:cleanSnapshot.drawPackets,raceDrawPackets:report.snapshots.final.drawPackets};
  if(diffPixels!==0||changedChannels!==0)throw Error('R56 CLEAN B PIXEL ORACLE FAIL '+JSON.stringify(report.pixelAudit));
  report.checks.push('independent fresh-load B 512x512 raw RGBA8 exact match diffPixels=0');
 }finally{await clean.close();}
 report.pass=true;
}catch(e){report.error=String(e.stack||e)}
finally{
 if(page){try{await page.screenshot({path:join(out,'r55-final.png')})}catch{}}
 if(report.errors.length){report.pass=false;report.error=(report.error||'')+' console '+JSON.stringify(report.errors)}
 await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
 try{await browser?.close()}catch{}
 if(server?.listening)await new Promise(ok=>server.close(ok));
}
console.log(report.pass?'R61_STRICT_DPR_ORACLE_PASS':'R61_STRICT_DPR_ORACLE_FAIL',report.checks);
if(!report.pass)process.exitCode=1;
