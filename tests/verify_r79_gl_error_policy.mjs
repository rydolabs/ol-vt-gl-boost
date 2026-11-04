import assert from 'node:assert/strict';
import {WebGL1Backend} from '../src/gl/backend.js';
import {createBoostMapClass} from '../src/ol/BoostMap.js';

function fakeCanvas(){
  const calls={getError:0,flush:0,finish:0,returned:0};
  const gl={
    COLOR_BUFFER_BIT:0x4000,DEPTH_BUFFER_BIT:0x0100,BLEND:0x0BE2,
    ONE:1,ONE_MINUS_SRC_ALPHA:0x0303,NO_ERROR:0,
    getExtension:name=>name==='ANGLE_instanced_arrays'?{}:null,
    viewport(){},clearColor(){},clear(){},enable(){},blendFunc(){},
    flush(){calls.flush++},
    finish(){calls.finish++},
    getError(){calls.getError++;return calls.returned}
  };
  return {calls,gl,canvas:{width:512,height:512,getContext:()=>gl}};
}
const a=fakeCanvas(),strict=new WebGL1Backend(a.canvas);
assert.equal(strict.glErrorCheckMode,'strict','legacy backend must stay fail-closed');
strict.beginFrame();
let stats=strict.endFrame();
assert.equal(stats.glErrorChecked,true);
assert.equal(stats.glError,0);
assert.equal(a.calls.flush,1);
assert.equal(a.calls.getError,1);
a.calls.returned=0x0500;
stats=strict.endFrame();
assert.equal(stats.glError,0x0500,'strict mode propagates GL error for scene fallback');
assert.equal(a.calls.getError,2);

const b=fakeCanvas(),fast=new WebGL1Backend(b.canvas,{glErrorCheckMode:'nonblocking'});
assert.equal(fast.glErrorCheckMode,'nonblocking');
for(let i=0;i<200;i++){
  fast.beginFrame();
  stats=fast.endFrame();
  assert.equal(stats.glErrorChecked,false);
  assert.equal(stats.glError,null,'unchecked is not equivalent to NO_ERROR');
}
assert.equal(b.calls.flush,200);
assert.equal(b.calls.getError,0,'no hidden GL error call in 200 hot frames');
assert.equal(fast.checkGlError(),0,'explicit diagnostic remains available');
assert.equal(b.calls.getError,1);
b.calls.returned=0x0502;
assert.equal(fast.checkGlError(),0x0502,'explicit diagnostics still discover GL errors');
fast.restoreContext();
stats=fast.endFrame();
assert.equal(fast.glErrorCheckMode,'nonblocking','restore retains error policy');
assert.equal(stats.glError,null);
assert.equal(stats.glErrorChecked,false);
assert.equal(b.calls.getError,2);

const blocking=fakeCanvas();
const strictBlocking=new WebGL1Backend(blocking.canvas,{gpuCompletionMode:'blocking'});
strictBlocking.endFrame();
assert.equal(blocking.calls.finish,1);
assert.equal(blocking.calls.getError,1);
for(const option of ['disabled','off',false,null,'']){
 assert.throws(()=>new WebGL1Backend(fakeCanvas().canvas,{glErrorCheckMode:option}),/Unsupported GL error check mode/);
}

class FakeLayer{
 constructor(){this.style_={'stroke-color':'#336699','stroke-width':2};
 this.hitDetectionDisabled_=true;this.source={getTile(){},getSourceTiles(){},getTileGrid(){},getOverlaps(){}};}
 getSource(){return this.source;}
 on(){} un(){}
}
class FakeMap{
 constructor({target=null,layers=[]}={}){
 this.target=target;this.layers=layers;this.handlers=new globalThis.Map();
 this.viewport={ownerDocument:{createElement:()=>({style:{},remove(){}})},
 classList:{add(){},remove(){}},appendChild(){}};
 }
 on(k,cb){this.handlers.set(k,cb)}
 un(k){this.handlers.delete(k)}
 setTarget(target){this.target=target;this.handlers.get('change:target')?.();}
 getTargetElement(){return this.target?{}:null}
 getViewport(){return this.viewport}
 getAllLayers(){return this.layers}
 render(){}
 disposeInternal(){}
}
const constructed=[];
const Map=createBoostMapClass({
 MapBase:FakeMap,LayerBase:FakeLayer,
 createCanvas:()=>({style:{}}),
 createBoost:options=>{
  constructed.push(options);
  return {start(){},destroy(){},sync(){}};
 }
});
const one=new Map({target:'map',layers:[new FakeLayer()]});
assert.equal(one.getBoostStatus().enabled,true);
assert.equal(constructed.at(-1).backendOptions.glErrorCheckMode,'nonblocking');
one.disableBoost();

const debug=new Map({
 target:'map',layers:[new FakeLayer()],
 boostOptions:{backendOptions:{glErrorCheckMode:'strict',profileTiming:true}}
});
assert.equal(debug.getBoostStatus().enabled,true);
assert.equal(constructed.at(-1).backendOptions.glErrorCheckMode,'strict');
assert.equal(constructed.at(-1).backendOptions.profileTiming,true);
debug.disableBoost();
console.log('R79_NONBLOCKING_GL_STRICT_DEFAULT_200_FRAMES_AND_BOOSTMAP_OVERRIDE_PASS');
