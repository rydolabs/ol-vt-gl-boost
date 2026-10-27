/** Rendering-first parity gate for the OL RenderFeature direct packed Line path.
 * Identical real MVT features -> byte-exact GPU instance streams and GL draw
 * sequence vs the old neutral-geometry pipeline. Synthetic stride/parts tests.
 * FakeGL verifies commands, not final hardware pixels.
 */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
import {OlVectorTileFeatureAdapter} from '../src/ol/OlVectorTileFeatureAdapter.js';
import {OlVectorTileSourceAdapter} from '../src/ol/OlVectorTileSourceAdapter.js';
import {packRenderFeatureLineInstances} from '../src/tile/RenderFeatureLinePacker.js';
import {NeutralGeometryCompiler} from '../src/tile/NeutralGeometryCompiler.js';
import {RendererFeatureSink} from '../src/compat/RendererFeatureSink.js';
import {toRendererStyle} from '../src/ol/OlStyleAdapter.js';
import {LineRenderer,createLineInstanceDataFromGeometry} from '../src/gl/LineRenderer.js';
import {ResourceManager} from '../src/gl/ResourceManager.js';
import {RenderSchedule} from '../src/compat/core/schedule.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const styles=[{'stroke-color':'#b45157','stroke-width':1},{'stroke-color':'#3a7898','stroke-width':2},{'stroke-color':'#679a4d','stroke-width':3},{'stroke-color':'#9b7542','stroke-width':4}];
const tiles=[[3492,1586],[3492,1587],[3493,1586],[3493,1587]];
const fixtures=[];
for(const [x,y] of tiles){
  const tileKey=`12/${x}/${y}`;
  const features=new MVT({layers:['road']}).readFeatures(readFileSync(path.join(root,'fixtures/seoul/12',String(x),`${y}.pbf`))).slice(0,32);
  assert.equal(features.length,32);fixtures.push({tileKey,features});
}
const adapter=new OlVectorTileFeatureAdapter();
const n=()=>{};
function fakeBackend(){
  const stats={draws:[],stroke:null,world:0,uploads:0,uploadBytes:0};
  const gl={ARRAY_BUFFER:34962,ELEMENT_ARRAY_BUFFER:34963,STATIC_DRAW:35044,TRIANGLES:4,UNSIGNED_SHORT:5123,TEXTURE0:33984,TEXTURE_2D:3553,createBuffer:()=>({}),deleteBuffer:n,activeTexture:n};
  return {stats,gl,canvas:{width:768,height:768},bindBuffer:n,bufferData:n,program:()=>({program:{}}),useProgram:n,disableAllAttribs:n,bindFloatAttrib:n,uniform:(_p,k)=>k,
    uniformMatrix4fv:n,uniform2f:n,uniform1f:(k,v)=>{if(k==='u_worldOffsetX')stats.world=v;},uniform1i:n,
    uniform4fv:(k,v)=>{if(k==='u_strokeColor')stats.stroke=[...v];},uniform1fv:n,bindTexture:n,
    drawElementsInstanced(_mode,count,_type,off,instances){stats.draws.push([count,off,instances,stats.stroke,stats.world]);},
    createBufferResource(_target,len){return {bytes:new Uint8Array(len)};},deleteBufferResource:n,
    uploadBufferResource(_target,b,off,data){const bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);b.bytes.set(bytes,off);stats.uploads++;stats.uploadBytes+=bytes.byteLength;}
  };
}
function build(direct){
 const compiler=new NeutralGeometryCompiler(),geometries=new Map(),styleIds=new Map(),stylesById=new Map();let id=0,refs=[];
 const renderer={
   upsertGeometry(key,g){geometries.set(key,{...g,id:key,version:1});return key;},
   internStyle(style){const k=JSON.stringify(style);if(!styleIds.has(k)){styleIds.set(k,++id);stylesById.set(id,style);}return styleIds.get(k);},
   setReferences(r){refs=r.map(x=>({...x,sceneLayerKey:'road',sceneLayerZIndex:0,sceneLayerSequence:0,sceneWorldOffsetX:0}));}
 };
 const sink=new RendererFeatureSink({renderer,geometryCompiler:compiler,styleCompiler:toRendererStyle});
 const inputs=fixtures.flatMap(({tileKey,features})=>features.map(f=>adapter.adapt(f,{tileKey,styleLike:styles,styleMode:'stack',directLineBuffer:direct})));
 if(direct){
   assert.equal(inputs.length,128);assert.ok(inputs.every(f=>f.geometries.length===1&&f.geometries[0].directLineBuffer));
   for(const f of inputs){assert.equal(f.geometries[0].instanceData.length,f.geometries[0].instanceCount*8);}
 }
 sink.replaceFeatures(inputs);
 assert.equal(geometries.size,128);assert.equal(refs.length,512);
 const backend=fakeBackend(),rm=new ResourceManager({backend}),styleStore={get:k=>stylesById.get(k)};
 const line=new LineRenderer({bounds:{minLon:126,minLat:36,maxLon:128,maxLat:39}});
 line.prepare(backend,[...geometries.values()],refs,styleStore,rm);
 assert.ok(line.resource.packedLineScene);assert.ok(line.resource.drawStream);
 const schedule=new RenderSchedule().build(refs);
 for(const l of schedule){if(l.passes.line.length)line.draw(backend,l.passes.line,{frame:{pixelRatio:1,size:[768,768],clipMatrix:new Float32Array(16)}});}
 const stream=rm.getStream('line.drawInstances');
 const groups=[...line.resource.drawStream.batches.values()].map(g=>({key:g.key,styleId:g.styleId,count:g.instanceCount,bytes:[...stream.resources.get(g.key).payload]}));
 for(const r of stream.resources.values()) assert.deepEqual(stream.gpuBuffer.bytes.subarray(r.allocation.offset,r.allocation.offset+r.payload.length),r.payload);
 return {geometries,refs,line,rm,backend,groups,draws:backend.stats.draws,sink,inputs};
}
const legacy=build(false), direct=build(true);
assert.deepEqual(direct.groups,legacy.groups,'GPU Line instance data must be byte exact for every style draw group');
assert.deepEqual(direct.draws,legacy.draws,'GPU draw command order and uniform values must match');
assert.equal(direct.draws.length,4);
let count=0;let segments=0;let floatCount=0;
for(const {tileKey,features} of fixtures)for(const feature of features){
  const a=adapter.adapt(feature,{tileKey,styleLike:styles,styleMode:'stack',directLineBuffer:false});
  const flat=feature.getFlatCoordinates(),type=feature.getType(),stride=feature.getStride?.()||2;
  const result=packRenderFeatureLineInstances(flat,type==='MultiLineString'?feature.getEnds():null,stride);
  const old=createLineInstanceDataFromGeometry({paths:a.geometries.map(g=>g.coordinates)});
  assert.deepEqual(result.instanceData,old.instanceData,'each real feature must match old CPU writer float-for-float');
  segments+=result.instanceCount;floatCount+=result.instanceData.length;count++;
}
assert.equal(count,128);
function synthetic(flat,ends,stride){
  const actual=packRenderFeatureLineInstances(flat,ends,stride);
  let start=0;const paths=[];
  for(const stop of ends||[flat.length]){const path=[];for(let i=start;i<stop;i+=stride)path.push([flat[i],flat[i+1]]);paths.push(path);start=stop;}
  const old=createLineInstanceDataFromGeometry({paths});
  assert.deepEqual(actual.instanceData,old.instanceData);
  assert.equal(actual.instanceCount,old.instanceCount);
}
synthetic(new Float64Array([0,0,8,1,10,10,9,4,7,-2]),null,2);
synthetic([0,0,0,1,0,0,5,5,0,7,5,0,9,2,0,0,0,0], [3,3,12,18],3);
synthetic([0,0,1,1,1,1,3,3,5,5,8,8],[8,12],2);
synthetic([],[],2);
assert.throws(()=>packRenderFeatureLineInstances([0,0,1,1],[3],2),/ends/);
// Transform and per-part-style semantics must remain on the original adapter.
const first=fixtures[0].features[0];
assert.ok(adapter.adapt(first,{tileKey:'T',styleLike:styles,styleMode:'parts',directLineBuffer:true}).geometries.every(g=>g.directLineBuffer),'parts mode now uses flat coordinates directly, with individual part style semantics');
assert.ok(adapter.adapt(first,{tileKey:'T',styleLike:styles,styleMode:'stack',directLineBuffer:true,sourceProjection:'EPSG:4326',targetProjection:'EPSG:3857',coordinateTransform:([x,y])=>[x+5,y+5]}).geometries.every(g=>!g.directLineBuffer));
// Production source adapter must opt into direct buffers by default for stack styles.
let captured=null;
const t={getTileCoord:()=>[12,3492,1586],getFeatures:()=>fixtures[0].features};
const source={getProjection:()=> 'EPSG:3857',getTileGrid:()=>({getTileCoordExtent:()=>[0,0,100,100]})};
const bridge=new OlVectorTileSourceAdapter({source,sink:{replaceTile:(_key,fs)=>{captured=fs;}},styleLike:styles,styleArrayMode:'stack'});
bridge.ingestTile(t);
assert.equal(captured.length,32);assert.ok(captured.every(f=>f.geometries[0].directLineBuffer));
// Direct Geometry owns its prepacked Float32Array: no additional CPU repack at LineRenderer.
for(const [k,g] of direct.geometries){
 const original=direct.inputs.find(f=>k.startsWith(f.key+'#'));
 assert.ok(original);
 assert.strictEqual(g.instanceData,original.geometries[0].instanceData);
 assert.strictEqual(direct.line._instances(g).instanceData,g.instanceData);
}
// A change to one feature must still produce the same stream as fresh preparation.
const k=direct.geometries.keys().next().value, g=direct.geometries.get(k);
const updated={...g,version:2,instanceData:g.instanceData.slice()};updated.instanceData[0]+=0.125;
direct.geometries.set(k,updated);
direct.line.updateGeometry(direct.backend,updated);
direct.line.updateReferences(direct.backend,direct.refs,direct.line.resource.styleStore);
const changedPayloads=[...direct.rm.getStream('line.drawInstances').resources].map(([key,r])=>[key,[...r.payload]]);
const freshBackend=fakeBackend(),freshRm=new ResourceManager({backend:freshBackend});
const freshLine=new LineRenderer({bounds:{minLon:126,minLat:36,maxLon:128,maxLat:39}});
freshLine.prepare(freshBackend,[...direct.geometries.values()],direct.refs,direct.line.resource.styleStore,freshRm);
assert.deepEqual(changedPayloads,[...freshRm.getStream('line.drawInstances').resources].map(([key,r])=>[key,[...r.payload]]));
const result={status:'PASS',case:'4 Seoul PBF tiles × 32 Road features × 4 styles',features:count,segments,floatCount,
  verified:{perFeatureFloat32Exact:true,drawStreamByteExact:true,drawCommandsAndUniformsExact:true,sourceIntegration:true,projectionFallback:true,perPartStyleFallback:true,customStrideAndDegenerates:true,geometryUpdate:true},
  gpuDrawCalls:direct.draws.length,streamBytes:direct.groups.reduce((sum,g)=>sum+g.bytes.length,0),
  limitation:'FakeGL command/byte parity only; no hardware GPU pixel parity claimed.'};
const out=process.argv.find(arg=>arg.startsWith('--out='))?.slice(6);if(out)writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log('DIRECT_RENDERFEATURE_RENDER_PARITY',JSON.stringify(result));
