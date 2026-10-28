import assert from 'node:assert/strict';
import {OlExclusiveVectorTileRenderHost} from '../src/ol/OlExclusiveVectorTileRenderHost.js';
import {OLVectorTileBoost,DirectM5SceneBinding} from '../src/index.js';
const handlers=new Map(),events=[];
const projection={getCode:()=> 'R73'};
const view={getProjection:()=>projection,getResolution:()=>64,calculateExtent:()=>[0,0,128,128]};
const map={getView:()=>view,getSize:()=>[512,512],
  on:(event,fn)=>{handlers.set(event,fn);return {unlisten:()=>handlers.delete(event)};},
  un:(event,fn)=>{if(handlers.get(event)===fn)handlers.delete(event);}};
const grid={getZForResolution:()=>0,getTileRangeForExtentAndZ:()=>({minX:0,maxX:1,minY:0,maxY:1}),
  getFullTileRange:()=>({minX:0,maxX:1,minY:0,maxY:1})};
const source={getTileGrid:()=>grid,getWrapX:()=>false,
  getTile:(z,x,y)=>{events.push('tile:'+x+','+y);return {z,x,y};},
  getSourceTiles:(resolution,proj,tile)=>{assert.equal(resolution,64);assert.equal(proj,projection);return [tile];}};
const prototype={render(){events.push('stock');return 'stock-result';}};
const layer=Object.create(prototype);layer.getSource=()=>source;layer.getVisible=()=>true;
const original=layer.render;
const host=new OlExclusiveVectorTileRenderHost({map,layers:[layer]});
assert.equal(layer.render(),'stock-result');
host.start();
assert.equal(layer.render(),null);
assert.equal(host.snapshot().suppressedDraws,1);
assert.equal(host.prime(),4);
assert.equal(events.filter(x=>x.startsWith('tile:')).length,4);
handlers.get('postrender')({frameState:{size:[512,512],extent:[0,0,128,128],viewState:{resolution:64,projection}}});
assert.equal(host.snapshot().tileRequests,4);
host.stop();
assert.equal(layer.render,original);
assert.equal(Object.prototype.hasOwnProperty.call(layer,'render'),false);
assert.equal(layer.render(),'stock-result');
assert.equal(handlers.size,0);
assert.equal(host.snapshot().restored,true);
host.start().stop();
// Sparse vector tile sources must not instantiate empty render tiles for
// coordinates that their own OL tile URL function cannot resolve.
const sparseTiles=[];let revision=1;
const sparseSource={...source,getRevision:()=>revision,
  getTileUrlFunction:()=>([z,x,y])=>x===1&&y===0?'tile/1/0':undefined,
  getTile:(z,x,y)=>{sparseTiles.push([z,x,y]);return {z,x,y};}};
const sparseLayer=Object.create(prototype);sparseLayer.getSource=()=>sparseSource;
sparseLayer.getVisible=()=>true;
const sparseHost=new OlExclusiveVectorTileRenderHost({map,layers:[sparseLayer]});
sparseHost.start();
assert.equal(sparseHost.prime(),1);
assert.deepEqual(sparseTiles,[[0,1,0]]);
handlers.get('change:size')();
assert.equal(sparseHost.snapshot().tileRequests,1);
assert.equal(sparseTiles.length,1);
revision++;
handlers.get('change:size')();
assert.equal(sparseHost.snapshot().tileRequests,2);
assert.equal(sparseTiles.length,2);
sparseHost.stop();
const unsafe=Object.create(prototype);unsafe.getSource=()=>source;unsafe.render=()=>42;
assert.throws(()=>new OlExclusiveVectorTileRenderHost({map,layers:[unsafe]}).start(),/cannot safely intercept/);
let tree=[layer];
const dynamicHost=new OlExclusiveVectorTileRenderHost({map,layers:[layer],getLayers:()=>tree});
dynamicHost.start();
tree=[layer,sparseLayer];
handlers.get('postrender')({frameState:{size:[512,512],extent:[0,0,128,128],viewState:{resolution:64,projection}}});
assert.equal(dynamicHost.active,false,'Unexpected OL layer requires fail-closed stock fallback');
assert.equal(layer.render,original,'Dynamic layer change restores stock render method');
assert.equal(handlers.size,0,'Dynamic layer change must remove listeners');
const badModeMap={...map};
assert.throws(()=>new OLVectorTileBoost({map:badModeMap,backend:{canvas:{width:64,height:64,style:{}},gl:{}},stockOlRenderMode:'unsupported'}),/Unsupported stockOlRenderMode/);
const emptyMap={...map,getLayerGroup:()=>({getLayers:()=>({getArray:()=>[]})}),render:()=>{}};
const emptyCanvas={width:64,height:64,style:{display:''}};
const emptyBoost=new OLVectorTileBoost({map:emptyMap,backend:{canvas:emptyCanvas,gl:{}},stockOlRenderMode:'exclusive'});
assert.equal(emptyBoost.scene.bridge.pipeline.tileScissorEnabled,true,'Public exclusive mode must enable tile scissor by default');
assert.throws(()=>emptyBoost.start({renderSync:false}),/vector-tile layers/);
assert.equal(emptyBoost.failed,true);
assert.equal(emptyCanvas.style.display,'none','Unsafe exclusive initialization hides the overlay');
assert.equal(emptyBoost.started,false,'Unsafe exclusive initialization stops optimized scene');

const sharedGrid={};const sharedProjection={};
const stableState=()=>({source:{getTileGrid:()=>sharedGrid,getProjection:()=>sharedProjection}});
const candidate={vectorTileOptions:{isolatedTileFboFastPath:true,olLayerFboComposition:true},
  bridge:{pipeline:{tileScissorEnabled:true}},layers:new Map([['one',stableState()],['two',stableState()]])};
const entry=(layer,coord,offset=0)=>({tileKey:layer+'::'+coord,worldOffsetX:offset});
const disjoint=[entry('a','0/0/0'),entry('a','0/0/0'),entry('b','0/1/0')];
const frame={viewState:{rotation:0}};
const safe=DirectM5SceneBinding.prototype.canSkipDisjointLayerFbo;
assert.equal(safe.call(candidate,disjoint,frame),true,'Disjoint scissored tile domains can safely bypass FBO');
assert.equal(safe.call(candidate,[entry('a','0/0/0'),entry('b','0/0/0')],frame),false,'Overlapping layer domains MUST retain FBO');
assert.equal(safe.call(candidate,[entry('a','0/0/0'),entry('b','1/1/0')],frame),false,'Mixed zooms MUST retain FBO');
assert.equal(safe.call(candidate,[entry('a','0/0/0'),entry('b','0/1/0',100)],frame),false,'Wrapped worlds MUST retain FBO');
assert.equal(safe.call(candidate,disjoint,{viewState:{rotation:0.3}}),false,'Rotation MUST retain FBO');
const second=candidate.layers.get('two');
const originalSource=second.source;
second.source={getTileGrid:()=>({}),getProjection:()=>sharedProjection};
assert.equal(safe.call(candidate,disjoint,frame),false,'Mismatched tile grids MUST retain FBO');
second.source=originalSource;
candidate.vectorTileOptions.coordinateTransform=()=>{};
assert.equal(safe.call(candidate,disjoint,frame),false,'Coordinate warps MUST retain FBO');
delete candidate.vectorTileOptions.coordinateTransform;
candidate.bridge.pipeline.tileScissorEnabled=false;
assert.equal(safe.call(candidate,disjoint,frame),false,'Missing tile scissor MUST retain FBO');
candidate.bridge.pipeline.tileScissorEnabled=true;
candidate.vectorTileOptions.isolatedTileFboFastPath=false;
assert.equal(safe.call(candidate,disjoint,frame),false,'Fast path must remain opt-in');
console.log('R73_EXCLUSIVE_OL_RENDERER_CONTRACT_PASS: tile priming, suppressed GPU, exact method restoration, fail-closed');
