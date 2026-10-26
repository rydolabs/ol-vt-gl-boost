import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
import {encodeDirectFeatureTile,DirectFeatureWebGLPipeline} from '../src/gl/pipeline.js';
import {DirectTileWorkerPool} from '../src/optional/worker/DirectTileWorkerPool.js';
import {encodeTileLayerGroupTask} from '../src/optional/worker/DirectTileEncodeTask.js';

const layers=[
 {layer:'water',style:{'fill-color':'rgba(90,154,227,0.75)'}},
 {layer:'building',style:{'fill-color':'rgba(210,194,169,0.52)','stroke-color':'#766655','stroke-width':1}},
 {layer:'road',style:{'stroke-color':'rgba(220,65,55,0.92)','stroke-width':3}},
 {layer:'railway',style:{'stroke-color':'rgba(70,70,70,0.9)','stroke-width':2}},
];
const keys=[[3492,1586],[3493,1586],[3492,1587],[3493,1587]];
const options={partialEarcut:true,unclipped:true,drawMode:'style-pass',polygonStrokeFringePx:1,
  closedLineJoins:true,polygonInsideSegmentFastPath:true,polygonEarBBoxPrecheck:true};
const tasks=keys.map(([x,y])=>({tileKey:`12/${x}/${y}`,layers,
  bytes:readFileSync(new URL(`./fixtures/seoul/12/${x}/${y}.pbf`,import.meta.url)),
  extent:[(x-3492)*4096,(1587-y)*4096,(x-3491)*4096,(1588-y)*4096],options}));
const expected=layers.map(({layer,style})=>tasks.map(task=>{
  globalThis.__m5R29EarcutPartial=true;
  globalThis.__m5R18PolygonStrokeUnclipped=true;
  globalThis.__m5R18FlatUnclippedStroke=true;
  globalThis.__m5R18ClosedRingJoin=true;
  const features=new MVT({layers:[layer]}).readFeatures(task.bytes,{extent:task.extent});
  const encoded=encodeDirectFeatureTile(features,{styleFor:()=>style,clipExtent:task.extent,drawMode:'style-pass',
    polygonStrokeFringePx:1,closedLineJoins:true,stableStyleIdentityCache:true});
  return {encoded,featureCount:features.length};
}));
const createPool=(size=2,maxCacheBytes=24*1024*1024)=>new DirectTileWorkerPool({size,maxCacheBytes,
 createWorker:()=>new Worker(new URL('../src/optional/worker/DirectTileEncodeWorker.node.mjs',import.meta.url))});
const buffer=a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength);
function checkRows(result,label){
  assert.equal(result.length,4,`${label}: grouped rows`);
  for(let ti=0;ti<4;ti++)for(let li=0;li<4;li++){
    const row=result[ti].rows[li],ex=expected[li][ti],id=`${label}:${ti}:${li}`;
    assert.equal(row.layer,layers[li].layer,id+':layer');
    assert.equal(row.featureCount,ex.featureCount,id+':features');
    for(const key of ['vertices','indices','lineInstances']){
      assert.equal(row.encoded[key].constructor,ex.encoded[key].constructor,id+':'+key+':type');
      assert.ok(buffer(row.encoded[key]).equals(buffer(ex.encoded[key])),id+':'+key+':GPU bytes');
    }
    assert.deepEqual(row.encoded.packets,ex.encoded.packets,id+':packets');
    assert.deepEqual(row.encoded.counters,ex.encoded.counters,id+':counters');
    assert.deepEqual(row.encoded.clipExtent,ex.encoded.clipExtent,id+':extent');
    assert.equal(row.encoded.indexType,ex.encoded.indexType,id+':indexType');
  }
}
const pool=createPool();await pool.ready;
try{
 const gpuGroups=await pool.map(tasks);
 checkRows(gpuGroups,'uncached worker');
 assert.deepEqual(gpuGroups.map(g=>g.decodeCalls),[1,1,1,1]);
 assert.equal(pool.stats.dispatched,4,'4 PBF tile tasks, not 16 layer tasks');
 let bytes=0;for(const group of gpuGroups)for(const row of group.rows){
  bytes+=row.encoded.vertices.byteLength+row.encoded.indices.byteLength+row.encoded.lineInstances.byteLength;
 }
 assert.equal(bytes,5774598);
 // GPU commit should receive same packet ordering as serial source-layer major loop.
 const uploaded=[];const backend={gl:{},createBufferResource:(t,n)=>({t,n}),
  uploadBufferResource:(target,b,offset,data)=>uploaded.push(data.byteLength),
  deleteBufferResource:()=>{},supportsUint32ElementIndices:()=>true};
 const renderer=new DirectFeatureWebGLPipeline(backend);
 for(let li=0;li<layers.length;li++)for(let ti=0;ti<4;ti++){
  const row=gpuGroups[ti].rows[li];renderer.replaceEncodedTile(row.tileKey+':'+row.layer,row.encoded);
 }
 assert.equal(renderer.tiles.size,16);
 assert.equal(uploaded.reduce((a,b)=>a+b,0),bytes);
 renderer.clear();
 // Per-group 1 decode, 4 layer encodes; cache must skip both and clone buffers.
 const hash=tasks.map(task=>createHash('sha256').update(task.bytes).digest('hex'));
 const cacheKeys=tasks.map((task,i)=>
  `r34|${task.tileKey}|${hash[i]}|${JSON.stringify(layers)}|${JSON.stringify(options)}|${task.extent.join(',')}`);
 const first=await pool.map(tasks,{cacheKeys});checkRows(first,'first cached');
 const dispatched=pool.stats.dispatched;
 const hit=await pool.map(tasks,{cacheKeys});checkRows(hit,'cached worker');
 assert.ok(hit.every(x=>x.cacheHit===true));
 assert.equal(pool.stats.dispatched,dispatched,'cache must skip all 4 Earcut task dispatches');
 hit[0].rows[0].encoded.vertices[0]=123456;
 const hit2=await pool.map(tasks,{cacheKeys});checkRows(hit2,'cache mutation isolation');
 const changedStyle=structuredClone(tasks[0]);changedStyle.layers[1].style['fill-color']='#ff00ff';
 const differentKey=cacheKeys[0]+'|style:changed';
 const changed=await pool.submit(changedStyle,{cacheKey:differentKey});
 assert.equal(changed.cacheHit,undefined,'cache revision must not hit');
 assert.equal(pool.stats.dispatched,dispatched+1);
 const direct=tasks.map(encodeTileLayerGroupTask);
 checkRows(direct,'direct grouped function');
 // A one-layer scene must preserve the same byte exact output and decode once.
 for(const li of [0,1,2,3]){
  const single=await pool.submit({...tasks[0],layers:[layers[li]]});
  const actual=single.rows[0].encoded,ref=expected[li][0].encoded;
  assert.equal(single.decodeCalls,1);
  for(const key of ['vertices','indices','lineInstances'])assert.ok(buffer(actual[key]).equals(buffer(ref[key])),'solo scene '+li+' '+key);
 }
 await assert.rejects(pool.submit({...tasks[0],layers:[layers[0],layers[0]]}),/unique source layers/);
 console.log(JSON.stringify({pass:true,tileGroups:4,decodeCalls:4,individualDecodedCalls:16,
  streamsExact:48,drawPacketsExact:16,bytesCompared:bytes,cacheHits:pool.stats.cacheHits,
  cachePreventsReencode:true,styleInvalidation:true,renderUploadBytes:uploaded.reduce((a,b)=>a+b,0),
  workerCount:pool.size,workerErrors:pool.stats.workerErrors},null,2));
}finally{await pool.close();}
