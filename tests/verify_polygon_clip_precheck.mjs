/** Byte-exact precheck vs untouched triangle-level clipping, four real MVT tiles. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
import {OlVectorTileFeatureAdapter} from '../src/ol/OlVectorTileFeatureAdapter.js';
import {NeutralGeometryCompiler} from '../src/tile/NeutralGeometryCompiler.js';
import {EarcutPolygonTriangulator} from '../src/tile/EarcutPolygonTriangulator.js';
import {classifyPolygonClip} from '../src/tile/clip.js';
const dir=fileURLToPath(new URL('./fixtures/seoul/12/',import.meta.url));
const bounds=[0,0,4096,4096], adapter=new OlVectorTileFeatureAdapter();
const old=new NeutralGeometryCompiler({polygonTriangulator:new EarcutPolygonTriangulator()});
const fast=new NeutralGeometryCompiler({polygonTriangulator:new EarcutPolygonTriangulator(),polygonClipPrecheck:true});
const totals={feature:0,part:0,inside:0,outside:0,partial:0,triangles:0,bytes:0};
for(const key of ['3492/1586','3492/1587','3493/1586','3493/1587']){
 const fs=new MVT({layers:['building']}).readFeatures(readFileSync(resolve(dir,`${key}.pbf`)));
 totals.feature+=fs.length;
 for(const f of fs){
  const n=adapter.adapt(f,{tileKey:key,clipExtent:bounds,styleLike:{'fill-color':'rgba(210,194,169,0.52)'},styleMode:'parts'});
  for(const g of n.geometries){
    totals.part++;
    const kind=classifyPolygonClip(g.rings,g.clipExtent);totals[kind]++;
    const a=old.compile(g),b=fast.compile(g);
    assert.deepEqual(Buffer.from(b.data.buffer,b.data.byteOffset,b.data.byteLength),Buffer.from(a.data.buffer,a.data.byteOffset,a.data.byteLength),`polygon output must be bit-identical: ${key}, ${totals.part}, ${kind}`);
    totals.triangles+=a.data.length/6;totals.bytes+=a.data.byteLength;
  }
 }
}
assert.equal(totals.feature,5);assert.equal(totals.part,1383);
assert(totals.inside>1100&&totals.outside>0&&totals.partial>0);
const synthetic=[
 {rings:[[[1,1],[2,1],[2,2],[1,2],[1,1]]],clipExtent:[0,0,3,3]},
 {rings:[[[10,10],[11,10],[11,11],[10,11],[10,10]]],clipExtent:[0,0,3,3]},
 {rings:[[[-2,-2],[2,-2],[2,2],[-2,2],[-2,-2]]],clipExtent:[0,0,3,3]},
 {rings:[[[-1,-1],[4,-1],[4,4],[-1,4],[-1,-1]],[[0.5,0.5],[0.5,1],[1,1],[1,0.5],[0.5,0.5]]],clipExtent:[0,0,3,3]},
 {rings:[[[0,0],[3,0],[3,3],[0,3],[0,0]]],clipExtent:[0,0,3,3]},
 {rings:[[[0,0],[1,0],[1,1],[0,1],[0,0]]],clipExtent:null}
];
for(const g of synthetic)assert.deepEqual(fast.compile({kind:'polygon',...g}).data,old.compile({kind:'polygon',...g}).data);
assert.equal(classifyPolygonClip([[[NaN,0],[1,0],[1,1]]],bounds),'partial');
assert.equal(classifyPolygonClip([],bounds),'partial');
console.log(JSON.stringify({pass:true,scope:'Four real Seoul building MVT tiles, exact Float32 output/triangle order; synthetic interior/outside/boundary/hole; no browser pixel test',...totals}));
