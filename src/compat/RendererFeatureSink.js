import { clipPolylineToExtent } from '../tile/clip.js';
import { NeutralGeometryCompiler } from '../tile/NeutralGeometryCompiler.js';

function scaleColorAlpha(color, opacity){
  if(!color)return color;
  const out=[...color];out[3]=(out[3]??1)*opacity;return out;
}
function withOpacity(style,opacity){
  if(opacity===1)return style;
  const out={...style};
  if(style.fill)out.fill={...style.fill,color:scaleColorAlpha(style.fill.color,opacity)};
  if(style.stroke)out.stroke={...style.stroke,color:scaleColorAlpha(style.stroke.color,opacity)};
  if(style.point)out.point={...style.point,fillColor:scaleColorAlpha(style.point.fillColor,opacity),strokeColor:scaleColorAlpha(style.point.strokeColor,opacity),opacity:(style.point.opacity??1)*opacity};
  if(style.text)out.text={...style.text,fillColor:scaleColorAlpha(style.text.fillColor,opacity),strokeColor:scaleColorAlpha(style.text.strokeColor,opacity)};
  return out;
}

/**
 * Host-neutral bridge from feature snapshots to the public renderer facade.
 * It knows renderer IDs/references, but no OpenLayers classes/events and no WebGL internals.
 */
export class RendererFeatureSink {
  constructor({renderer,geometryCompiler=new NeutralGeometryCompiler(),styleCompiler,referencePublisher=null,packLineFeatures=true}={}){
    if(!renderer)throw new Error('RendererFeatureSink requires renderer');
    if(typeof styleCompiler!=='function')throw new Error('RendererFeatureSink requires styleCompiler(neutralStyle, geometryKind)');
    this.renderer=renderer;this.geometryCompiler=geometryCompiler;this.styleCompiler=styleCompiler;this.referencePublisher=referencePublisher||((refs)=>this.renderer.setReferences(refs));
    this.packLineFeatures=packLineFeatures;this.features=new Map();this.orderSeed=0;this.frame=null;this.layerState={visible:true,opacity:1,zIndex:0};this._referencesCache=null;
  }
  _emitPart({feature,g,neutralStyle,geometryKey,geometryType=g.kind,neutralGeometry=g,localOrder=0,refKey=geometryKey,compileMemo=null,styleMemo=null}){
    // The same feature geometry can appear under several styles. Compile and
    // upsert once per geometry key, but keep every original style/reference.
    // Cache lifetime is deliberately one feature compilation only: never reuse
    // geometry across tile updates or feature versions.
    let geometryId=compileMemo?.get(geometryKey);
    if(geometryId===undefined){
      const compiled=this.geometryCompiler.compile(neutralGeometry);
      geometryId=this.renderer.upsertGeometry(geometryKey,compiled);
      compileMemo?.set(geometryKey,geometryId);
    }
    // Reuse style compilation and recursive StyleStore.intern() within one feature.
    // Each _compileFeature owns its cache: no assumptions about mutable styles
    // across features, tile reloads, layer opacity updates, or later frames.
    let styleId=styleMemo?.get(neutralStyle)?.get(geometryType);
    if(styleId===undefined){
      const effective=withOpacity(neutralStyle,this.layerState.opacity);
      const style=this.styleCompiler(effective,geometryType);
      styleId=this.renderer.internStyle(style);
      if(styleMemo){
        let kinds=styleMemo.get(neutralStyle);
        if(!kinds){kinds=new Map();styleMemo.set(neutralStyle,kinds);}
        kinds.set(geometryType,styleId);
      }
    }
    const styleZIndex=Number(neutralStyle.zIndex??0);
    const order=(this.orderSeed++)+localOrder;
    return {ref:{id:`${refKey}:ref`,geometryId,styleId,geometryType,order,sceneStyleZIndex:styleZIndex,visible:this.layerState.visible!==false,featureKey:feature.key,sourceLayer:feature.sourceLayer??null,tileKey:feature.tileKey??null},geometryKey};
  }
  _compileGeometryStyle(feature,g,neutralStyle,part,styleIndex=0,compileMemo=null,styleMemo=null,clipMemo=null){
    const refs=[];const geometryKeys=[];const styleSuffix=styleIndex?`:style:${styleIndex}`:'';
    if(g.kind==='polygon'){
      if(neutralStyle.fill){
        const r=this._emitPart({feature,g,neutralStyle,geometryKey:`${feature.key}#${part}:fill`,geometryType:'polygon',neutralGeometry:g,localOrder:styleIndex*1000,refKey:`${feature.key}#${part}:fill${styleSuffix}`,compileMemo,styleMemo});refs.push(r.ref);geometryKeys.push(r.geometryKey);
      }
      if(neutralStyle.stroke){
        // Clip boundary fragments only once even when several stroke styles
        // reuse this polygon inside the same feature compilation.
        let clipped=clipMemo?.get(g);
        if(!clipped){
          clipped=[];
          for(const ring of g.rings||[])
            for(const path of clipPolylineToExtent(ring,g.clipExtent)) clipped.push(path);
          clipMemo?.set(g,clipped);
        }
        let ringIndex=0;
        for(const path of clipped){
            const r=this._emitPart({feature,g,neutralStyle,geometryKey:`${feature.key}#${part}:stroke:${ringIndex}`,geometryType:'line',neutralGeometry:{kind:'line',coordinates:path},localOrder:styleIndex*1000+100+ringIndex,refKey:`${feature.key}#${part}:stroke:${ringIndex}${styleSuffix}`,compileMemo,styleMemo});refs.push(r.ref);geometryKeys.push(r.geometryKey);ringIndex++;
        }
      }
      if(!neutralStyle.fill&&!neutralStyle.stroke){
        const r=this._emitPart({feature,g,neutralStyle,geometryKey:`${feature.key}#${part}`,geometryType:'polygon',neutralGeometry:g,localOrder:styleIndex*1000,refKey:`${feature.key}#${part}${styleSuffix}`,compileMemo,styleMemo});refs.push(r.ref);geometryKeys.push(r.geometryKey);
      }
    }else if(g.kind==='point'&&neutralStyle.point&&neutralStyle.text){
      const geometryKey=`${feature.key}#${part}`;
      const pi=this._emitPart({feature,g,neutralStyle:{...neutralStyle,text:null},geometryKey,geometryType:'point',neutralGeometry:g,localOrder:styleIndex*1000,refKey:`${geometryKey}:image${styleSuffix}`,compileMemo,styleMemo});refs.push(pi.ref);geometryKeys.push(pi.geometryKey);
      const pt=this._emitPart({feature,g,neutralStyle:{...neutralStyle,point:null},geometryKey,geometryType:'point',neutralGeometry:g,localOrder:styleIndex*1000+10,refKey:`${geometryKey}:text${styleSuffix}`,compileMemo,styleMemo});refs.push(pt.ref);
    }else{
      const r=this._emitPart({feature,g,neutralStyle,geometryKey:`${feature.key}#${part}`,geometryType:g.kind,neutralGeometry:g,localOrder:styleIndex*1000,refKey:`${feature.key}#${part}${styleSuffix}`,compileMemo,styleMemo});refs.push(r.ref);geometryKeys.push(r.geometryKey);
    }
    return {refs,geometryKeys};
  }
  // Road/MultiLineString fast path. One geometry resource represents all the
  // independent line parts of a feature; each style references that same
  // immutable collection. This avoids multiplying GeometryStore resources by
  // the number of line parts and RenderReferences by parts * style count.
  // It is intentionally restricted to all-line, stack-styled features; mixed
  // geometry and per-part styles keep the generic exact-order implementation.
  _compilePackedLineFeature(feature, styles){
    const refs=[];
    const geometryKeys=[];
    const geometryKey=`${feature.key}#packed-lines`;
    const direct=feature.geometries.length===1 ? feature.geometries[0] : null;
    const pack=direct?.directLineBuffer
      ? ((direct.flatGpu||direct.directGpuJoin) ? {kind:'line',...direct} : {kind:'line',instanceData:direct.instanceData,instanceCount:direct.instanceCount,gpuJoin:direct.gpuJoin===true})
      : {kind:'line',parts:feature.geometries.map(g=>g.coordinates)};
    const compileMemo=new Map(),styleMemo=new WeakMap();
    for(let si=0;si<styles.length;si++){
      const result=this._emitPart({feature,g:pack,neutralStyle:styles[si]||{},
        geometryKey,geometryType:'line',neutralGeometry:pack,
        localOrder:si*1000,refKey:`${geometryKey}${si?`:style:${si}`:''}`,
        compileMemo,styleMemo});
      if(feature.singleStylePackedLine && Array.isArray(feature.packedPartVertexCounts)
         && feature.packedPartVertexCounts.length){
        const vertices=feature.packedPartVertexCounts;
        // Shader window mode counts vertices; instanced modes count segments.
        result.ref.packedPathVertexCounts=vertices;
        result.ref.packedPathInstanceCounts=vertices.map(n=>Math.max(0,n-1));
        // _emitPart consumed one order; consume the remaining original PARTS
        // orders without allocating the original Geometry/Reference objects.
        this.orderSeed+=vertices.length-1;
      }
      refs.push(result.ref);
    }
    geometryKeys.push(geometryKey);
    return {feature,refs,geometryKeys};
  }
  _compileFeature(feature){
    const __featureStart=performance.now();
    const refs=[];const geometryKeys=[];const styles=feature.styles?.length?feature.styles:[{}];
    if(this.packLineFeatures && (feature.styleMode==='stack' ||
        (feature.singleStylePackedLine===true && styles.length===1)) &&
       ((feature.geometries?.length===1 && feature.geometries[0].directLineBuffer===true &&
         (feature.geometries[0].instanceData instanceof Float32Array || feature.geometries[0].flatGpu===true || feature.geometries[0].directGpuJoin===true)) ||
        ((feature.geometries?.length||0)>1 &&
         feature.geometries.every(g=>g.kind==='line' && Array.isArray(g.coordinates))))){
      const packed=this._compilePackedLineFeature(feature,styles);
      const _d=(globalThis.__m5Stage ||= {});const _s=(_d.featureCompile ||= {calls:0,refs:0,totalMs:0});
      _s.calls++;_s.refs+=packed.refs.length;_s.totalMs+=performance.now()-__featureStart;
      return packed;
    }
    const compileMemo=new Map(),styleMemo=new WeakMap(),clipMemo=new WeakMap();let part=0;
    for(const g of feature.geometries||[]){
      if(feature.styleMode==='stack'){
        for(let si=0;si<styles.length;si++){const c=this._compileGeometryStyle(feature,g,styles[si]||{},part,si,compileMemo,styleMemo,clipMemo);refs.push(...c.refs);geometryKeys.push(...c.geometryKeys);}
      }else{
        const neutralStyle=styles[Math.min(part,styles.length-1)]||styles[0]||{};const c=this._compileGeometryStyle(feature,g,neutralStyle,part,0,compileMemo,styleMemo,clipMemo);refs.push(...c.refs);geometryKeys.push(...c.geometryKeys);
      }
      part++;
    }
    const _d=(globalThis.__m5Stage ||= {});const _s=(_d.featureCompile ||= {calls:0,refs:0,totalMs:0});_s.calls++;_s.refs+=refs.length;_s.totalMs+=performance.now()-__featureStart;
    return {feature,refs,geometryKeys};
  }
  _flush(){this._referencesCache=null;this.referencePublisher(this.references,this);}
  _recompileAll(){const features=[...this.features.values()].map(x=>x.feature);this.features.clear();this.orderSeed=0;for(const f of features)this.features.set(f.key,this._compileFeature(f));this._flush();}
  replaceFeatures(features){this.features.clear();this.orderSeed=0;for(const f of features||[])this.features.set(f.key,this._compileFeature(f));this._flush();return this.references;}
  upsertFeature(feature){const prev=this.features.get(feature.key);const compiled=this._compileFeature(feature);if(prev){for(let i=0;i<compiled.refs.length;i++)if(prev.refs[i])compiled.refs[i].order=prev.refs[i].order;}this.features.set(feature.key,compiled);this._flush();return compiled.refs;}
  removeFeature(featureOrKey){const key=typeof featureOrKey==='string'?featureOrKey:featureOrKey?.key;if(key==null)return false;const removed=this.features.delete(key);if(removed)this._flush();return removed;}
  clear(){this.features.clear();this._flush();}
  setFrame(frame){this.frame=frame;this.renderer.setFrame?.(frame);return frame;}
  setLayerState(state={}){
    const next={visible:state.visible!==false,opacity:Math.max(0,Math.min(1,Number(state.opacity??1))),zIndex:Number(state.zIndex??0)};
    const prev=this.layerState;
    const changed=next.visible!==prev.visible||next.opacity!==prev.opacity||next.zIndex!==prev.zIndex;
    this.layerState=next;
    if(changed&&this.features.size){
      // Only alpha changes the compiled style payload. Visibility and layer
      // ordering change reference metadata; recompiling Geometry and styles
      // for every feature would be redundant.
      if(next.opacity!==prev.opacity)this._recompileAll();
      else {
        // Publish fresh reference objects. RenderReferenceStore snapshots array
        // membership but not each object; mutating previously published refs
        // would erase the visibility change before signature comparison.
        if(next.visible!==prev.visible)for(const entry of this.features.values())
          entry.refs=entry.refs.map(ref=>({...ref,visible:next.visible}));
        this._flush();
      }
    }
    return this.layerState;
  }
  get references(){return this._referencesCache||(this._referencesCache=[...this.features.values()].flatMap(x=>x.refs));}
}
