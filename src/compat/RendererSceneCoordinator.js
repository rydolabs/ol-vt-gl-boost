/**
 * Host-neutral coordinator for multiple feature sinks/layers sharing one renderer.
 * Sinks publish their references here; the coordinator owns composition/order only.
 */
export class RendererSceneCoordinator {
  constructor({renderer,batchUpdates=false}={}){
    if(!renderer) throw new Error('RendererSceneCoordinator requires renderer');
    this.renderer=renderer; this.layers=new Map(); this.seq=0; this.batchUpdates=batchUpdates;this.dirty=false;this.queued=false;this.publishCount=0;
  }
  _ensure(layerKey,options={}){
    const key=String(layerKey);
    if(!this.layers.has(key)) this.layers.set(key,{key,refs:[],sequence:options.sequence!=null?Number(options.sequence):this.seq++,zIndex:Number(options.zIndex??0),visible:options.visible!==false,tiles:null,composedTiles:new Map(),composedRefs:null});
    const e=this.layers.get(key);
    if(options.zIndex!=null)e.zIndex=Number(options.zIndex);
    if(options.sequence!=null)e.sequence=Number(options.sequence);
    if(options.visible!=null)e.visible=options.visible!==false;
    return e;
  }
  publisher(layerKey,options={}){
    const entry=this._ensure(layerKey,options);
    const publish=(refs)=>{entry.tiles=null;entry.composedTiles.clear();entry.composedRefs=null;entry.refs=[...(refs||[])];this.requestFlush();};
    // Packet API: a changed vector tile replaces only its own immutable refs.
    // Legacy feature sinks still use publish(refs) unchanged.
    publish.publishTile=(tileKey,refs)=>{
      if(!entry.tiles){entry.tiles=new Map();entry.refs=[];entry.composedRefs=null;entry.composedTiles.clear();}
      entry.tiles.set(String(tileKey),refs);
      entry.composedTiles.delete(String(tileKey));
      this.requestFlush();
    };
    publish.removeTile=(tileKey)=>{
      if(!entry.tiles?.delete(String(tileKey)))return;
      entry.composedTiles.delete(String(tileKey));this.requestFlush();
    };
    publish.replaceTiles=(packets)=>{
      entry.tiles=new Map(packets);
      entry.refs=[];entry.composedRefs=null;entry.composedTiles.clear();this.requestFlush();
    };
    return publish;
  }
  updateLayer(layerKey,state={}){const key=String(layerKey),old=this.layers.get(key);const before=old?[old.zIndex,old.sequence,old.visible]:null;const entry=this._ensure(key,state);if(!before||before[0]!==entry.zIndex||before[1]!==entry.sequence||before[2]!==entry.visible){entry.composedTiles.clear();entry.composedRefs=null;this.requestFlush();}return entry;}
  removeLayer(layerKey){const removed=this.layers.delete(String(layerKey));if(removed)this.requestFlush();return removed;}
  _orderedEntries(){return [...this.layers.values()].filter(x=>x.visible!==false).sort((a,b)=>a.zIndex-b.zIndex||a.sequence-b.sequence||a.key.localeCompare(b.key));}
  _compose(){
    const _t=performance.now();
    const _refs=[];
    for(const entry of this._orderedEntries()){
      const stamp=`${entry.key}|${entry.zIndex}|${entry.sequence}`;
      if(entry.tiles){
        for(const [tileKey,source] of entry.tiles){
          let cached=entry.composedTiles.get(tileKey);
          if(!cached||cached.source!==source||cached.stamp!==stamp){
            cached={source,stamp,refs:source.map(r=>({...r,sceneLayerKey:entry.key,sceneLayerZIndex:entry.zIndex,sceneLayerSequence:entry.sequence}))};
            entry.composedTiles.set(tileKey,cached);
          }
          for(const r of cached.refs)_refs.push(r);
        }
      }else{
        const source=entry.refs;
        let cached=entry.composedRefs;
        if(!cached||cached.source!==source||cached.stamp!==stamp){
          cached={source,stamp,refs:source.map(r=>({...r,sceneLayerKey:entry.key,sceneLayerZIndex:entry.zIndex,sceneLayerSequence:entry.sequence}))};
          entry.composedRefs=cached;
        }
        for(const r of cached.refs)_refs.push(r);
      }
    }
    const _d=(globalThis.__m5Stage ||= {});const _s=(_d.sceneCompose ||= {calls:0,totalMs:0,maxMs:0});const _dt=performance.now()-_t;_s.calls++;_s.totalMs+=_dt;_s.maxMs=Math.max(_s.maxMs,_dt);
    return _refs;
  }
  requestFlush(){this.dirty=true;if(!this.batchUpdates){this.flush();return;}if(this.queued)return;this.queued=true;queueMicrotask(()=>{this.queued=false;this.flushPending();});}
  flushPending(){if(this.dirty)return this.flush();return this.renderer.references;}
  flush(){this.dirty=false;const refs=this._compose();this.renderer.setReferences(refs);this.publishCount++;return refs;}
  get references(){return this._compose();}
}
