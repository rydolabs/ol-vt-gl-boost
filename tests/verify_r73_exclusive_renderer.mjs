import assert from 'node:assert/strict';
import {OlExclusiveVectorTileRenderHost} from '../src/ol/OlExclusiveVectorTileRenderHost.js';
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
assert.equal(host.snapshot().tileRequests,8);
host.stop();
assert.equal(layer.render,original);
assert.equal(Object.prototype.hasOwnProperty.call(layer,'render'),false);
assert.equal(layer.render(),'stock-result');
assert.equal(handlers.size,0);
assert.equal(host.snapshot().restored,true);
host.start().stop();
// Sparse vector tile sources must not instantiate empty render tiles for
// coordinates that their own OL tile URL function cannot resolve.
const sparseTiles=[];
const sparseSource={...source,
  getTileUrlFunction:()=>([z,x,y])=>x===1&&y===0?'tile/1/0':undefined,
  getTile:(z,x,y)=>{sparseTiles.push([z,x,y]);return {z,x,y};}};
const sparseLayer=Object.create(prototype);sparseLayer.getSource=()=>sparseSource;
sparseLayer.getVisible=()=>true;
const sparseHost=new OlExclusiveVectorTileRenderHost({map,layers:[sparseLayer]});
sparseHost.start();
assert.equal(sparseHost.prime(),1);
assert.deepEqual(sparseTiles,[[0,1,0]]);
handlers.get('change:size')();
assert.equal(sparseHost.snapshot().tileRequests,2);
assert.equal(sparseTiles.length,2);
sparseHost.stop();
const unsafe=Object.create(prototype);unsafe.getSource=()=>source;unsafe.render=()=>42;
assert.throws(()=>new OlExclusiveVectorTileRenderHost({map,layers:[unsafe]}).start(),/cannot safely intercept/);
console.log('R73_EXCLUSIVE_OL_RENDERER_CONTRACT_PASS: tile priming, suppressed GPU, exact method restoration, fail-closed');
