import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
import {encodeDirectFeatureTile,DirectFeatureWebGLPipeline} from '../src/gl/pipeline.js';
import {DirectTileWorkerPool} from '../src/optional/worker/DirectTileWorkerPool.js';
import {OlVectorTileSourceAdapter} from '../src/ol/OlVectorTileSourceAdapter.js';

const style={
  building:{'fill-color':'rgba(210,194,169,0.52)','stroke-color':'#766655','stroke-width':1},
  road:{'stroke-color':'rgba(220,65,55,0.92)','stroke-width':3},
  water:{'fill-color':'rgba(90,154,227,0.75)'},
  railway:{'stroke-color':'rgba(70,70,70,0.9)','stroke-width':2},
};
const root=new URL('./fixtures/seoul/12/',import.meta.url);
const tasks=[];
for(const layer of ['building','road','water','railway'])for(const [x,y] of [[3492,1586],[3493,1586],[3492,1587],[3493,1587]]){
  const pbf=readFileSync(new URL(`${x}/${y}.pbf`,root));
  tasks.push({tileKey:`12/${x}/${y}/${layer}`,layer,bytes:pbf,
    extent:[(x-3492)*4096,(1587-y)*4096,(x-3491)*4096,(1588-y)*4096],
    style:style[layer],options:{partialEarcut:true,unclipped:true,drawMode:'style-pass',polygonStrokeFringePx:1,closedLineJoins:true}});
}
const normal=(task)=>{
  globalThis.__m5R29EarcutPartial=true;
  globalThis.__m5R18PolygonStrokeUnclipped=true;
  globalThis.__m5R18FlatUnclippedStroke=true;
  globalThis.__m5R18ClosedRingJoin=true;
  const f=new MVT({layers:[task.layer]}).readFeatures(task.bytes,{extent:task.extent});
  const encoded=encodeDirectFeatureTile(f,{styleFor:()=>task.style,
    clipExtent:task.extent,drawMode:'style-pass',polygonStrokeFringePx:1,closedLineJoins:true,stableStyleIdentityCache:true});
  return {encoded,featureCount:f.length};
};
const formatKeys=['vertices','indices','lineInstances'];
const bytes=a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength);
function assertEqual(control,test,id){
  for(const k of formatKeys){
    assert.equal(test.encoded[k].constructor,control.encoded[k].constructor,`Array type ${id} ${k}`);
    assert.ok(bytes(test.encoded[k]).equals(bytes(control.encoded[k])),`GPU stream ${id} ${k}`);
  }
  assert.deepEqual(test.encoded.packets,control.encoded.packets,`Draw order ${id}`);
  assert.deepEqual(test.encoded.counters,control.encoded.counters,`Counter ${id}`);
  assert.deepEqual(test.encoded.clipExtent,control.encoded.clipExtent,`Extent ${id}`);
  assert.equal(test.encoded.indexType,control.encoded.indexType);
  assert.equal(test.featureCount,control.featureCount);
}
const poolFactory=(size)=>new DirectTileWorkerPool({size,maxCacheBytes:20*1024*1024,
  createWorker:()=>new Worker(new URL('../src/optional/worker/DirectTileEncodeWorker.node.mjs',import.meta.url))});
const t0=performance.now();const pool=poolFactory(2);await pool.ready;const startupMs=performance.now()-t0;
let baseline=tasks.map(normal);const workerResults=await pool.map(tasks);
let bytesCompared=0;
for(let i=0;i<tasks.length;i++){
  assertEqual(baseline[i],workerResults[i],tasks[i].tileKey);
  bytesCompared+=formatKeys.reduce((s,k)=>s+bytes(workerResults[i].encoded[k]).byteLength,0);
}
// Verify GPU handoff uses the same backend-owned buffers and packet order.
const upload=[];const backend={gl:{},createBufferResource:(target,length)=>({target,length}),
  uploadBufferResource:(target,buffer,offset,data)=>upload.push({target,buffer,offset,kind:data.constructor.name,length:data.byteLength}),
  deleteBufferResource:()=>{},supportsUint32ElementIndices:()=>true};
const renderer=new DirectFeatureWebGLPipeline(backend);
for(let i=0;i<tasks.length;i++){
  renderer.replaceEncodedTile(tasks[i].tileKey,workerResults[i].encoded);
  assert.deepEqual(renderer.tiles.get(tasks[i].tileKey).packets,baseline[i].encoded.packets);
}
assert.equal(renderer.tiles.size,16);
assert.equal(upload.reduce((sum,item)=>sum+item.length,0),bytesCompared);
renderer.clear();
// Actual adapter ingest branch must bypass main-thread Earcut / source features.
const grid={getTileCoordExtent:()=>tasks[0].extent};
const source={getProjection:()=>null,getTileGrid:()=>grid};
const wrapped=new OlVectorTileSourceAdapter({source,sink:renderer,styleLike:style.building});
const tile={getTileCoord:()=>[12,3492,1586],getFeatures:()=>[],
 getEncodedTile:()=>workerResults[0].encoded,featureCount:workerResults[0].featureCount};
wrapped.ingestTile(tile);
assert.equal(renderer.tiles.size,1);
assert.deepEqual(renderer.tiles.get('12/3492/1586').packets,baseline[0].encoded.packets);
wrapped.removeTile('12/3492/1586');
assert.equal(renderer.tiles.size,0);
// Key includes source revision, style, options, projection, layer and clip extent.
const cacheKey='12/3492/1586/building|pbfSHA:fixture|style:build-1|clip:0,4096,4096,8192|earcut:R29';
const first=await pool.submit(tasks[0],{cacheKey});assertEqual(baseline[0],first,tasks[0].tileKey);
const countBefore=pool.stats.dispatched;
const hit=await pool.submit(tasks[0],{cacheKey});assert.equal(hit.cacheHit,true);assert.equal(hit.featureCount,baseline[0].featureCount);
assert.equal(pool.stats.dispatched,countBefore,'cache hit must avoid Worker/Earcut');
assertEqual(baseline[0],{...hit,featureCount:baseline[0].featureCount},'cache hit');
const kept=baseline[0].encoded.vertices[0];hit.encoded.vertices[0]=123456;
const hit2=await pool.submit(tasks[0],{cacheKey});assert.equal(hit2.encoded.vertices[0],kept,'cache must not expose mutable source');
await pool.close();
await assert.rejects(pool.submit(tasks[0]),/closed/);
console.log(JSON.stringify({pass:true,tiles:16,streamsExact:48,packetsExact:16,bytesCompared,
  workerCount:2,startupMs:Number(startupMs.toFixed(3)),cacheHitAvoidsEarcut:true,
  uploadedBytes:upload.reduce((sum,item)=>sum+item.length,0),workerErrors:pool.stats.workerErrors},null,2));
