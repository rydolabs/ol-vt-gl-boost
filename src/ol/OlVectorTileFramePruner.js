function on(target,type,fn){
  if(typeof target?.on==='function'){const key=target.on(type,fn);return ()=>{if(typeof target.un==='function')target.un(type,fn);else key?.unlisten?.();};}
  if(typeof target?.addEventListener==='function'){target.addEventListener(type,fn);return ()=>target.removeEventListener?.(type,fn);}
  throw new Error('target must expose on/un or addEventListener/removeEventListener');
}
function tileKey(coord){return `${coord[0]}/${coord[1]}/${coord[2]}`;}
function finiteExtent(extent){return Array.isArray(extent)&&extent.length>=4&&extent.every(Number.isFinite);}
function projectionExtent(projection){return projection?.getExtent?.()||projection?.extent_||null;}
function projectionGlobal(projection){return typeof projection?.isGlobal==='function'?projection.isGlobal():Boolean(projection?.global_);}
function modulo(n,m){return ((n%m)+m)%m;}
function normalizeTileCoord(grid,coord,{wrapX=false,projection=null}={}){
  if(!coord)return null;const [z,x,y]=coord;const full=grid?.getFullTileRange?.(z)||null;
  if(full){if(y<full.minY||y>full.maxY)return null;if(x<full.minX||x>full.maxX){if(!(wrapX&&projectionGlobal(projection)))return null;const width=full.maxX-full.minX+1;return [z,full.minX+modulo(x-full.minX,width),y];}}
  return [z,x,y];
}

/**
 * OpenLayers-public-API-only active source-tile tracker.
 *
 * It derives the source-tile z/x/y set from the current frame extent and the
 * source TileGrid, then prunes tile payloads that have been outside the active
 * viewport for `graceFrames` completed render frames. No OL cache/private
 * fields are inspected. World wrapping is normalized explicitly so repeated
 * wrapped worlds map to one source-tile residency key.
 */
export class OlVectorTileFramePruner {
  constructor({map,source,sourceAdapter,graceFrames=2,bufferTiles=0,onActive=null}={}){
    if(!map)throw new Error('OlVectorTileFramePruner requires map');
    if(!source)throw new Error('OlVectorTileFramePruner requires source');
    if(!sourceAdapter?.prune)throw new Error('OlVectorTileFramePruner requires sourceAdapter.prune');
    this.map=map;this.source=source;this.sourceAdapter=sourceAdapter;
    this.graceFrames=Math.max(0,Math.floor(Number(graceFrames)||0));
    this.bufferTiles=Math.max(0,Math.floor(Number(bufferTiles)||0));
    this.onActive=typeof onActive==='function'?onActive:null;
    this.frame=0;this.lastSeen=new Map();this.disposer=null;this.started=false;this.lastActive=new Set();this.pruned=0;
  }
  _projection(frameState){return frameState?.viewState?.projection||this.map?.getView?.()?.getProjection?.()||null;}
  _resolution(frameState){return Number(frameState?.viewState?.resolution??this.map?.getView?.()?.getResolution?.());}
  activeInstances(frameState){
    const extent=frameState?.extent;const resolution=this._resolution(frameState);const projection=this._projection(frameState);
    if(!finiteExtent(extent)||!Number.isFinite(resolution)||resolution<=0)return new Map();
    const grid=this.source.getTileGrid?.()||this.source.getTileGridForProjection?.(projection);if(!grid)return new Map();
    const z=grid.getZForResolution?.(resolution,this.source.zDirection??0);if(!Number.isFinite(z))return new Map();
    const range=grid.getTileRangeForExtentAndZ?.(extent,z);if(!range)return new Map();
    const out=new Map(),wrapX=Boolean(this.source.getWrapX?.()),full=grid.getFullTileRange?.(z)||null;
    const pe=projectionExtent(projection);const worldWidth=pe&&Number.isFinite(pe[0])&&Number.isFinite(pe[2])?Number(pe[2])-Number(pe[0]):0;
    for(let x=range.minX-this.bufferTiles;x<=range.maxX+this.bufferTiles;x++)for(let y=range.minY-this.bufferTiles;y<=range.maxY+this.bufferTiles;y++){
      let world=0;
      if(full&&wrapX&&projectionGlobal(projection)&&worldWidth>0){const width=full.maxX-full.minX+1;world=Math.floor((x-full.minX)/width);}
      let coord=normalizeTileCoord(grid,[z,x,y],{wrapX,projection});if(!coord)continue;
      if(typeof this.source.getTileCoordForTileUrlFunction==='function')coord=this.source.getTileCoordForTileUrlFunction(coord,projection);
      if(!coord)continue;
      const key=tileKey(coord),offset=world*worldWidth;
      if(!out.has(key))out.set(key,new Set());out.get(key).add(offset);
    }
    return out;
  }
  activeKeys(frameState){return new Set(this.activeInstances(frameState).keys());}
  sync(frameState){
    this.frame++;const instances=this.activeInstances(frameState),active=new Set(instances.keys());this.lastActive=active;
    for(const key of active)this.lastSeen.set(String(key),this.frame);
    this.sourceAdapter.reactivate?.(active);
    this.sourceAdapter.setWorldInstances?.(instances);
    const keep=[];
    for(const key0 of this.sourceAdapter.tiles?.keys?.()||[]){const key=String(key0);if(!this.lastSeen.has(key))this.lastSeen.set(key,this.frame);const seen=this.lastSeen.get(key);if(active.has(key)||(seen!=null&&this.frame-seen<=this.graceFrames))keep.push(key);}
    const before=this.sourceAdapter.tiles?.size??0;const pruned=this.sourceAdapter.prune(keep)||0;this.pruned+=pruned;
    for(const key of [...this.lastSeen.keys()])if(!this.sourceAdapter.tiles?.has?.(key)&&this.frame-(this.lastSeen.get(key)||0)>this.graceFrames)this.lastSeen.delete(key);
    this.onActive?.({frame:this.frame,active:new Set(active),kept:new Set(keep),pruned,before,after:this.sourceAdapter.tiles?.size??0});
    return {active,kept:new Set(keep),pruned};
  }
  start(){if(this.started)return this;this.started=true;this.disposer=on(this.map,'postrender',e=>this.sync(e?.frameState));return this;}
  stop(){this.disposer?.();this.disposer=null;this.started=false;this.lastSeen.clear();this.lastActive=new Set();return this;}
}
