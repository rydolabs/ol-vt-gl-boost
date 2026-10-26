import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
import {OlVectorTileFeatureAdapter} from '../src/ol/OlVectorTileFeatureAdapter.js';
import {createLineInstanceDataFromGeometry} from '../src/gl/LineRenderer.js';
const fixtures=join(dirname(fileURLToPath(import.meta.url)),'fixtures/seoul/12/3492/1586.pbf');
const fs=new MVT({layers:['road']}).readFeatures(readFileSync(fixtures)).slice(0,6);
const adapter=new OlVectorTileFeatureAdapter(),style=[{'stroke-color':'#ff0000','stroke-width':2}];
let paths=0,segments=0;
for(const f of fs){
 const legacy=adapter.adapt(f,{tileKey:'T',styleLike:style,styleMode:'parts',directLineBuffer:false});
 const direct=adapter.adapt(f,{tileKey:'T',styleLike:style,styleMode:'parts',directLineBuffer:true});
 assert.equal(direct.geometries.length,legacy.geometries.length);
 for(let k=0;k<direct.geometries.length;k++){
  const a=direct.geometries[k],b=legacy.geometries[k];
  assert.ok(a.directLineBuffer&&!a.coordinates&&!a.paths);
  const expected=createLineInstanceDataFromGeometry({coords:b.coordinates});
  assert.deepEqual(a.instanceData,expected.instanceData);
  assert.equal(a.instanceCount,expected.instanceCount);
  segments+=a.instanceCount;paths++;
 }
}
assert.ok(paths>0&&segments>0);
console.log('PASS real Seoul MVT six road features: direct parts mode byte-exact vs legacy geometry per path',{paths,segments});
