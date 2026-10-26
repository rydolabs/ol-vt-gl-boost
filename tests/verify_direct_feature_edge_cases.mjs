import assert from 'node:assert/strict';
import {referenceRenderFeatureGpuJoinDirect,writeDirectGpuJoinPath,packRenderFeatureGpuJoinNeighbors} from '../src/tile/RenderFeatureLinePacker.js';
import {OlVectorTileFeatureAdapter} from '../src/ol/OlVectorTileFeatureAdapter.js';
const adapter=new OlVectorTileFeatureAdapter();
const stroke=[{'stroke-color':'#aa5588','stroke-width':2}];
const feature=(flat,ends,type='MultiLineString')=>({getType:()=>type,getFlatCoordinates:()=>flat,getEnds:()=>ends,getStride:()=>2,getProperties:()=>({layer:'road'})});
const flat=new Float32Array([0,0,1,0,1,1,  5,5,6,6,7,6,8,6]);
const ends=[6,14];
const desc=referenceRenderFeatureGpuJoinDirect(flat,ends);
assert.ok(desc?.directGpuJoin);
assert.equal(desc.instanceCount,5);
const result=new Float32Array(desc.instanceCount*8);
let off=0,pointStart=0;for(const end of ends){const pointCount=(end/2-pointStart);off=writeDirectGpuJoinPath(result,off,desc,pointStart,pointCount);pointStart=end/2;}
assert.equal(off,result.length);
assert.deepEqual(result,packRenderFeatureGpuJoinNeighbors(flat,ends).instanceData);
for(const styleLike of [stroke]){
 const snap=adapter.adapt(feature(flat,ends),{styleLike,styleMode:'parts',singleStyleLinePack:true,directFeatureGpuJoin:true,gpuJoinSolidLine:true,directLineBuffer:true});
 assert.equal(snap.geometries.length,1);assert.equal(snap.geometries[0].directGpuJoin,true);
 assert.deepEqual(snap.packedPartVertexCounts,[3,4]);
}
const degenerate=feature(new Float32Array([0,0,1,0,1,0,2,0]),[8]);
const fallback=adapter.adapt(degenerate,{styleLike:stroke,styleMode:'parts',singleStyleLinePack:true,directFeatureGpuJoin:true,gpuJoinSolidLine:true,directLineBuffer:true});
assert.equal(fallback.geometries[0].directGpuJoin,undefined);
assert.ok(fallback.geometries[0].instanceData instanceof Float32Array);
const styles=[...stroke,{...stroke[0],'stroke-width':4}];
const multistyle=adapter.adapt(feature(flat,ends),{styleLike:styles,styleMode:'parts',singleStyleLinePack:true,directFeatureGpuJoin:true,gpuJoinSolidLine:true,directLineBuffer:true});
assert.equal(multistyle.singleStylePackedLine,false);assert.equal(multistyle.geometries.length,2);
const projected=adapter.adapt(feature(flat,ends),{styleLike:stroke,styleMode:'parts',singleStyleLinePack:true,directFeatureGpuJoin:true,gpuJoinSolidLine:true,directLineBuffer:true,sourceProjection:'EPSG:4326',targetProjection:'EPSG:3857',coordinateTransform:([x,y])=>[x*2,y*2]});
assert.equal(projected.singleStylePackedLine,false);assert.equal(projected.geometries[0].directGpuJoin,undefined);
const flatMode=adapter.adapt(feature(flat,ends),{styleLike:stroke,styleMode:'parts',singleStyleLinePack:true,directFeatureGpuJoin:true,gpuJoinSolidLine:true,directLineBuffer:true,flatCoordinatesGpuLine:true});
assert.equal(flatMode.geometries[0].flatGpu,true);assert.equal(flatMode.geometries[0].directGpuJoin,undefined);
console.log('PASS direct MVT ends/stride/order, byte-exact 8-float records, duplicate fallback, multi-style/projection/Flat V2 safe fallback');
