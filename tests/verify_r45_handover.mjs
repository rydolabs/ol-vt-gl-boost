import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DeferredDirectTileHandover} from '../src/optional/worker/DeferredDirectTileHandover.js';
import {encodeTileLayerGroupTask} from '../src/optional/worker/DirectTileEncodeTask.js';
import {exactEncodedTile} from '../src/optional/worker/EncodedTileExactGate.js';
const fixture=(x,y)=>readFileSync(new URL(`./fixtures/seoul/12/${x}/${y}.pbf`,import.meta.url));
const coord=[[3492,1586],[3493,1586]],bounds=(x,y)=>[(x-3492)*4096,(1587-y)*4096,(x-3491)*4096,(1588-y)*4096];
const styles=[{layer:'road',style:{'stroke-color':'rgba(220,65,55,0.92)','stroke-width':3}},
  {layer:'road',style:{'stroke-color':'rgba(20,95,80,0.9)','stroke-width':1}}];
const taskFor=(x,y,styles0=styles)=>({tileKey:`12/${x}/${y}`,layers:styles0,
  allowDuplicateLayers:true,bytes:fixture(x,y),extent:bounds(x,y),options:{drawMode:'style-pass',unclipped:true,
    partialEarcut:true,closedLineJoins:true,polygonInsideSegmentFastPath:true,polygonEarBBoxPrecheck:true}});
const source={};
function setup({fail=false,mutate=false,afterPaint=()=>Promise.resolve()}={}){
 const cpu=new Map(),commits=[],errors=[],queued=[],pool={ready:Promise.resolve(),closed:false,
  submit(task){queued.push(task.tileKey);if(fail)return Promise.reject(Error('injected worker crash'));
    const output=encodeTileLayerGroupTask(task);
    if(mutate&&output.rows[0].encoded.lineInstances.length)output.rows[0].encoded.lineInstances[0]+=1;
    return Promise.resolve(output);},async close(){this.closed=true;}};
 const handover=new DeferredDirectTileHandover({enabled:true,resolveTask:({tile})=>tile.task,
  createPool:()=>pool,afterPaint,getCpuEncoded:(state,k)=>cpu.get(state.key+'::'+k),
  onError:e=>errors.push(String(e))});
 return {cpu,commits,errors,queued,pool,handover};
}
function addTile(t,x,y,states=2){
 const task=taskFor(x,y,styles.slice(0,states)),tile={task,getTileCoord:()=>[12,x,y]},expected=encodeTileLayerGroupTask(task);
 for(let i=0;i<states;i++){
  const state={key:'layer'+i,source,layer:{},state:{opacity:1},
   sink:{replaceEncodedTile:(key,encoded)=>{t.commits.push({key,state:i,encoded});}},adapter:{tiles:new Map([[task.tileKey,tile]])}};
  t.cpu.set(state.key+'::'+task.tileKey,expected.rows[i].encoded);
  t.handover.enqueue({state,tile,tileKey:task.tileKey,clipExtent:task.extent});
  if(!t.states)t.states=[];t.states.push(state);
 }
 return {tile,task};
}
{
 const t=setup();addTile(t,...coord[0]);addTile(t,...coord[1]);
 assert.equal(t.queued.length,0,'Worker startup must not precede first GPU frame');
 t.handover.afterDraw();await t.handover.whenIdle();
 assert.deepEqual(t.queued,['12/3492/1586','12/3493/1586']);
 assert.equal(t.commits.length,4,'every tile in the same layer must survive version checks');
 assert.equal(t.handover.metrics.parityRejects,0);
 assert.equal(t.handover.metrics.decodeCalls,2,'one PBF decode for each tile, not per styled layer');
 assert.ok(t.commits.every(({encoded,key,state})=>exactEncodedTile(t.cpu.get('layer'+state+'::'+key),encoded)));
 await t.handover.close();assert.equal(t.pool.closed,true);
}
{
 const t=setup({mutate:true});addTile(t,...coord[0]);t.handover.afterDraw();await t.handover.whenIdle();
 assert.equal(t.commits.length,0,'partial multi-layer group must not commit if bytes differ');
 assert.equal(t.handover.metrics.parityRejects,1);
 await t.handover.close();
}
{
 const t=setup({fail:true});addTile(t,...coord[0]);t.handover.afterDraw();await t.handover.whenIdle();
 assert.equal(t.commits.length,0);assert.equal(t.handover.failed,true);
 assert.equal(t.handover.metrics.failures,1);assert.equal(t.errors.length,1);
 await t.handover.close();
}
{
 let unpause;const t=setup({afterPaint:()=>new Promise(r=>{unpause=r;})});
 addTile(t,...coord[0]);t.handover.afterDraw();
 await Promise.resolve();
 t.handover.invalidateTile(t.states[0],'12/3492/1586');
 t.handover.invalidateTile(t.states[1],'12/3492/1586');
 unpause();await t.handover.whenIdle();
 assert.equal(t.commits.length,0,'removed tile must never be revived');
 assert.equal(t.queued.length,0,'removed tile should not consume Worker CPU');
 await t.handover.close();
}
{
 const t=setup();addTile(t,...coord[0]);t.handover.afterDraw();await t.handover.whenIdle();
 await t.handover.close();addTile(t,...coord[1]);t.handover.afterDraw();
 assert.equal(t.commits.length,2,'closed handover cannot revive');
}
{
 // Regression: CPU tile B arrives and is painted while Worker A is unresolved.
 // A completed batch must schedule B without requiring a third unrelated frame.
 const t=setup(),originalSubmit=t.pool.submit.bind(t.pool);
 let releaseFirst;
 t.pool.submit=task=>releaseFirst
   ?originalSubmit(task)
   :new Promise(resolve=>{releaseFirst=()=>resolve(encodeTileLayerGroupTask(task));});
 addTile(t,...coord[0]);t.handover.afterDraw();
 for(let i=0;i<60&&!releaseFirst;i++)await Promise.resolve();
 assert.ok(releaseFirst,'first Worker batch must start');
 addTile(t,...coord[1]);t.handover.afterDraw();
 releaseFirst();await t.handover.whenIdle();
 assert.equal(t.commits.length,4,'a newly painted CPU tile must not be stranded');
 assert.equal(t.handover.metrics.workerRows,4);
 await t.handover.close();
}
console.log(JSON.stringify({pass:true,assertions:['two tiles and duplicate shared PBF layers','two decoded tasks not four','exact GPU buffer and packet parity','all-or-none group rejection','worker failure keeps CPU','removed tile race','closed pool does not restart','CPU tile painted during in-flight Worker does not starve']},null,2));
