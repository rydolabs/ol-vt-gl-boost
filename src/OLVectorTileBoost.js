/** Public opt-in CPU-first OpenLayers Vector Tile GL integration.
 * Actual stock OpenLayers fallback remains the application's responsibility.
 */
import {DirectM5SceneBinding} from './ol/scene.js';
import {WebGL1Backend} from './gl/backend.js';
export class OLVectorTileBoost {
  constructor({map,canvas=null,backend=null,backendOptions={},resourceManager=null,
    canvasMode='external',canvasFactory=null,vectorTileOptions={},
    layerStyleResolver=null,onError=null,strictVectorTiles=true,deferredWorker=null}={}){
    if(!map)throw Error('OLVectorTileBoost requires an OpenLayers map');
    if(!canvas&&!backend)throw Error('OLVectorTileBoost requires a canvas or WebGL backend');
    this.map=map;this.backend=backend??new WebGL1Backend(canvas,backendOptions);
    this.canvas=canvas??this.backend.canvas;
    this.scene=new DirectM5SceneBinding({map,backend:this.backend,canvas:this.canvas,resourceManager,
      canvasMode,canvasFactory,vectorTileOptions,layerStyleResolver,onError,strictVectorTiles,deferredWorker});
  }
  get started(){return this.scene.started;}
  get workerEnabled(){return this.scene.deferredWorker!==null;}
  start(options){this.scene.start(options);return this;}
  stop(){this.scene.stop();return this;}
  destroy(){this.scene.destroy();return this;}
  sync(){return this.scene.sync();}
  snapshot(){return this.scene.snapshot();}
  restoreAfterContextLoss(backend=this.backend){this.backend=backend;return this.scene.restoreAfterContextLoss(backend);}
}
