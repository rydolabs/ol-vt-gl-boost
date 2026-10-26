import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
import {encodeDirectFeatureTile} from '../src/gl/pipeline.js';
import {encodeTileLayerGroupTask} from '../src/optional/worker/DirectTileEncodeTask.js';
import {exactEncodedTile} from '../src/optional/worker/EncodedTileExactGate.js';
const coords=[[3492,1586],[3493,1586],[3492,1587],[3493,1587]];
const layers=[
 {layer:'road',style:{'stroke-color':'rgba(220,65,55,0.92)','stroke-width':3}},
 {layer:'road',style:{'stroke-color':'rgba(20,95,80,0.9)','stroke-width':1}},
 {layer:'building',style:{'fill-color':'rgba(210,194,169,0.52)','stroke-color':'#766655','stroke-width':1}},
 {layer:'building',style:{'fill-color':'rgba(110,194,169,0.62)'}}
];
const options={partialEarcut:true,unclipped:true,drawMode:'style-pass',
  closedLineJoins:true,polygonStrokeFringePx:0,polygonInsideSegmentFastPath:true,polygonEarBBoxPrecheck:true};
let outputs=0,bytes=0,decodes=0;
for(const [x,y] of coords){
 const extent=[(x-3492)*4096,(1587-y)*4096,(x-3491)*4096,(1588-y)*4096];
 const tileKey=`12/${x}/${y}`,
  pbf=readFileSync(new URL(`./fixtures/seoul/12/${x}/${y}.pbf`,import.meta.url));
 const worker=encodeTileLayerGroupTask({tileKey,layers,bytes:pbf,extent,options,allowDuplicateLayers:true});
 assert.equal(worker.decodeCalls,1);decodes++;
 for(const [i,{layer,style}] of layers.entries()){
  globalThis.__m5R29EarcutPartial=true;
  globalThis.__m5R18PolygonStrokeUnclipped=true;
  globalThis.__m5R18FlatUnclippedStroke=true;
  globalThis.__m5R18ClosedRingJoin=true;
  globalThis.__m5R30ScissorFill=false;
  globalThis.__m5R30FastStrokeRing=false;
  globalThis.__m5R30EarcutPool=false;
  const features=new MVT({layers:[layer]}).readFeatures(pbf,{extent});
  const cpu=encodeDirectFeatureTile(features,{styleFor:()=>style,clipExtent:extent,
   drawMode:'style-pass',polygonStrokeFringePx:0,closedLineJoins:true,
   polygonInsideSegmentFastPath:true,polygonEarBBoxPrecheck:true,stableStyleIdentityCache:true});
  const result=worker.rows[i].encoded;
  assert.ok(exactEncodedTile(cpu,result),`${tileKey}, style index ${i}: CPU/Worker byte-exact`);
  assert.equal(features.length,worker.rows[i].featureCount);
  bytes+=cpu.byteLength;outputs++;
 }
}
console.log(JSON.stringify({pass:true,tiles:coords.length,sourceLayers:2,styles:layers.length,
 outputTiles:outputs,pbfDecodeCalls:decodes,cpuBaselineDecodes:outputs,
 comparedEncodedBytes:bytes,exactGpuBytesAndDrawPackets:true}));
