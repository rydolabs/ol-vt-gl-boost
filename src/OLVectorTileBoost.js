/** Opt-in CPU-first OpenLayers Vector Tile GL integration.
 * stockOlRenderMode='exclusive' is experimental and OL 10.10.0-pinned.
 * Any unexpected adapter error restores stock OL before notifying the caller.
 */
import {DirectM5SceneBinding} from './ol/scene.js';
import {WebGL1Backend} from './gl/backend.js';
import {OlExclusiveVectorTileRenderHost} from './ol/OlExclusiveVectorTileRenderHost.js';

export class OLVectorTileBoost {
  constructor({map,canvas=null,backend=null,backendOptions={},resourceManager=null,
    canvasMode='external',canvasFactory=null,vectorTileOptions={},
    layerStyleResolver=null,onError=null,strictVectorTiles=true,deferredWorker=null,
    stockOlRenderMode='normal'}={}){
    if(!map)throw Error('OLVectorTileBoost requires an OpenLayers map');
    if(!canvas&&!backend)throw Error('OLVectorTileBoost requires a canvas or WebGL backend');
    if(!['normal','exclusive'].includes(stockOlRenderMode))throw Error('Unsupported stockOlRenderMode');
    this.map=map;this.backend=backend??new WebGL1Backend(canvas,backendOptions);
    this.canvas=canvas??this.backend.canvas;
    this.stockOlRenderMode=stockOlRenderMode;this.exclusiveHost=null;
    this.failed=false;this._savedDisplay=null;this._onError=onError;
    const failClosed=({error,phase}={})=>{
      if(this.stockOlRenderMode==='exclusive'&&!this.failed){
        this.failed=true;
        try{this.exclusiveHost?.stop();}catch{}
        try{this.scene?.stop();}catch{}
        if(this.canvas?.style){
          this._savedDisplay=this.canvas.style.display;
          this.canvas.style.display='none';
        }
        try{this.map.render?.();}catch{}
      }
      this._onError?.({error,phase});
    };
    this.scene=new DirectM5SceneBinding({map,backend:this.backend,canvas:this.canvas,resourceManager,
      canvasMode,canvasFactory,
      vectorTileOptions:stockOlRenderMode==='exclusive'?{
        ...vectorTileOptions,isolatedTileFboFastPath:vectorTileOptions.isolatedTileFboFastPath!==false
      }:vectorTileOptions,layerStyleResolver,
      onError:stockOlRenderMode==='exclusive'?failClosed:onError,strictVectorTiles,deferredWorker});
    this._failClosed=failClosed;
    // The single-renderer integration owns tile clipping while active.
    // Clip to each source tile before disjoint-domain FBO eligibility checks.
    // Explicit opt-out retains the original OL-style compositor.
    if(stockOlRenderMode==='exclusive'&&vectorTileOptions.tileScissorEnabled!==false)
      this.scene.bridge.pipeline.tileScissorEnabled=true;
  }
  get started(){return this.scene.started;}
  get workerEnabled(){return this.scene.deferredWorker!==null;}
  get exclusiveActive(){return this.exclusiveHost?.active===true;}
  start(options){
    if(this.started)return this;
    if(this.stockOlRenderMode==='normal'){this.scene.start(options);return this;}
    this.failed=false;
    if(this._savedDisplay!==null&&this.canvas?.style){
      this.canvas.style.display=this._savedDisplay;
      this._savedDisplay=null;
    }
    try{
      this.scene.start({...(options||{}),renderSync:false});
      const layers=[...this.scene.layers.values()].map(state=>state.layer);
      this.exclusiveHost=new OlExclusiveVectorTileRenderHost({
        map:this.map,layers,profilePriming:this.scene.vectorTileOptions.profileCPU===true,
        getLayers:()=>[...this.scene.layers.values()].map(state=>state.layer),
        onError:error=>this._failClosed({error,phase:'exclusive-renderer'})});
      this.exclusiveHost.start();
      if(options?.renderSync!==false)this.map.renderSync?.();
      return this;
    }catch(error){
      this._failClosed({error,phase:'exclusive-start'});
      throw error;
    }
  }
  stop(){this.exclusiveHost?.stop();this.scene.stop();return this;}
  destroy(){this.exclusiveHost?.stop();this.scene.destroy();return this;}
  sync(){return this.scene.sync();}
  snapshot(){return {...this.scene.snapshot(),exclusiveHost:this.exclusiveHost?.snapshot()??null};}
  restoreAfterContextLoss(backend=this.backend){
    this.backend=backend;return this.scene.restoreAfterContextLoss(backend);
  }
}
