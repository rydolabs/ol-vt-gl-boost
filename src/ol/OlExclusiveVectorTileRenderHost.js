/**
 * R73 opt-in exclusive GPU ownership for the DirectM5SceneBinding.
 *
 * OpenLayers' vector tile layer still owns its public source, loader, tile cache
 * and view, but must not issue a second WebGL draw beneath the Boost canvas.
 *
 * IMPORTANT: layer.render is an OpenLayers integration seam, not a documented
 * stable public API. Fail closed on unexpected changes, and never enable this
 * adapter without the real-stock-OL recovery gate. stop() restores the exact
 * original methods before re-enabling OL rendering.
 */
export class OlExclusiveVectorTileRenderHost {
  constructor({map,layers,onError=null}={}){
    if(!map||!Array.isArray(layers)||!layers.length)throw Error('R73 requires map and vector-tile layers');
    this.map=map;this.layers=layers;this.onError=onError;
    this.active=false;this.originals=new Map();this.disposer=null;
    this.tileRequests=0;this.suppressedDraws=0;
    this._frame=e=>{try{this.prime(e?.frameState);}catch(error){this.stop();this.onError?.(error);}};
  }
  _source(layer){
    const source=layer?.getSource?.();
    if(!source||typeof source.getTile!=='function'||typeof source.getSourceTiles!=='function'||
      typeof source.getTileGrid!=='function')throw Error('R73 requires OL VectorTileSource public tile API');
    return source;
  }
  start(){
    if(this.active)return this;
    // Validate all layers before mutating any of them.
    for(const layer of this.layers){
      this._source(layer);
      if(typeof layer.render!=='function'||Object.prototype.hasOwnProperty.call(layer,'render'))
        throw Error('R73 cannot safely intercept this OL layer renderer');
    }
    try{
      for(const layer of this.layers){
        const original=layer.render;
        this.originals.set(layer,original);
        const host=this;
        layer.render=function(frameState,target){
          if(!host.active)return original.call(this,frameState,target);
          host.suppressedDraws++;
          return null;
        };
      }
      this.active=true;
      const key=this.map.on?.('postrender',this._frame);
      this.disposer=()=>{if(typeof this.map.un==='function')this.map.un('postrender',this._frame);else key?.unlisten?.();};
      return this;
    }catch(error){this.stop();throw error;}
  }
  prime(frameState){
    if(!this.active)return 0;
    const view=this.map.getView?.(),projection=frameState?.viewState?.projection||view?.getProjection?.();
    const resolution=Number(frameState?.viewState?.resolution??view?.getResolution?.());
    const size=frameState?.size||this.map.getSize?.();
    const extent=frameState?.extent||(size&&view?.calculateExtent?.(size));
    if(!projection||!Number.isFinite(resolution)||resolution<=0||!extent)return 0;
    let requested=0;
    for(const layer of this.layers){
      if(layer.getVisible?.()===false)continue;
      const source=this._source(layer),grid=source.getTileGrid()||source.getTileGridForProjection?.(projection);
      if(!grid)throw Error('R73 source tile grid unavailable');
      const z=grid.getZForResolution(resolution,source.zDirection??0);
      const range=grid.getTileRangeForExtentAndZ(extent,z);
      if(!range)continue;
      const full=grid.getFullTileRange?.(z);
      for(let x=range.minX;x<=range.maxX;x++)for(let y=range.minY;y<=range.maxY;y++){
        if(full&&(y<full.minY||y>full.maxY))continue;
        if(full&&(x<full.minX||x>full.maxX)&&!source.getWrapX?.())continue;
        const coord=source.getTileCoordForTileUrlFunction?.([z,x,y],projection)||[z,x,y];
        if(!coord)continue;
        const renderTile=source.getTile(coord[0],coord[1],coord[2],1,projection);
        const tiles=source.getSourceTiles(resolution,projection,renderTile);
        if(!Array.isArray(tiles))throw Error('R73 source tile loader contract changed');
        requested+=tiles.length;
      }
    }
    this.tileRequests+=requested;
    return requested;
  }
  stop(){
    this.active=false;
    this.disposer?.();this.disposer=null;
    for(const [layer,original] of this.originals){
      if(Object.prototype.hasOwnProperty.call(layer,'render'))delete layer.render;
      if(layer.render!==original)layer.render=original;
    }
    this.originals.clear();
    return this;
  }
  snapshot(){return {active:this.active,tileRequests:this.tileRequests,suppressedDraws:this.suppressedDraws,restored:this.originals.size===0};}
}
