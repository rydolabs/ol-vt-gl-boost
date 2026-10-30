import assert from 'node:assert/strict';
import {DirectM5SceneBinding} from '../src/ol/scene.js';

function makeGl(name,{complete=true}={}){
  const log={createdFbo:[],createdTexture:[],deletedFbo:[],deletedTexture:[],framebufferBindings:[]};
  let id=0;
  const gl={FRAMEBUFFER:1,FRAMEBUFFER_COMPLETE:2,TEXTURE_2D:3,RGBA:4,UNSIGNED_BYTE:5,
    TEXTURE_MIN_FILTER:6,TEXTURE_MAG_FILTER:7,TEXTURE_WRAP_S:8,TEXTURE_WRAP_T:9,
    NEAREST:10,CLAMP_TO_EDGE:11,COLOR_ATTACHMENT0:12,TEXTURE0:13,
    COLOR_BUFFER_BIT:14,DEPTH_BUFFER_BIT:15,ARRAY_BUFFER:16,TRIANGLE_STRIP:17,
    createFramebuffer:()=>{const o={name,id:++id};log.createdFbo.push(o);return o;},
    createTexture:()=>{const o={name,id:++id};log.createdTexture.push(o);return o;},
    deleteFramebuffer:o=>log.deletedFbo.push(o),deleteTexture:o=>log.deletedTexture.push(o),
    bindFramebuffer:(_,o)=>log.framebufferBindings.push(o),
    bindTexture(){},texImage2D(){},texParameteri(){},framebufferTexture2D(){},
    checkFramebufferStatus:()=>complete?2:0,activeTexture(){},viewport(){},
    clearColor(){},clear(){}};
  return {gl,log};
}
function makeBackend(gl,log){return {gl,canvas:{width:512,height:512},
  program:()=>({program:'p'}),
  createBufferResource:()=>{const b={name:'quad'};log.buffers=(log.buffers||[]).concat(b);return b;},
  uploadBufferResource(){},deleteBufferResource:b=>{log.deletedBuffers=(log.deletedBuffers||[]).concat(b);},
  invalidateStateCache(){},disableAllAttribs(){},useProgram(){},bindBuffer(){},
  bindFloatAttrib(){},bindTexture(){},uniform:()=>0,uniform1i(){},drawArrays(){}};}
const first=makeGl('old'),backend=makeBackend(first.gl,first.log);
const target={backend,bridge:{pipeline:{draw(){}}},map:{render(){}},
  _releaseLayerComposition:DirectM5SceneBinding.prototype._releaseLayerComposition,
  _renderCompositedLayers:DirectM5SceneBinding.prototype._renderCompositedLayers};
const packets=[{tileKey:'layer-1::0/0/0'}];
target._renderCompositedLayers({},packets);
assert.equal(first.log.createdFbo.length,1);
assert.equal(first.log.buffers.length,1);
target._renderCompositedLayers({},packets);
assert.equal(first.log.createdFbo.length,1,'unchanged frame reuses FBO');
backend.canvas.width=1024;
target._renderCompositedLayers({},packets);
assert.equal(first.log.createdFbo.length,2,'resize allocates new RGBA8 FBO');
assert.equal(first.log.deletedFbo.length,1,'resize disposes old framebuffer');
assert.equal(first.log.deletedTexture.length,1,'resize disposes old texture');
assert.equal(first.log.buffers.length,1,'resize reuses fullscreen quad');
target._releaseLayerComposition();
assert.equal(first.log.deletedFbo.length,2);
assert.equal(first.log.deletedTexture.length,2);
assert.equal(first.log.deletedBuffers.length,1);
assert.equal(target._layerFbo,null);assert.equal(target._layerFboQuad,null);
target._releaseLayerComposition();
assert.equal(first.log.deletedFbo.length,2,'double-release is idempotent');
// Context restoration must discard stale JS handles *without* issuing GL
// deletion against the lost context. The next draw must allocate fresh handles.
target._renderCompositedLayers({},packets);
const oldFbo=target._layerFbo;
const second=makeGl('restored'),newBackend=makeBackend(second.gl,second.log);
newBackend.canvas.width=1024;
target.bridge.restoreAfterContextLoss=()=>7;
const restored=DirectM5SceneBinding.prototype.restoreAfterContextLoss.call(target,newBackend);
assert.equal(restored,7);
assert.equal(target._layerFbo,null);
assert.equal(target._layerFboQuad,null);
assert.equal(first.log.deletedFbo.length,2,'must not delete via lost context');
target._renderCompositedLayers({},packets);
assert.notEqual(target._layerFbo,oldFbo);
assert.equal(target._layerFbo.gl,second.gl);
assert.equal(second.log.createdFbo.length,1);
assert.equal(second.log.buffers.length,1);
target._releaseLayerComposition();
assert.equal(second.log.deletedFbo.length,1);
assert.equal(second.log.deletedBuffers.length,1);
// Framebuffer incompleteness fails closed without leaking either GL resource.
const incomplete=makeGl('incomplete',{complete:false});
target.backend=makeBackend(incomplete.gl,incomplete.log);
assert.throws(()=>target._renderCompositedLayers({},packets),/framebuffer incomplete/);
assert.equal(incomplete.log.deletedFbo.length,1);
assert.equal(incomplete.log.deletedTexture.length,1);
assert.equal(incomplete.log.framebufferBindings.at(-1),null);
assert.equal(target._layerFbo,null);
console.log('R75_LAYER_FBO_LIFECYCLE_PASS: reuse, resize, stop, restore, incomplete FBO cleanup');
