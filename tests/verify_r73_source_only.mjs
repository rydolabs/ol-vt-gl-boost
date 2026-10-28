import assert from 'node:assert/strict';
import {OlStockRenderGate,OLVectorTileBoost} from '../src/index.js';
class MapMock {
  constructor(){this.handlers=new Map();this.renders=0;this.projection={code:'P'};}
  on(t,fn){if(!this.handlers.has(t))this.handlers.set(t,new Set());this.handlers.get(t).add(fn);return {unlisten:()=>this.un(t,fn)};}
  un(t,fn){this.handlers.get(t)?.delete(fn);}
  emit(t,v){for(const fn of [...(this.handlers.get(t)||[])])fn(v);}
  getView(){return {getProjection:()=>this.projection,getResolution:()=>1};}
  render(){this.renders++;}
}
const frameState={pixelRatio:1,viewState:{projection:{code:'P'}},extent:[0,0,64,64]};
const map=new MapMock();
class OriginalLayer {render(){this.actualDraws=(this.actualDraws||0)+1;return 'stock OL';}}
const layer=new OriginalLayer(),requests=[],loaded=[];
const source={
  getRevision:()=>source.rev||0,
  getTileUrlFunction:()=>coord=>coord[1]===0&&coord[2]===0?'tile':undefined,
  getTile:(z,x,y,pr,projection)=>{requests.push({z,x,y,pr,projection});return {z,x,y};},
  getSourceTiles:(pr,projection,tile)=>{loaded.push(tile);return [tile]}
};
const scene={started:true,layers:new Map([['x',{key:'x',layer,source,state:{visible:true},
  pruner:{activeInstances:()=>new Map([['0/0/0',new Set([0])],['0/1/0',new Set([0])]])}}]])};
const gate=new OlStockRenderGate({map,scene});
assert.equal(gate.start(),gate);assert.equal(gate.snapshot().active,true);
assert.equal(layer.render(),null);assert.equal(layer.actualDraws,undefined);
map.emit('postrender',{frameState});
assert.equal(requests.length,1);assert.equal(loaded.length,1);
map.emit('postrender',{frameState});
assert.equal(requests.length,1,'cache must prevent duplicate tile demand');
source.rev=1;map.emit('postrender',{frameState});
assert.equal(requests.length,2,'source refresh must reissue tile demand');
assert.equal(gate.snapshot().stockLayerDrawsSuppressed,1);
assert.equal(gate.stop(),gate);assert.equal(gate.snapshot().active,false);
assert.equal(Object.hasOwn(layer,'render'),false,'original inherited method descriptor restored');
assert.equal(layer.render(),'stock OL');assert.equal(layer.actualDraws,1);
assert.equal(map.handlers.get('postrender').size,0);
gate.start();scene.layers.clear();map.emit('postrender',{frameState});
assert.equal(Object.hasOwn(layer,'render'),false,'removed layer restored');gate.stop();
const failedLayer=new OriginalLayer();
const badSource={...source,getSourceTiles:()=>{throw Error('source error')}};
scene.layers.set('y',{key:'y',layer:failedLayer,source:badSource,
  state:{visible:true},pruner:{activeInstances:()=>new Map([['0/0/0',new Set([0])]])}});
let fault=null;const broken=new OlStockRenderGate({map,scene,onError:({error})=>fault=error});
broken.start();map.emit('postrender',{frameState});
assert.match(String(fault),/source error/);assert.equal(broken.active,false);
assert.equal(failedLayer.render(),'stock OL','fault must restore stock OL immediately');
assert.throws(()=>new OLVectorTileBoost({map:undefined}),/requires an OpenLayers map/);
// A scene-level GPU failure must release the gate even if the OL map has
// not been dismantled by a host callback. Stock OL is immediately restorable.
class FacadeMap extends MapMock {
  getLayerGroup(){return {getLayers:()=>({getArray:()=>[]})};}
}
const fm=new FacadeMap(),canvas={width:512,height:512,style:{display:'block'}};
let notified=null;
const host=new OLVectorTileBoost({map:fm,backend:{canvas,gl:{}},
  stockOlRenderMode:'source-only',onError:info=>notified=info});
host.start({renderSync:false});
assert.equal(host.sourceOnlyActive,true);
try{fm.emit('postrender',{frameState});}catch{}
assert.equal(host.failed,true);
assert.equal(host.sourceOnlyActive,false);
assert.equal(host.started,false);
assert.equal(canvas.style.display,'none');
assert(notified?.error instanceof Error,'scene error must be propagated to caller');
host.start({renderSync:false});
assert.equal(host.sourceOnlyActive,true);
assert.equal(canvas.style.display,'block','restart must restore original overlay style');
host.stop();
console.log('R73_SOURCE_ONLY_GATE_LIFECYCLE_PASS');
