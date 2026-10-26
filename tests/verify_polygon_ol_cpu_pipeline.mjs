import {fileURLToPath} from 'node:url';
/** Opt-in OL-style Ring grouping + Earcut simple path verification on real MVT. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
import {inflateEnds} from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/geom/flat/orient.js';
import {olPolygonEndss,polygonPartsOlOrientation} from '../src/ol/PolygonRingGrouping.js';
import {OlVectorTileFeatureAdapter} from '../src/ol/OlVectorTileFeatureAdapter.js';
import {NeutralGeometryCompiler} from '../src/tile/NeutralGeometryCompiler.js';
import {EarcutPolygonTriangulator} from '../src/tile/EarcutPolygonTriangulator.js';
const root=new URL('./fixtures/seoul/12/',import.meta.url);
const adapter=new OlVectorTileFeatureAdapter(),triangulator=new EarcutPolygonTriangulator();
const legacy=new NeutralGeometryCompiler({polygonTriangulator:triangulator,polygonClipPrecheck:true,polygonIndexedInside:true});
const ol=new NeutralGeometryCompiler({polygonTriangulator:triangulator,polygonClipPrecheck:true,polygonIndexedInside:true,polygonEarcutSimple:true});
const count={feature:0,rings:0,legacyParts:0,olParts:0,indexed:0,triangles:0,changedGeometry:0,changedBytes:0};
function triangles(geom){
 const positions=geom.data;const idx=geom.indices;const count=idx?idx.length:positions.length/2;
 assert.equal(count%3,0);
 let area=0;
 for(let i=0;i<count;i+=3){
  const vertices=[];
  for(let j=0;j<3;j++){
   const k=idx?idx[i+j]:i+j;
   assert(k>=0 && k*2+1<positions.length);
   const x=positions[k*2],y=positions[k*2+1];assert(Number.isFinite(x)&&Number.isFinite(y));
   vertices.push([x,y]);
  }
  const [a,b,c]=vertices;
  area+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
 }
 return {count:count/3,area};
}
for(const tile of ['3492/1586','3492/1587','3493/1586','3493/1587']){
 const path=fileURLToPath(new URL(`./fixtures/seoul/12/${tile}.pbf`,import.meta.url));
 const features=new MVT({layers:['building']}).readFeatures(readFileSync(path));
 for(const feature of features){
  const flat=feature.getFlatCoordinates(),ends=feature.getEnds(),stride=feature.getStride();
  const expected=inflateEnds(flat,ends),actual=olPolygonEndss(flat,ends,stride);
  assert.deepEqual(actual,expected,'OL 10.10.0 grouping must be bit-for-bit equivalent');
  const parts=polygonPartsOlOrientation(flat,ends,stride);
  assert.equal(parts.length,expected.length);
  // Source flat bytes and explicit closure are preserved ring for ring.
  for(let i=0;i<parts.length;i++)assert.equal(parts[i].length,expected[i].length);
  const options={tileKey:tile,clipExtent:[0,0,4096,4096],styleMode:'parts',styleLike:{'fill-color':'rgba(210,194,169,0.52)'}};
  const base=adapter.adapt(feature,options);
  const revised=adapter.adapt(feature,{...options,polygonOlRingGrouping:true});
  count.feature++;count.rings+=ends.length;count.legacyParts+=base.geometries.length;count.olParts+=revised.geometries.length;
  if(base.geometries.length!==revised.geometries.length)count.changedGeometry++;
  for(const neutral of revised.geometries){
   const oldGeom=legacy.compile(neutral),newGeom=ol.compile(neutral);
   if(newGeom.indices)count.indexed++;
   const a=triangles(oldGeom),b=triangles(newGeom);
   count.triangles+=b.count;
   // Comparing area is advisory, because clipped boundary triangles can have
   // different triangulations and rendering order; do not assert byte parity.
   if(oldGeom.data.byteLength!==newGeom.data.byteLength || oldGeom.indices?.byteLength!==newGeom.indices?.byteLength)count.changedBytes++;
   assert(Number.isFinite(a.area)&&Number.isFinite(b.area));
   // Same OL-grouped polygon: any area difference would be an algorithmic
   // regression even before browser rasterization. This does NOT prove pixels.
   assert(Math.abs(a.area-b.area)<=Math.max(0.001,1e-8*Math.max(a.area,b.area)),
     `Area mismatch on ${tile}, new ${b.area}, baseline ${a.area}`);
  }
 }
}
assert.equal(count.feature,5);assert.equal(count.rings,1721);assert.equal(count.legacyParts,1383);assert.equal(count.olParts,1384);
assert.equal(count.changedGeometry,1);
console.log(JSON.stringify({PASS:true,...count},null,2));
