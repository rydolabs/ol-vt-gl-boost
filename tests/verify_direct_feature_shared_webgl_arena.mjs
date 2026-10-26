import assert from 'node:assert/strict';
import {DirectFeatureWebGLPipeline} from '../src/gl/pipeline.js';
import {ResourceManager} from '../src/gl/ResourceManager.js';

const gl={ARRAY_BUFFER:34962,ELEMENT_ARRAY_BUFFER:34963,TRIANGLES:4,POINTS:0,UNSIGNED_SHORT:5123,UNSIGNED_INT:5125};
const created=[],freed=[],uploads=[],draws=[],pointers=[];
let next=0;
const backend={gl,canvas:{width:512,height:512},
  createBufferResource:(target,len)=>{const b={id:++next,target,len};created.push(b);return b;},
  uploadBufferResource(target,buffer,offset,data){assert.equal(buffer.target,target);assert.ok(offset>=0 && offset+data.byteLength<=buffer.len);uploads.push([buffer.id,offset,data.byteLength]);},
  deleteBufferResource(buf){if(buf)freed.push(buf.id);},supportsUint32ElementIndices:()=>true,
  program:()=>({program:1}),useProgram(){},disableAllAttribs(){},bindBuffer(){},
  bindFloatAttrib(c,name,n,stride,offset,divisor){pointers.push({name,offset});},
  uniform:()=>0,uniformMatrix4fv(){},uniform2f(){},uniform1f(){},uniform1i(){},uniform4fv(){},
  drawElements(mode,n,type,offset){draws.push({mode,n,type,offset});},
  drawElementsInstanced(mode,n,type,offset,instances){draws.push({mode,n,type,offset,instances});}
};
const f=(type,coords,ends,layer)=>({getType:()=>type,getFlatCoordinates:()=>new Float64Array(coords),getStride:()=>2,getEnds:()=>ends,getProperties:()=>({layer})});
const styleFor=(feature,layer)=>layer==='building'?{'fill-color':'red'}:layer==='road'?{'stroke-color':'blue','stroke-width':2}:{'circle-radius':5,'circle-fill-color':'yellow'};
const options={clipExtent:[0,0,4096,4096],styleFor};
const rm=new ResourceManager({backend});
const renderer=new DirectFeatureWebGLPipeline(backend,{resourceManager:rm});
const tileA=renderer.replaceRawTile('tile-A',[f('Polygon',[0,0,100,0,100,100,0,100,0,0],[10],'building'),f('LineString',[0,200,200,300,300,100],[],'road')],options);
const tileB=renderer.replaceRawTile('tile-B',[f('Polygon',[200,200,300,200,300,300,200,300,200,200],[10],'building'),f('MultiPoint',[500,500,700,600],[],'point')],options);
for(const name of ['vertices','indices']){
  const stream=`direct.feature.${name}`;
  const a=rm.getStreamRange(stream,'tile-A'),b=rm.getStreamRange(stream,'tile-B');
  assert.ok(a&&b);assert.notEqual(a.offset,b.offset);assert.ok(rm.getStreamBuffer(stream));
}
assert.equal(renderer.tiles.get('tile-A').buffers,null);
assert.equal(renderer.tiles.get('tile-B').buffers,null);
const frame={clipMatrix:new Float32Array([2/4096,0,0,0,0,2/4096,0,0,0,0,1,0,-1,-1,0,1]),pixelRatio:1,size:[512,512]};
renderer.draw({frame});
assert.ok(draws.length>=3);
const baseB=rm.getStreamRange('direct.feature.vertices','tile-B').offset;
assert.ok(pointers.some(p=>p.name==='a_pos'&&p.offset===baseB));
const indexB=rm.getStreamRange('direct.feature.indices','tile-B').offset;
assert.ok(draws.some(d=>d.offset===indexB));
assert.ok(renderer.removeTile('tile-A'));
assert.equal(rm.getStreamRange('direct.feature.vertices','tile-A'),null);
assert.ok(rm.getStreamRange('direct.feature.vertices','tile-B'));
const before=draws.length;renderer.draw({frame});assert.ok(draws.length>before);
renderer.clear();assert.equal(renderer.tiles.size,0);
assert.equal(rm.getStreamRange('direct.feature.vertices','tile-B'),null);
console.log(JSON.stringify({pass:true,sharedStreams:3,tileACount:tileA.packets.length,tileBCount:tileB.packets.length,gpuBuffersCreated:created.length,uploadCalls:uploads.length,drawCalls:draws.length,freed:freed.length}));
