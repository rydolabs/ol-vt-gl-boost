/** Public opt-in CPU-first OpenLayers Vector Tile GL integration.
 * The host still owns DOM/target policy; source-only mode restores stock OL
 * rendering and hides the optimized overlay on runtime failure.
 */
import {DirectM5SceneBinding} from './ol/scene.js';
import {WebGL1Backend} from './gl/backend.js';
import {OlStockRenderGate} from './ol/OlStockRenderGate.js';
export class OLVectorTileBoost {
  constructor({map,canvas=null,backend=null,backendOptions={},resourceManager=null,
    canvasMode='external',canvasFactory=null,vectorTileOptions={},
    layerStyleResolver=null,onError=null,strictVectorTiles=true,deferredWorker=null,
    stockOlRenderMode='normal'}={}){
    if(!['normal','source-only'].includes(stockOlRenderMode))throw Error('Unsupported stockOlRenderMode');
    if(!map)throw Error('OLVectorTileBoost requires an OpenLayers map');
    if(!canvas&&!backend)throw Error('OLVectorTileBoost requires a canvas or WebGL backend');
    this.map=map;this.backend=backend??new WebGL1Backend(canvas,backendOptions);
    this.stockOlRenderMode=stockOlRenderMode;this.failed=false;this._preFaultDisplay=undefined;
    this.canvas=canvas??this.backend.canvas;
    const failClosed=info=>{
      if(this.stockOlRenderMode==='source-only'&&!this.failed){
        this.failed=true;this.stockGate?.stop();this.scene?.stop();
        if(this.canvas?.style){
          this._preFaultDisplay=this.canvas.style.display;
          this.canvas.style.display='none';
        }
        this.map.render?.();
      }
      onError?.(info);
    };
    this.scene=new DirectM5SceneBinding({map,backend:this.backend,canvas:this.canvas,resourceManager,
      canvasMode,canvasFactory,vectorTileOptions,layerStyleResolver,
      onError:stockOlRenderMode==='source-only'?failClosed:onError,strictVectorTiles,deferredWorker});
    this.stockGate=stockOlRenderMode==='source-only'?new OlStockRenderGate({map,scene:this.scene,onError:failClosed}):null;
  }
  get started(){return this.scene.started;}
  get workerEnabled(){return this.scene.deferredWorker!==null;}
  get sourceOnlyActive(){return this.stockGate?.active===true;}
  start(options){
    if(!this.stockGate){this.scene.start(options);return this;}
    if(this.scene.started)return this;
    this.failed=false;
    if(this._preFaultDisplay!==undefined&&this.canvas?.style){
      this.canvas.style.display=this._preFaultDisplay;
      this._preFaultDisplay=undefined;
    }
    try{
      this.scene.start({...(options||{}),renderSync:false});
      this.stockGate.start();
      if(options?.renderSync!==false)this.map.renderSync?.();
      return this;
    }catch(error){this.stockGate.stop();this.scene.stop();throw error;}
  }
  stop(){this.stockGate?.stop();this.scene.stop();return this;}
  destroy(){this.stockGate?.stop();this.scene.destroy();return this;}
  sync(){return this.scene.sync();}
  snapshot(){return this.scene.snapshot();}
  restoreAfterContextLoss(backend=this.backend){this.backend=backend;return this.scene.restoreAfterContextLoss(backend);}
}
