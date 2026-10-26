import { OpenLayersAdapter } from './OpenLayersAdapter.js';
import { OlLayerTreeAdapter } from './OlLayerTreeAdapter.js';
import { OlVectorTileSourceAdapter } from './OlVectorTileSourceAdapter.js';
import { OlVectorTileFramePruner } from './OlVectorTileFramePruner.js';

/**
 * Automatic OpenLayers map/layer/source lifecycle binding.
 *
 * This module knows only OL public object shapes and a neutral `layerPort`:
 *   createLayer(key, descriptor) -> feature sink
 *   updateLayer(key, descriptor)
 *   removeLayer(key)
 *
 * The sink is consumed through OpenLayersAdapter/OlSourceLifecycleAdapter, so
 * renderer/core modules never see concrete OL layers, sources, or events.
 */
export class OlMapSceneAdapter {
  constructor({map, layerPort, featureOptions={},acceptLayer=null,vectorTileOptions={},layerStyleResolver=null}={}){
    if(!map)throw new Error('OlMapSceneAdapter requires map');
    if(!layerPort?.createLayer||!layerPort?.updateLayer||!layerPort?.removeLayer)throw new Error('OlMapSceneAdapter requires layerPort create/update/remove methods');
    this.map=map;this.layerPort=layerPort;this.featureOptions=featureOptions;this.vectorTileOptions=vectorTileOptions||{};this.layerStyleResolver=typeof layerStyleResolver==='function'?layerStyleResolver:null;this.acceptLayer=acceptLayer||((entry,source)=>source==null||typeof source?.getFeatures==='function'||this._isVectorTileSource(source));this.bindings=new Map();this.tree=null;this.started=false;
  }
  _source(layer){return typeof layer?.getSource==='function'?layer.getSource():layer?.source||null;}
  _isVectorTileSource(source){return !!source&&typeof source.getFeatures!=='function'&&typeof source.getTileGrid==='function'&&typeof source.getTile==='function'&&typeof source.getOverlaps==='function';}
  _layerStyle(layer){const resolved=this.layerStyleResolver?.(layer);if(resolved!==undefined&&resolved!==null)return resolved;return typeof layer?.getStyleFunction==='function'?layer.getStyleFunction():(typeof layer?.getStyle==='function'?layer.getStyle():null);}
  _descriptor(entry){return {key:entry.key,layer:entry.layer,state:{...entry.state},sequence:Number(entry.sequence??0),depth:Number(entry.depth??0)};}
  _attach(entry){
    const descriptor=this._descriptor(entry),source=this._source(entry.layer),isVectorTile=this._isVectorTileSource(source);
    const sink=isVectorTile&&this.layerPort.createVectorTileLayer?this.layerPort.createVectorTileLayer(entry.key,descriptor):this.layerPort.createLayer(entry.key,descriptor);
    const adapter=new OpenLayersAdapter({sink});
    const sourceBridge=!source?null:(isVectorTile?new OlVectorTileSourceAdapter({source,sink,styleLike:this._layerStyle(entry.layer),sourceLayerStyles:this.vectorTileOptions.sourceLayerStyles,sourceLayerFilter:this.vectorTileOptions.sourceLayerFilter,sourceLayerStyleResolver:this.vectorTileOptions.sourceLayerStyleResolver,maxInactiveTiles:this.vectorTileOptions.maxInactiveTiles,maxInactiveBytes:this.vectorTileOptions.maxInactiveBytes,estimateTileBytes:this.vectorTileOptions.estimateTileBytes,targetProjectionProvider:()=>this.map?.getView?.()?.getProjection?.()||null,coordinateTransform:this.vectorTileOptions.coordinateTransform,styleArrayMode:this.vectorTileOptions.styleArrayMode,directLineBuffer:this.vectorTileOptions.directLineBuffer!==false,gpuJoinSolidLine:this.vectorTileOptions.gpuJoinSolidLine===true,flatCoordinatesGpuLine:this.vectorTileOptions.flatCoordinatesGpuLine,singleStyleLinePack:this.vectorTileOptions.singleStyleLinePack===true,directFeatureGpuJoin:this.vectorTileOptions.directFeatureGpuJoin===true,fusedGpuJoinPacking:this.vectorTileOptions.fusedGpuJoinPacking===true,polygonOlRingGrouping:this.vectorTileOptions.polygonOlRingGrouping===true,disableWorkerFeatureBuffers:this.vectorTileOptions.disableWorkerFeatureBuffers===true}).start():adapter.attachSource(source,{featureOptions:this.featureOptions,initialSync:true}));
    const tilePruner=isVectorTile&&sourceBridge?new OlVectorTileFramePruner({map:this.map,source,sourceAdapter:sourceBridge,...this.vectorTileOptions}).start():null;
    const binding={key:entry.key,layer:entry.layer,source,sink,adapter,sourceBridge,tilePruner,descriptor,isVectorTile};this.bindings.set(entry.key,binding);return binding;
  }
  _detach(key){
    const b=this.bindings.get(String(key));if(!b)return false;
    b.tilePruner?.stop?.();b.sourceBridge?.stop?.();b.sink?.clear?.();this.layerPort.removeLayer(b.key,b.descriptor);this.bindings.delete(b.key);return true;
  }
  _replaceSource(binding,source){
    if(binding.source===source)return false;
    binding.tilePruner?.stop?.();binding.tilePruner=null;binding.sourceBridge?.stop?.();binding.sink?.clear?.();binding.source=source;
    const isVectorTile=this._isVectorTileSource(source);binding.isVectorTile=isVectorTile;
    binding.sourceBridge=!source?null:(isVectorTile?new OlVectorTileSourceAdapter({source,sink:binding.sink,styleLike:this._layerStyle(binding.layer),sourceLayerStyles:this.vectorTileOptions.sourceLayerStyles,sourceLayerFilter:this.vectorTileOptions.sourceLayerFilter,sourceLayerStyleResolver:this.vectorTileOptions.sourceLayerStyleResolver,maxInactiveTiles:this.vectorTileOptions.maxInactiveTiles,maxInactiveBytes:this.vectorTileOptions.maxInactiveBytes,estimateTileBytes:this.vectorTileOptions.estimateTileBytes,targetProjectionProvider:()=>this.map?.getView?.()?.getProjection?.()||null,coordinateTransform:this.vectorTileOptions.coordinateTransform,styleArrayMode:this.vectorTileOptions.styleArrayMode,directLineBuffer:this.vectorTileOptions.directLineBuffer!==false,gpuJoinSolidLine:this.vectorTileOptions.gpuJoinSolidLine===true,flatCoordinatesGpuLine:this.vectorTileOptions.flatCoordinatesGpuLine,singleStyleLinePack:this.vectorTileOptions.singleStyleLinePack===true,directFeatureGpuJoin:this.vectorTileOptions.directFeatureGpuJoin===true,fusedGpuJoinPacking:this.vectorTileOptions.fusedGpuJoinPacking===true,polygonOlRingGrouping:this.vectorTileOptions.polygonOlRingGrouping===true,disableWorkerFeatureBuffers:this.vectorTileOptions.disableWorkerFeatureBuffers===true}).start():binding.adapter.attachSource(source,{featureOptions:this.featureOptions,initialSync:true}));
    if(isVectorTile&&binding.sourceBridge)binding.tilePruner=new OlVectorTileFramePruner({map:this.map,source,sourceAdapter:binding.sourceBridge,...this.vectorTileOptions}).start();return true;
  }
  _syncSnapshot(snapshot){
    const live=new Set(snapshot.map(e=>String(e.key)));
    for(const key of [...this.bindings.keys()])if(!live.has(String(key)))this._detach(key);
    for(const entry of snapshot){
      const source=this._source(entry.layer);const accepted=this.acceptLayer(entry,source)!==false;
      if(!accepted){this._detach(entry.key);continue;}
      let b=this.bindings.get(entry.key);if(!b)b=this._attach(entry);
      const descriptor=this._descriptor(entry);b.descriptor=descriptor;
      this._replaceSource(b,source);
      this.layerPort.updateLayer(entry.key,descriptor);
    }
    return this.snapshot();
  }
  start({initialSync=true}={}){
    if(this.started)return this;this.started=true;
    this.tree=new OlLayerTreeAdapter({map:this.map,onSnapshot:s=>this._syncSnapshot(s)}).start({initialSync});return this;
  }
  sync(){if(!this.tree)throw new Error('OlMapSceneAdapter is not started');return this._syncSnapshot(this.tree.snapshot());}
  stop(){
    if(!this.started)return this;this.tree?.stop?.();this.tree=null;
    for(const key of [...this.bindings.keys()])this._detach(key);this.started=false;return this;
  }
  snapshot(){return [...this.bindings.values()].map(b=>({key:b.key,source:b.source,state:{...b.descriptor.state},sequence:b.descriptor.sequence,depth:b.descriptor.depth,isVectorTile:!!b.isVectorTile,tileCount:b.sourceBridge?.tiles?.size??null,inactiveTileCount:b.sourceBridge?.inactiveTiles?.size??null,inactiveTileBytes:b.sourceBridge?.inactiveBytes??null,inactiveTileEvictions:b.sourceBridge?.inactiveEvictions??null,reactivations:b.sourceBridge?.reactivations??0,restoredCompiledTiles:b.sourceBridge?.restoredCompiledTiles??0,recompiledTiles:b.sourceBridge?.recompiledTiles??0,activeTileCount:b.tilePruner?.lastActive?.size??null,prunedTiles:b.tilePruner?.pruned??0}));}
  get layerCount(){return this.bindings.size;}
}
