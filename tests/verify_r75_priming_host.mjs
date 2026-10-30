import assert from 'node:assert/strict';
import {OlExclusiveVectorTileRenderHost} from '../src/ol/OlExclusiveVectorTileRenderHost.js';

let tick=0,revision=1,urlChecks=0,renderTiles=0,sourceTiles=0;
const handlers=new Map();
const projection={getCode:()=> 'EPSG:3857'};
const view={getProjection:()=>projection,getResolution:()=>8,calculateExtent:()=>[0,0,200,200]};
const map={getView:()=>view,getSize:()=>[200,200],on:(name,fn)=>{handlers.set(name,fn);},
  un:(name)=>handlers.delete(name)};
const grid={getZForResolution:()=>3,getTileRangeForExtentAndZ:()=>({minX:0,maxX:1,minY:0,maxY:1}),
  getFullTileRange:()=>({minX:0,maxX:1,minY:0,maxY:1})};
const source={getTileGrid:()=>grid,getWrapX:()=>false,getRevision:()=>revision,
  getTileUrlFunction:()=>coord=>{urlChecks++;return coord[1]===1&&coord[2]===1?undefined:'tile';},
  getTile:(z,x,y)=>{renderTiles++;return {z,x,y};},
  getSourceTiles:(_,__,tile)=>{sourceTiles++;return [tile];}};
const proto={render(){return 'stock';}};
const layer=Object.create(proto);layer.getSource=()=>source;layer.getVisible=()=>true;
const host=new OlExclusiveVectorTileRenderHost({map,layers:[layer],profilePriming:true,now:()=>++tick});
assert.equal(host.snapshot().priming.calls,0);
host.start();
assert.equal(host.prime(),3);
assert.equal(host.prime(),0,'unchanged frame must skip expensive source enumeration');
let snap=host.snapshot();
assert.equal(snap.priming.calls,2);
assert.equal(snap.priming.visited,4);
assert.equal(snap.priming.urlRejected,1);
assert.equal(snap.priming.requested,3);
assert.equal(snap.priming.cacheHits,1);
assert.equal(snap.priming.getTileMs,3);
assert.equal(snap.priming.getSourceTilesMs,3);
assert.equal(snap.priming.tileUrlMs,4);
assert.equal(snap.tileRequests,3);
assert.equal(snap.lastPrime.requested,0);
assert.equal(urlChecks,4);assert.equal(renderTiles,3);assert.equal(sourceTiles,3);
revision++;
assert.equal(host.prime(),3,'revision bump invalidates priming cache');
assert.equal(host.snapshot().priming.calls,3);
assert.equal(host.snapshot().priming.requested,6);
host.stop();
assert.equal(layer.render(),'stock');
assert.equal(handlers.size,0);
host.start();
assert.equal(host.prime(),3,'stop/restart invalidates viewport cache');
host.stop();
// Instrumentation disabled by default: no timing attributes, no clock sampling.
const plain=new OlExclusiveVectorTileRenderHost({map,layers:[layer],now:()=>{throw Error('Unexpected clock call');}});
plain.start();assert.equal(plain.prime(),3);assert.equal(plain.prime(),0);
assert.equal('priming' in plain.snapshot(),false);
plain.stop();
// A throwing source must still update observed sample without swallowing the exception.
const broken={...source,getSourceTiles:()=>{throw Error('failed tile loader');}};
const brokenLayer=Object.create(proto);brokenLayer.getSource=()=>broken;brokenLayer.getVisible=()=>true;
const failed=new OlExclusiveVectorTileRenderHost({map,layers:[brokenLayer],profilePriming:true,now:()=>++tick});
failed.start();assert.throws(()=>failed.prime(),/failed tile loader/);
assert.equal(failed.snapshot().priming.calls,1);
failed.stop();
console.log('R75_PRIMING_PROFILE_HOST_PASS: opt-in timings, cache hit, revision, restart, failure');
