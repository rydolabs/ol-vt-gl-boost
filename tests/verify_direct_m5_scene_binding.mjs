import assert from 'node:assert/strict';
import {DirectM5SceneBinding} from '../src/ol/scene.js';
import {OpenLayersRendererBinding} from '../src/compat/OpenLayersRendererBinding.js';
import {encodeDirectFeatureTile} from '../src/gl/pipeline.js';
import {readFileSync} from 'node:fs';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';

class Events {
  constructor(){this.listeners=new Map();}
  on(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);return {unlisten:()=>this.un(name,fn)};}
  un(name,fn){this.listeners.get(name)?.delete(fn);}
  emit(name,payload){for(const fn of [...(this.listeners.get(name)||[])])fn(payload);}
}
class Source extends Events{
  constructor(){super();this.projection={getCode:()=> 'EPSG:3857'};}
  getOverlaps(){return true;}
  getTile(){}
  getProjection(){return this.projection;}
  getTileGrid(){return {getTileCoordExtent:()=>[0,0,4096,4096],getZForResolution:()=>12,
    getTileRangeForExtentAndZ:()=>({minX:3492,maxX:3492,minY:1586,maxY:1586}),getFullTileRange:()=>null};}
}
class Layer extends Events{
  constructor(source,style,z){super();this.source=source;this.style=style;this.z=z;this.visible=true;this.opacity=1;}
  getSource(){return this.source;}getStyleFunction(){return this.style;}getVisible(){return this.visible;}
  getZIndex(){return this.z;}getOpacity(){return this.opacity;}
  setOpacity(value){this.opacity=value;this.emit('change:opacity',{});}
  setSource(source){this.source=source;this.emit('change:source',{});}
}
class Collection extends Events{constructor(layers){super();this.layers=layers;}getArray(){return this.layers;}}
class Group extends Events{constructor(layers){super();this.collection=new Collection(layers);}getLayers(){return this.collection;}}
class MapMock extends Events{
  constructor(root){super();this.root=root;this.renderCalls=0;this.projection={getCode:()=> 'EPSG:3857'};}
  getLayerGroup(){return this.root;}
  getView(){return {getProjection:()=>this.projection,getResolution:()=>1};}
  render(){this.renderCalls++;}renderSync(){this.renderCalls++;}
}
const frame={size:[512,512],pixelRatio:1,extent:[0,0,4096,4096],viewState:{center:[2048,2048],resolution:1,rotation:0,projection:{getCode:()=> 'EPSG:3857'}}};
const poly={getType:()=> 'Polygon',getFlatCoordinates:()=>new Float64Array([100,100,500,100,500,500,100,500,100,100]),getEnds:()=>[10],getStride:()=>2,getProperties:()=>({layer:'building'})};
const road={getType:()=> 'LineString',getFlatCoordinates:()=>new Float64Array([100,900,500,910,800,900]),getEnds:()=>[],getStride:()=>2,getProperties:()=>({layer:'road'})};
const sources=[new Source(),new Source()];
const roadStyle=(feature,resolution)=>{assert.equal(resolution,1);return {'stroke-color':'green','stroke-width':3};};
const buildStyle=(feature,resolution)=>{assert.equal(resolution,1);return {'fill-color':'rgba(255,0,0,0.5)'};};
const roadLayer=new Layer(sources[0],roadStyle,0),buildLayer=new Layer(sources[1],buildStyle,1);
const map=new MapMock(new Group([buildLayer,roadLayer]));
const logs={uploads:[],draws:[],created:0,deleted:0,begins:0,ends:0,colors:[],worlds:[]};
const gl={ARRAY_BUFFER:34962,ELEMENT_ARRAY_BUFFER:34963,TRIANGLES:4,POINTS:0,UNSIGNED_SHORT:5123,UNSIGNED_INT:5125};
const backend={gl,canvas:{width:512,height:512},supportsUint32ElementIndices:()=>true,
 createBufferResource:(target,size)=>({target,size,id:++logs.created}),
 uploadBufferResource:(target,buf,offset,data)=>{assert.equal(buf.target,target);logs.uploads.push([target,offset,data.byteLength]);},
 deleteBufferResource:()=>{logs.deleted++;},beginFrame(){logs.begins++;},endFrame(){logs.ends++;return {drawCalls:logs.draws.length,glError:0};},
 program:()=>({program:1}),useProgram(){},disableAllAttribs(){},bindBuffer(){},bindFloatAttrib(){},uniform:()=>0,
 uniformMatrix4fv(){},uniform2f(){},uniform1f(_,n){logs.worlds.push(n);},uniform1i(){},uniform4fv(_,c){logs.colors.push(c);},
 drawElements:(...args)=>logs.draws.push(['fill',...args]),drawElementsInstanced:(...args)=>logs.draws.push(['line',...args])
};
const binding=await OpenLayersRendererBinding.createDirectScene({map,backend});
assert.ok(binding instanceof DirectM5SceneBinding);
binding.start({renderSync:false});
const tile=(fs)=>({getTileCoord:()=>[12,3492,1586],getFeatures:()=>fs});
const tiles=[tile([road]),tile([poly])];
sources[0].emit('tileloadend',{tile:tiles[0]});sources[1].emit('tileloadend',{tile:tiles[1]});
assert.equal(binding.bridge.tiles.size,2,'unique source keys');
assert.ok([...binding.bridge.tiles.keys()].every(k=>k.includes('::12/3492/1586')));
assert.equal(binding.bridge.tileStats.size,2);
for(const [kind] of [['vertices'],['lineInstances']])assert.ok(binding.resourceManager.getStreamBuffer(`direct.feature.${kind}`));
map.emit('postrender',{frameState:frame});
assert.equal(logs.begins,1);assert.equal(logs.ends,1);
assert.deepEqual(logs.draws.map(x=>x[0]),['line','fill'],'scene zIndex order despite layer tree order');
assert.equal(binding.snapshot().drawPackets,2);
const before=binding.layers.get(binding.snapshot().layers.find(l=>l.zIndex===1).key).adapter.recompiledTiles;
buildLayer.setOpacity(0.3);
assert.ok(binding.layers.get(binding.snapshot().layers.find(l=>l.zIndex===1).key).adapter.recompiledTiles>before,'opacity change re-encodes affected tile');
const buildingKey=[...binding.bridge.tiles.keys()].find(k=>k.startsWith(binding.snapshot().layers.find(l=>l.zIndex===1).key+'::'));
const alpha=binding.bridge.tiles.get(buildingKey).packets[0].style.color[3];
assert.ok(Math.abs(alpha-0.15)<1e-6,'layer opacity applied to GPU style');
const nextStyle=()=>({'fill-color':'blue'});buildLayer.style=nextStyle;buildLayer.emit('change:style',{});
assert.deepEqual(binding.bridge.tiles.get(buildingKey).packets[0].style.color.slice(0,3),[0,0,1],'updated layer style');
buildLayer.visible=false;buildLayer.emit('change:visible',{});
assert.equal(binding.buildSchedule(frame).filter(x=>x.tileKey===buildingKey).length,0,'hidden layer must not draw');
buildLayer.visible=true;buildLayer.emit('change:visible',{});
const fresh=new Source();buildLayer.setSource(fresh);
assert.equal(binding.bridge.tiles.size,1,'old source tile released');
fresh.emit('tileloadend',{tile:tiles[1]});assert.equal(binding.bridge.tiles.size,2);
const oldUploads=logs.uploads.length;
map.emit('postrender',{frameState:frame});assert.equal(logs.begins,2);assert.ok(logs.uploads.length>=oldUploads);
// Metadata-only ordering: a different instance of the same source-world must
// not get a second GeometryStore or duplicate VBO.
const building=binding.snapshot().layers.find(l=>l.zIndex===1);
assert.equal(building.tileCount,1);
const key=building.key+'::12/3492/1586';
const beforeBuffers=logs.created;
binding.layers.get(building.key).worldInstances.set('12/3492/1586',new Set([0,1000]));
const schedule=binding.buildSchedule(frame,{prune:false});
assert.equal(schedule.filter(x=>x.tileKey===key).length,2);
assert.equal(logs.created,beforeBuffers);
// Explicit unsupported-layer rejection preserves the original binding.
const invalidLayer=new Layer({getFeatures(){}},()=>null,3);
map.root.collection.layers.push(invalidLayer);
assert.throws(()=>binding.sync(),/Unsupported non-vector-tile layer/);
map.root.collection.layers.pop();
binding.destroy();
assert.equal(binding.bridge.tiles.size,0);assert.equal(binding.layers.size,0);
// True OL MVT decoded fixture still reaches the same byte-accurate encoder.
const raw=readFileSync(new URL('./fixtures/seoul/12/3492/1586.pbf',import.meta.url));
const mvt=new MVT({layers:['building']}).readFeatures(raw);
const direct=encodeDirectFeatureTile(mvt,{styleFor:()=>({'fill-color':'rgba(210,194,169,0.52)'}),clipExtent:[0,0,4096,4096]});
assert.ok(direct.vertices.length>0&&direct.indices.length>0);
assert.throws(()=>encodeDirectFeatureTile([poly],{styleFor:()=>({'text-value':'should fail'})}),/cannot render text/);
console.log(JSON.stringify({pass:true,frames:2,sceneLayers:2,draws:logs.draws.length,
  uploadedCalls:logs.uploads.length,sourceRebind:true,opacity:true,
  realMVTFeatures:mvt.length,realMVTBytes:direct.byteLength}));
