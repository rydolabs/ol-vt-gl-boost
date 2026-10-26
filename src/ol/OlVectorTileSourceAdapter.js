import { OlVectorTileFeatureAdapter } from './OlVectorTileFeatureAdapter.js';

function on(source,type,fn){
  if(typeof source?.on==='function'){const key=source.on(type,fn);return ()=>{if(typeof source.un==='function')source.un(type,fn);else key?.unlisten?.();};}
  if(typeof source?.addEventListener==='function'){source.addEventListener(type,fn);return ()=>source.removeEventListener?.(type,fn);}
  throw new Error('source must expose on/un or addEventListener/removeEventListener');
}
function coordOf(tile){return tile?.getTileCoord?.()||tile?.tileCoord||null;}
function keyOf(tile){const c=coordOf(tile);return c?`${c[0]}/${c[1]}/${c[2]}`:String(tile?.getKey?.()||tile?.key||'unknown');}
function utf8Bytes(v){try{return new TextEncoder().encode(JSON.stringify(v??null)).byteLength;}catch{return 0;}}
function estimateFeatureBytes(feature){
  const flat=feature?.getFlatCoordinates?.()||feature?.flatCoordinates||[];const ends=feature?.getEnds?.()||feature?.ends||[];
  const props=feature?.getProperties?.()||feature?.properties||{};return flat.length*8+ends.length*4+utf8Bytes(props)+96;
}
function projectionOf(source){return source?.getProjection?.()||source?.projection||null;}

/** Tile-oriented lifecycle adapter for OL VectorTileSource source tiles. */
export class OlVectorTileSourceAdapter {
  constructor({source,sink,featureAdapter=new OlVectorTileFeatureAdapter(),styleLike=null,sourceLayerStyles=null,sourceLayerFilter=null,sourceLayerStyleResolver=null,resolutionProvider=null,layerProperty='layer',maxInactiveTiles=128,maxInactiveBytes=8*1024*1024,estimateTileBytes=null,targetProjectionProvider=null,coordinateTransform=null,styleArrayMode='parts',directLineBuffer=true,gpuJoinSolidLine=false,flatCoordinatesGpuLine=false,singleStyleLinePack=false,directFeatureGpuJoin=false,fusedGpuJoinPacking=false,polygonOlRingGrouping=false,disableWorkerFeatureBuffers=false,transferGpuBuffers=false,drawMode='painter',polygonInsideSegmentFastPath=true,polygonEarBBoxPrecheck=true,stableStyleIdentityCache=false,polygonStrokeFringePx=0,closedLineJoins=false,onCpuTile=null}={}){
    if(!source)throw new Error('OlVectorTileSourceAdapter requires source');if(!sink)throw new Error('OlVectorTileSourceAdapter requires sink');
    this.source=source;this.sink=sink;this.featureAdapter=featureAdapter;this.styleLike=styleLike;this.sourceLayerStyles=sourceLayerStyles;this.sourceLayerFilter=typeof sourceLayerFilter==='function'?sourceLayerFilter:null;this.sourceLayerStyleResolver=typeof sourceLayerStyleResolver==='function'?sourceLayerStyleResolver:null;this.resolutionProvider=resolutionProvider;this.layerProperty=layerProperty;this.maxInactiveTiles=Math.max(0,Math.floor(Number(maxInactiveTiles)||0));this.maxInactiveBytes=Math.max(0,Math.floor(Number(maxInactiveBytes)||0));this.estimateTileBytes=typeof estimateTileBytes==='function'?estimateTileBytes:null;this.targetProjectionProvider=typeof targetProjectionProvider==='function'?targetProjectionProvider:null;this.coordinateTransform=typeof coordinateTransform==='function'?coordinateTransform:null;this.directLineBuffer=directLineBuffer!==false;this.gpuJoinSolidLine=gpuJoinSolidLine===true;this.flatCoordinatesGpuLine=flatCoordinatesGpuLine==='auto'?'auto':flatCoordinatesGpuLine===true;this.singleStyleLinePack=singleStyleLinePack===true;this.directFeatureGpuJoin=directFeatureGpuJoin===true;this.fusedGpuJoinPacking=fusedGpuJoinPacking===true;this.polygonOlRingGrouping=polygonOlRingGrouping===true;this.disableWorkerFeatureBuffers=disableWorkerFeatureBuffers===true;this.transferGpuBuffers=transferGpuBuffers===true;this.drawMode=drawMode==='style-pass'?'style-pass':'painter';this.polygonInsideSegmentFastPath=polygonInsideSegmentFastPath!==false;this.polygonEarBBoxPrecheck=polygonEarBBoxPrecheck!==false;this.stableStyleIdentityCache=stableStyleIdentityCache===true;this.polygonStrokeFringePx=polygonStrokeFringePx;this.closedLineJoins=closedLineJoins===true;this.styleArrayMode=styleArrayMode==='stack'?'stack':'parts';this.onCpuTile=typeof onCpuTile==='function'?onCpuTile:null;this.disposers=[];this.tiles=new Map();this.inactiveTiles=new Map();this.inactiveBytes=0;this.peakInactiveBytes=0;this.inactiveEvictions=0;this.started=false;this.reactivations=0;this.deactivations=0;this.restoredCompiledTiles=0;this.recompiledTiles=0;
  }
  _sourceLayer(feature){return this.featureAdapter.sourceLayerOf?.(feature,{layerProperty:this.layerProperty})??null;}
  _styleFor(feature,sourceLayer,resolution,tile){
    if(this.sourceLayerStyleResolver){const v=this.sourceLayerStyleResolver(sourceLayer,feature,resolution,tile);if(v!==undefined)return v;}
    if(this.sourceLayerStyles&&Object.prototype.hasOwnProperty.call(this.sourceLayerStyles,sourceLayer))return this.sourceLayerStyles[sourceLayer];
    return this.styleLike;
  }
  _estimateTile(tile){if(this.estimateTileBytes)return Math.max(0,Math.floor(Number(this.estimateTileBytes(tile))||0));const fs=tile?.getFeatures?.()||[];return 192+fs.reduce((n,f)=>n+estimateFeatureBytes(f),0);}
  _inactiveDelete(key){const e=this.inactiveTiles.get(key);if(!e)return null;this.inactiveTiles.delete(key);this.inactiveBytes=Math.max(0,this.inactiveBytes-(e.bytes||0));return e;}
  _syncTile(tile){
    const tileKey=keyOf(tile),features=tile?.getFeatures?.()||[];const resolution=Number(this.resolutionProvider?.(tile)||1);const sourceProjection=tile?.projection||projectionOf(this.source),targetProjection=this.targetProjectionProvider?.(tile)||sourceProjection;
    // The source tile's unbuffered extent is the rasterization boundary.
    // MVT data frequently includes an expanded geometry buffer around it.
    const tileCoord=coordOf(tile),grid=this.source.getTileGrid?.()||this.source.getTileGridForProjection?.(targetProjection);
    const rawExtent=tileCoord&&grid?.getTileCoordExtent?.(tileCoord);
    // A generic coordinate transform can rotate/warp an extent. In that case
    // the neutral adapter must supply the correct target-space clipping box.
    const canClip=!this.coordinateTransform||sourceProjection===targetProjection;
    const clipExtent=canClip&&rawExtent&&rawExtent.length===4&&Array.from(rawExtent).every(Number.isFinite)?Array.from(rawExtent):null;
    // Already-encoded tile from a reusable Worker Pool. The caller is
    // responsible for source/style versioning and validated projection.
    const preencoded=tile?.getEncodedTile?.();
    if(preencoded){
      if(typeof this.sink.replaceEncodedTile!=='function')throw Error('Sink lacks preencoded Worker tile support');
      if(!canClip)throw Error('Worker tile projection/transform mismatch');
      if(JSON.stringify(preencoded.clipExtent)!==JSON.stringify(clipExtent))
        throw Error('Worker tile clip extent mismatch');
      const result=this.sink.replaceEncodedTile(tileKey,preencoded,{featureCount:tile?.featureCount});
      this._inactiveDelete(tileKey);this.tiles.set(tileKey,tile);
      this.recompiledTiles++;return result;
    }
    // Opt-in direct feature -> CPU buffers -> WebGL upload.
    // A DirectFeatureWebGLPipeline owns the entire tile, so skip FeatureAdapter,
    // NeutralGeometryCompiler, GeometryStore, References and DrawStream here.
    if(typeof this.sink.replaceRawTile==='function'){
      const accepted=[];
      for(const f of features){
        const sourceLayer=this._sourceLayer(f);
        if(this.sourceLayerFilter&&this.sourceLayerFilter(sourceLayer,f,tile)===false)continue;
        accepted.push(f);
      }
      const result=this.sink.replaceRawTile(tileKey,accepted,{
        styleFor:(feature,sourceLayer)=>{const selected=this._styleFor(feature,sourceLayer,resolution,tile);return typeof selected==='function'?selected(feature,resolution):selected;},
        clipExtent,layerProperty:this.layerProperty,sourceProjection,targetProjection,
        coordinateTransform:this.coordinateTransform,styleMode:this.styleArrayMode,
        transferGpuBuffers:this.transferGpuBuffers,drawMode:this.drawMode,polygonInsideSegmentFastPath:this.polygonInsideSegmentFastPath,polygonEarBBoxPrecheck:this.polygonEarBBoxPrecheck,stableStyleIdentityCache:this.stableStyleIdentityCache,polygonStrokeFringePx:this.polygonStrokeFringePx,closedLineJoins:this.closedLineJoins,
      });
      this._inactiveDelete(tileKey);this.tiles.set(tileKey,tile);
      this.recompiledTiles++;this.onCpuTile?.(tile,{tileKey,clipExtent});return result;
    }
    const snapshots=[];for(const f of features){const sourceLayer=this._sourceLayer(f);if(this.sourceLayerFilter&&this.sourceLayerFilter(sourceLayer,f,tile)===false)continue;const styleLike=this._styleFor(f,sourceLayer,resolution,tile);const snap=this.featureAdapter.adapt(f,{tileKey,styleLike,resolution,layerProperty:this.layerProperty,sourceProjection,targetProjection,coordinateTransform:this.coordinateTransform,clipExtent,styleMode:this.styleArrayMode,directLineBuffer:this.directLineBuffer,gpuJoinSolidLine:this.gpuJoinSolidLine,flatCoordinatesGpuLine:this.flatCoordinatesGpuLine,singleStyleLinePack:this.singleStyleLinePack,directFeatureGpuJoin:this.directFeatureGpuJoin,fusedGpuJoinPacking:this.fusedGpuJoinPacking,polygonOlRingGrouping:this.polygonOlRingGrouping,disableWorkerFeatureBuffers:this.disableWorkerFeatureBuffers});snap.key=`${sourceLayer??"unknown"}:${snap.key}`;if(snap.styles?.length||styleLike==null)snapshots.push(snap);}
    this._inactiveDelete(tileKey);this.tiles.set(tileKey,tile);this.sink.replaceTile?.(tileKey,snapshots,{tile,coord:coordOf(tile),sourceProjection,targetProjection});this.recompiledTiles++;return snapshots;
  }
  start(){
    if(this.started)return this;this.started=true;
    this.disposers.push(on(this.source,'tileloadend',e=>{if(e?.tile)this._syncTile(e.tile);}));
    this.disposers.push(on(this.source,'tileloaderror',e=>{if(e?.tile){const k=keyOf(e.tile);this.tiles.delete(k);this._inactiveDelete(k);this.sink.removeTile?.(k);}}));
    return this;
  }
  ingestTile(tile){return this._syncTile(tile);}
  _trimInactive(){while(this.inactiveTiles.size>this.maxInactiveTiles||this.inactiveBytes>this.maxInactiveBytes){const key=this.inactiveTiles.keys().next().value;if(key==null)break;this._inactiveDelete(key);this.inactiveEvictions++;}}
  deactivateTile(tileOrKey){const key=typeof tileOrKey==='string'?tileOrKey:keyOf(tileOrKey),tile=this.tiles.get(key);if(!tile)return false;this.tiles.delete(key);
    const cache=this.maxInactiveTiles>0&&this.maxInactiveBytes>0;
    const saved=cache?this.sink.suspendTile?.(key):null;
    if(!saved)this.sink.removeTile?.(key);
    if(cache){this._inactiveDelete(key);const bytes=this._estimateTile(tile);this.inactiveTiles.set(key,{tile,bytes,compiled:saved||null});this.inactiveBytes+=bytes;this.peakInactiveBytes=Math.max(this.peakInactiveBytes,this.inactiveBytes);this._trimInactive();}
    this.deactivations++;return true;}
  setWorldInstances(instanceMap){return this.sink.setWorldInstances?.(instanceMap)??false;}
  reactivate(activeKeys){let n=0;for(const key0 of activeKeys||[]){const key=String(key0),entry=this.inactiveTiles.get(key);if(!entry)continue;this._inactiveDelete(key);
    if(entry.compiled&&this.sink.restoreTile?.(key,entry.compiled)){this.tiles.set(key,entry.tile);this.restoredCompiledTiles++;}
    else this._syncTile(entry.tile);
    this.reactivations++;n++;}return n;}
  removeTile(tileOrKey){const key=typeof tileOrKey==='string'?tileOrKey:keyOf(tileOrKey);this.tiles.delete(key);this._inactiveDelete(key);return this.sink.removeTile?.(key);}
  prune(activeKeys){const live=new Set([...(activeKeys||[])].map(String));this.reactivate(live);let n=0;for(const key of [...this.tiles.keys()])if(!live.has(String(key))){this.deactivateTile(key);n++;}return n;}
  stop(){for(const d of this.disposers.splice(0))d();for(const key of [...this.tiles.keys()])this.sink.removeTile?.(key);this.tiles.clear();this.inactiveTiles.clear();this.inactiveBytes=0;this.started=false;return this;}
}
