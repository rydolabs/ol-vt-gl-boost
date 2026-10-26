/**
 * Workerless OpenLayers MVT RenderFeature input + existing M4 WebGL1 drawing.
 *
 * OpenLayers disable-worker design decisions retained here:
 *   - select the RenderFeature objects with a style-pass featureFilter;
 *   - classify directly from flatCoordinates/ends/stride;
 *   - execute buffer generation synchronously on the main thread;
 *   - upload the GPU-ready vertex/index/instance arrays without a Worker or
 *     MixedGeometryBatch, GeometryStore, or virtual path references.
 *
 * In contrast to the OL fork, this bridge does NOT allocate intermediate
 * RenderInstructions: the existing DirectFeature tile encoder writes the M4
 * vertex/index arrays and 8-float M4 GPU-join instances directly.
 *
 * The target renderer is the M4-derived WebGL1Backend/LineRenderer shaders in
 * this source tree. This is experimental and is NOT a drop-in replacement for
 * OpenLayers custom shader builders, icons, text, dash/pattern styles.
 */
import {DirectFeatureWebGLPipeline} from '../gl/pipeline.js';
import {OlVectorTileSourceAdapter} from './OlVectorTileSourceAdapter.js';
import {toNeutralFrame} from './frame.js';

const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const layerOf=(feature,key)=>{
  const properties=feature?.getProperties?.()||feature?.properties||{};
  return properties[key]??properties.layer??null;
};
function normalizePasses(passes){
  if(!Array.isArray(passes))throw new TypeError('stylePasses must be an array');
  return passes.map((pass,i)=>{
    if(!pass||typeof pass!=='object')throw new Error(`Invalid style pass ${i}`);
    // OL's low-level ShaderBuilder and WebGL attributes are different from
    // M4's shader contract; do not silently emit wrong pixels.
    if(pass.builder||pass.attributes||pass.uniforms||pass.shaders)
      throw new Error(`Style pass ${i} uses an unsupported custom WebGL shader`);
    if(pass.featureFilter!=null&&typeof pass.featureFilter!=='function')
      throw new Error(`featureFilter for style pass ${i} must be a function`);
    if(typeof pass.style!=='function'&&!own(pass,'style'))
      throw new Error(`Style pass ${i} must specify style`);
    return {name:pass.name||`pass-${i}`,featureFilter:pass.featureFilter||null,
      sourceLayer:pass.sourceLayer??null,style:pass.style,passOrder:i};
  });
}

/** Style filtering is intentionally a view onto original OL RenderFeatures. */
export function selectOLDisableWorkerFeatures(features,stylePasses,{layerProperty='layer',sourceLayerFilter=null}={}){
  const passes=normalizePasses(stylePasses);
  const selected=[];
  const counters={inputFeatures:features?.length||0,passes:passes.length,selectedFeatures:0,filteredFeatures:0};
  for(const pass of passes){
    // Pass-major iteration preserves the OL fill/stroke pass order. Reusing
    // geometry with two styles duplicates just metadata, not flat coordinates.
    for(const feature of features||[]){
      const layer=layerOf(feature,layerProperty);
      if(pass.sourceLayer!==null&&layer!==pass.sourceLayer){counters.filteredFeatures++;continue;}
      if(sourceLayerFilter&&sourceLayerFilter(layer,feature)===false){counters.filteredFeatures++;continue;}
      if(pass.featureFilter&&!pass.featureFilter(feature)){counters.filteredFeatures++;continue;}
      const style=typeof pass.style==='function'?pass.style(feature,layer):pass.style;
      if(style==null){counters.filteredFeatures++;continue;}
      selected.push({__olDisableWorkerEntry:true,feature,style,passOrder:pass.passOrder});
      counters.selectedFeatures++;
    }
  }
  return {entries:selected,counters};
}

export class OLDisableWorkerM4Bridge {
  constructor({backend,stylePasses=[],resourceManager=null,bounds,gpuArenaHeadroomFactor=1,layerProperty='layer',sourceLayerFilter=null}={}){
    if(!backend)throw new Error('OLDisableWorkerM4Bridge requires an M4 WebGL backend');
    this.backend=backend;
    this.stylePasses=normalizePasses(stylePasses);
    this.layerProperty=layerProperty;
    this.sourceLayerFilter=sourceLayerFilter;
    this.pipeline=new DirectFeatureWebGLPipeline(backend,{bounds,resourceManager,gpuArenaHeadroomFactor});
    this.tileStats=new Map();
  }
  get tiles(){return this.pipeline.tiles;}
  setStylePasses(passes){this.stylePasses=normalizePasses(passes);return this;}
  replaceRawTile(tileKey,features,options={}){
    if(options.coordinateTransform&&options.sourceProjection!==options.targetProjection)
      throw new Error('M4 workerless buffer path requires Feature coordinates in target projection');
    let source=features,stats;
    if(this.stylePasses.length){
      const chosen=selectOLDisableWorkerFeatures(features,this.stylePasses,{
        layerProperty:options.layerProperty||this.layerProperty,
        sourceLayerFilter:this.sourceLayerFilter,
      });
      source=chosen.entries;stats=chosen.counters;
    }else{
      stats={inputFeatures:features?.length||0,passes:0,selectedFeatures:features?.length||0,filteredFeatures:0};
    }
    // Transactionality is provided by DirectFeatureWebGLPipeline.replaceTile:
    // a failed encode/upload must not replace the previous successful tile.
    const result=this.pipeline.replaceRawTile(tileKey,source,{...options,
      layerProperty:options.layerProperty||this.layerProperty});
    this.tileStats.set(String(tileKey),{...stats,encodedBytes:result.byteLength,drawPackets:result.packets.length});
    return result;
  }
  replaceEncodedTile(tileKey,encoded,options={}){
    if(this.stylePasses.length)throw Error('Pooled precompiled tile cannot bypass style-pass feature selection');
    const result=this.pipeline.replaceEncodedTile(tileKey,encoded,options);
    this.tileStats.set(String(tileKey),{inputFeatures:options.featureCount??null,
      passes:0,selectedFeatures:options.featureCount??null,filteredFeatures:0,
      encodedBytes:result.byteLength,drawPackets:result.packets.length});
    return result;
  }
  /** Attach an OL source without the feature adapter or MixedGeometryBatch. */
  createSourceAdapter(source,options={}){
    // This adapter owns the just-created tile arrays and does not publish
    // mutable byte views. With a shared GPU arena we can hand them off rather
    // than copying them a second time. Explicit false preserves legacy API.
    return new OlVectorTileSourceAdapter({source,sink:this,maxInactiveTiles:0,
      layerProperty:this.layerProperty,
      transferGpuBuffers:!!this.pipeline.resourceManager,...options});
  }
  removeTile(tileKey){this.tileStats.delete(String(tileKey));return this.pipeline.removeTile(tileKey);}
  clear(){this.pipeline.clear();this.tileStats.clear();}
  draw(options={}){return this.pipeline.draw(options);}
  /** Existing OL frameState maps to the M4 backend's projection/uniforms. */
  renderFrame(frameState,{tiles=null,worldOffsetX=0,beginFrame=true,endFrame=true}={}){
    if(!frameState)throw new Error('OL frameState required');
    const frame=toNeutralFrame(frameState);
    if(beginFrame)this.backend.beginFrame();
    this.draw({frame,tiles,worldOffsetX});
    return endFrame?this.backend.endFrame():null;
  }
  restoreAfterContextLoss(backend=this.backend){this.backend=backend;return this.pipeline.restoreAfterContextLoss(backend);}
}
