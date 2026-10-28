/**
 * R73 opt-in, reversible single-active-renderer host gate.
 *
 * OL 10.10.0 has no public "keep source tiles loaded but skip only WebGL drawing"
 * switch. This isolated integration overrides the instance render method while
 * enabled, with exact descriptor restoration before stock-OL fallback. Source
 * tiles are demanded through OL's public VectorTileSource getTile/getSourceTiles
 * APIs, based on the scene's existing viewport/tile-grid pruner.
 *
 * Never modify the OL prototype or patch OL runtime distribution. Fail closed.
 * Experimental, opt-in only. No worker, shader, or tile encoder changes.
 */
export class OlStockRenderGate {
  constructor({map,scene,onError=null}={}) {
    if(!map||!scene?.layers)throw Error('OlStockRenderGate requires map and active DirectM5SceneBinding');
    this.map=map;this.scene=scene;this.onError=onError;
    this.active=false;this._saved=new Map();this._requested=new Map();
    this._listener=null;this._onFrame=event=>{
      if(!this.active||!event?.frameState)return;
      try{this._sync();this._demand(event.frameState);}
      catch(error){
        // Restore stock rendering first, even when the application handler throws.
        this.stop();
        if(this.onError)this.onError({error,phase:'source-only-gate'});
        else throw error;
      }
    };
    this.stats={requested:0,skipped:0,stockLayerDrawsSuppressed:0};
  }
  _restore(layer,record){
    if(record.descriptor)Object.defineProperty(layer,'render',record.descriptor);
    else delete layer.render;
  }
  _sync(){
    if(!this.active)return;
    const current=new Set();
    for(const state of this.scene.layers.values()){
      const layer=state.layer;
      if(!layer||typeof layer.render!=='function'||!state.source?.getTile||
        typeof state.source.getSourceTiles!=='function'||!state.pruner?.activeInstances)
        throw Error('R73 requires OL VectorTileLayer and public tile source/pruner APIs');
      current.add(layer);
      if(this._saved.has(layer))continue;
      const descriptor=Object.getOwnPropertyDescriptor(layer,'render');
      if(descriptor&&!descriptor.configurable)throw Error('Nonconfigurable layer.render cannot be gated');
      const record={descriptor};
      const gate=this;
      Object.defineProperty(layer,'render',{configurable:true,writable:true,value:function(){
        gate.stats.stockLayerDrawsSuppressed++;
        // An empty layer renderer leaves OL's Map and view lifecycle active,
        // without invoking OL's WebGL tile geometry/fragment pipelines.
        return null;
      }});
      this._saved.set(layer,record);
    }
    for(const [layer,record] of [...this._saved]){
      if(current.has(layer))continue;
      this._restore(layer,record);this._saved.delete(layer);
    }
  }
  _demand(frameState){
    const projection=frameState?.viewState?.projection??this.map.getView?.()?.getProjection?.();
    const pixelRatio=Number(frameState?.pixelRatio??1);
    if(!projection||!Number.isFinite(pixelRatio)||pixelRatio<=0)return;
    const live=new Set();
    for(const state of this.scene.layers.values()){
      if(state.state?.visible===false)continue;
      const source=state.source;
      // Revalidate on explicit source refresh / version change.
      const revision=typeof source.getRevision==='function'?source.getRevision():null;
      let entry=this._requested.get(state.key);
      if(!entry||entry.source!==source||entry.revision!==revision){
        entry={source,revision,keys:new Set()};this._requested.set(state.key,entry);
      }
      live.add(state.key);
      const urlFn=source.getTileUrlFunction?.();
      for(const key of state.pruner.activeInstances(frameState).keys()){
        if(entry.keys.has(key)){this.stats.skipped++;continue;}
        const coord=key.split('/').map(Number);
        if(coord.length!==3||!coord.every(Number.isInteger))throw Error('Invalid OL source tile key '+key);
        // Sparse source layouts (e.g. 32 genuinely distinct PBF feeds) may
        // expose a URL for only one coordinate per layer.
        if(typeof urlFn==='function'&&!urlFn(coord,pixelRatio,projection)){
          entry.keys.add(key);continue;
        }
        const renderTile=source.getTile(coord[0],coord[1],coord[2],pixelRatio,projection);
        if(!renderTile)throw Error('VectorTileSource.getTile returned no tile for '+key);
        const sourceTiles=source.getSourceTiles(pixelRatio,projection,renderTile);
        if(!Array.isArray(sourceTiles))throw Error('VectorTileSource.getSourceTiles must return an array');
        entry.keys.add(key);this.stats.requested++;
      }
    }
    for(const key of [...this._requested.keys()])if(!live.has(key))this._requested.delete(key);
  }
  start(){
    if(this.active)return this;
    if(!this.scene.started)throw Error('Start the optimized scene before OlStockRenderGate');
    this.active=true;
    try{
      this._sync();
      this._listener=this.map.on?.('postrender',this._onFrame)||null;
      if(typeof this.map.on!=='function')throw Error('OL map.on required');
      this.map.render?.();
      return this;
    }catch(error){this.stop();throw error;}
  }
  stop(){
    this.active=false;
    if(typeof this.map.un==='function')this.map.un('postrender',this._onFrame);
    else this._listener?.unlisten?.();
    this._listener=null;
    for(const [layer,record] of this._saved)this._restore(layer,record);
    this._saved.clear();this._requested.clear();
    return this;
  }
  snapshot(){
    return {active:this.active,overriddenLayers:this._saved.size,...this.stats};
  }
}
