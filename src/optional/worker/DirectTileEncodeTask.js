/** Browser/Node worker-safe MVT -> OL RenderFeature -> direct GPU-typed streams.
 * No WebGL calls and no style callbacks cross the worker boundary.
 * Versioned task fields must be included in an application's geometry cache key.
 */
import MVT from '../../../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.worker.js';
import {encodeDirectFeatureTile} from '../../gl/pipeline.js';

const formats=new Map();
const formatFor=(layer)=>{
  let f=formats.get(layer);
  if(!f){f=new MVT({layers:[layer]});formats.set(layer,f);}
  return f;
};
const trim=(a)=>a.byteOffset===0&&a.byteLength===a.buffer.byteLength?a:a.slice();
const sharedFormats=new Map();
const formatForLayers=layers=>{
  const key=JSON.stringify(layers);
  let f=sharedFormats.get(key);
  if(!f){f=new MVT({layers});sharedFormats.set(key,f);}
  return f;
};
function configureEncoder(options){
  globalThis.__m5R29EarcutPartial=options.partialEarcut===true;
  globalThis.__m5R18PolygonStrokeUnclipped=options.unclipped!==false;
  globalThis.__m5R18FlatUnclippedStroke=options.unclipped!==false;
  globalThis.__m5R18ClosedRingJoin=options.closedLineJoins===true;
  globalThis.__m5R30ScissorFill=false;
  globalThis.__m5R30FastStrokeRing=false;
  globalThis.__m5R30EarcutPool=false;
}
function encodeFeatures(features,style,extent,options){
  const encodeStart=performance.now();
  const encoded=encodeDirectFeatureTile(features,{
    styleFor:()=>style,clipExtent:extent,
    drawMode:options.drawMode==='painter'?'painter':'style-pass',
    polygonStrokeFringePx:Number(options.polygonStrokeFringePx||0),
    closedLineJoins:options.closedLineJoins===true,
    polygonInsideSegmentFastPath:options.polygonInsideSegmentFastPath!==false,
    polygonEarBBoxPrecheck:options.polygonEarBBoxPrecheck!==false,
    stableStyleIdentityCache:true,
  });
  const encodeMs=performance.now()-encodeStart;
  for(const kind of ['vertices','indices','lineInstances'])encoded[kind]=trim(encoded[kind]);
  return {encoded,featureCount:features.length,encodeMs};
}

/** R34: Decode PBF once per unique tile, then encode each source layer in
 * requested painter order. The original single-layer task stays available.
 * Duplicate layer names are opt-in only for cloneable constant styles;
 * features are read-only to the encoder and reused in painter order.
 */
export function encodeTileLayerGroupTask(task){
  const {tileKey,layers,bytes,extent,options={}}=task||{};
  if(typeof tileKey!=='string'||!tileKey||!Array.isArray(layers)||!layers.length)
    throw Error('R34 group requires tileKey and nonempty layers array');
  const uniqueLayers=[...new Set(layers.map(x=>x.layer))];
  if(uniqueLayers.length!==layers.length && task.allowDuplicateLayers!==true)
    throw Error('R34 group requires unique source layers; use independent tasks for duplicates');
  if(!(bytes instanceof ArrayBuffer||ArrayBuffer.isView(bytes)))throw Error('R34 group requires PBF bytes');
  if(!Array.isArray(extent)||extent.length!==4||!extent.every(Number.isFinite))throw Error('Invalid tile extent');
  for(const {layer,style} of layers){
    if(typeof layer!=='string'||!layer||!style||typeof style!=='object'||Array.isArray(style))
      throw Error('R34 source layer and cloneable style required');
  }
  configureEncoder(options);
  const t0=performance.now();
  const features=formatForLayers(uniqueLayers).readFeatures(bytes,{extent});
  const decodeMs=performance.now()-t0;
  const wanted=new Map(uniqueLayers.map((layer,index)=>[layer,index]));
  const buckets=uniqueLayers.map(()=>[]);
  for(const feature of features){
    const index=wanted.get(feature.getProperties()?.layer);
    if(index!==undefined)buckets[index].push(feature);
  }
  const rows=[];const transfer=[];
  for(let i=0;i<layers.length;i++){
    const {encoded,featureCount,encodeMs}=encodeFeatures(buckets[wanted.get(layers[i].layer)],layers[i].style,extent,options);
    rows.push({tileKey,layer:layers[i].layer,encoded,featureCount,
      cpu:{decodeMs:0,encodeMs,bytes:encoded.byteLength}});
    transfer.push(encoded.vertices.buffer,encoded.indices.buffer,encoded.lineInstances.buffer);
  }
  return {tileKey,rows,featureCount:rows.reduce((n,row)=>n+row.featureCount,0),
    decodeCalls:1,cpu:{decodeMs,encodeMs:rows.reduce((n,row)=>n+row.cpu.encodeMs,0)},transfer};
}


export function encodeTileWorkerTask(task){
  const {tileKey,layer,bytes,extent,style,options={}}=task||{};
  if(typeof tileKey!=='string'||!tileKey||typeof layer!=='string'||!layer)
    throw Error('Worker tileKey and layer must be non-empty strings');
  if(!(bytes instanceof ArrayBuffer||ArrayBuffer.isView(bytes)))throw Error('Worker task requires PBF ArrayBuffer');
  if(!Array.isArray(extent)||extent.length!==4||!extent.every(Number.isFinite))throw Error('Worker task requires finite tile extent');
  if(!style||typeof style!=='object'||Array.isArray(style))throw Error('Worker task requires cloneable constant layer style');
  configureEncoder(options);
  const t0=performance.now();
  const features=formatFor(layer).readFeatures(bytes,{extent});
  const decodedMs=performance.now()-t0;
  const {encoded,featureCount,encodeMs}=encodeFeatures(features,style,extent,options);
  return {tileKey,layer,encoded,featureCount:features.length,
    cpu:{decodeMs:decodedMs,encodeMs,bytes:encoded.byteLength},
    transfer:[encoded.vertices.buffer,encoded.indices.buffer,encoded.lineInstances.buffer]};
}
