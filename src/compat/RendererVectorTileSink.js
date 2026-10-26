import { RendererFeatureSink } from './RendererFeatureSink.js';

/** Host-neutral tile sink: one feature sink per tile, composed into one layer publisher. */
export class RendererVectorTileSink {
  constructor({renderer,geometryCompiler,styleCompiler,referencePublisher=null,packLineFeatures=true}={}){
    if(!renderer)throw new Error('RendererVectorTileSink requires renderer');if(typeof styleCompiler!=='function')throw new Error('RendererVectorTileSink requires styleCompiler');
    this.packLineFeatures=packLineFeatures;this.renderer=renderer;this.geometryCompiler=geometryCompiler;this.styleCompiler=styleCompiler;this.referencePublisher=referencePublisher||((refs)=>renderer.setReferences(refs));this.tiles=new Map();this.layerState={visible:true,opacity:1,zIndex:0};
  }
  _sink(tileKey){let e=this.tiles.get(tileKey);if(e)return e.sink;const sink=new RendererFeatureSink({renderer:this.renderer,geometryCompiler:this.geometryCompiler,styleCompiler:this.styleCompiler,referencePublisher:()=>{},packLineFeatures:this.packLineFeatures});sink.setLayerState(this.layerState);this.tiles.set(tileKey,{sink,meta:null,worldOffsets:[0],packet:null});return sink;}
  replaceTile(tileKey,features,meta=null){const key=String(tileKey),sink=this._sink(key);sink.replaceFeatures(features||[]);const e=this.tiles.get(key);e.meta=meta;if(!Array.isArray(e.worldOffsets)||!e.worldOffsets.length)e.worldOffsets=[0];e.packet=null;this._publishTile(key);return sink.references;}
  // A detached tile keeps compiled geometry and style references in a bounded
  // inactive cache owned by the source adapter. Restoring it never recompiles.
  suspendTile(tileKey){const key=String(tileKey),entry=this.tiles.get(key);if(!entry)return null;this.tiles.delete(key);this._removePacket(key);return entry;}
  restoreTile(tileKey,entry){const key=String(tileKey);if(!entry?.sink)return false;if(this.tiles.has(key))return false;this.tiles.set(key,entry);entry.sink.setLayerState(this.layerState);entry.packet=null;this._publishTile(key);return true;}
  setTileWorldOffsets(tileKey,offsets=[0]){const e=this.tiles.get(String(tileKey));if(!e)return false;const clean=[...new Set((offsets||[]).map(Number).filter(Number.isFinite))].sort((a,b)=>a-b);e.worldOffsets=clean.length?clean:[0];e.packet=null;this._publishTile(String(tileKey));return true;}
  setWorldInstances(instanceMap){let changed=false;for(const [key,e] of this.tiles){const offsets=instanceMap?.get?.(String(key));const clean=offsets?[...offsets].map(Number).filter(Number.isFinite):[0];const next=[...new Set(clean)].sort((a,b)=>a-b);const use=next.length?next:[0];if(JSON.stringify(e.worldOffsets)!==JSON.stringify(use)){e.worldOffsets=use;e.packet=null;changed=true;}}if(changed)this._publishAll();return changed;}
  removeTile(tileKey){const key=String(tileKey),e=this.tiles.get(key);if(!e)return false;this.tiles.delete(key);e.sink.clear();this._removePacket(key);return true;}
  clear(){for(const e of this.tiles.values())e.sink.clear();this.tiles.clear();this._publishAll();}
  setLayerState(state={}){const next={visible:state.visible!==false,opacity:Math.max(0,Math.min(1,Number(state.opacity??1))),zIndex:Number(state.zIndex??0)};const prev=this.layerState;if(next.visible===prev.visible&&next.opacity===prev.opacity&&next.zIndex===prev.zIndex)return prev;this.layerState=next;for(const e of this.tiles.values()){e.sink.setLayerState(next);e.packet=null;}this._publishAll();return next;}
  _packet(e){
    if(e.packet)return e.packet;
    const refs=[];
    const offsets=e.worldOffsets?.length?e.worldOffsets:[0];
    for(const offset of offsets)for(const r of e.sink.references)
      refs.push(offset===0?{...r,sceneWorldOffsetX:0}:{...r,id:`${r.id}:world:${offset}`,sceneWorldOffsetX:offset});
    return (e.packet=refs);
  }
  _publishTile(key){
    if(typeof this.referencePublisher.publishTile!=='function')return this.flush();
    this.referencePublisher.publishTile(key,this._packet(this.tiles.get(key)));
  }
  _removePacket(key){
    if(typeof this.referencePublisher.removeTile!=='function')return this.flush();
    this.referencePublisher.removeTile(key);
  }
  _publishAll(){
    if(typeof this.referencePublisher.replaceTiles!=='function')return this.flush();
    this.referencePublisher.replaceTiles(new Map([...this.tiles].map(([key,e])=>[key,this._packet(e)])));
  }
  flush(){const __t=performance.now();const refs=[];for(const e of this.tiles.values())for(const r of this._packet(e))refs.push(r);if(typeof this.referencePublisher.replaceTiles==='function')this.referencePublisher.replaceTiles(new Map([...this.tiles].map(([key,e])=>[key,this._packet(e)])));
    else this.referencePublisher(refs,this);const __s=((globalThis.__m5Stage||={}).tileSinkFlush||={calls:0,totalMs:0,refs:0});__s.calls++;__s.totalMs+=performance.now()-__t;__s.refs+=refs.length;return refs;}
  get references(){const out=[];for(const e of this.tiles.values())for(const r of this._packet(e))out.push(r);return out;}
  get tileCount(){return this.tiles.size;}
}
