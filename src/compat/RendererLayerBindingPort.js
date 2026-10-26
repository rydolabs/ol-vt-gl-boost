import { NeutralGeometryCompiler } from '../tile/NeutralGeometryCompiler.js';
import { RendererFeatureSink } from './RendererFeatureSink.js';
import { RendererVectorTileSink } from './RendererVectorTileSink.js';

/** Host-neutral port that materializes one RendererFeatureSink per scene layer. */
export class RendererLayerBindingPort {
  constructor({renderer,sceneCoordinator,geometryCompiler=new NeutralGeometryCompiler(),styleCompiler}={}){
    if(!renderer)throw new Error('RendererLayerBindingPort requires renderer');
    if(!sceneCoordinator)throw new Error('RendererLayerBindingPort requires sceneCoordinator');
    if(typeof styleCompiler!=='function')throw new Error('RendererLayerBindingPort requires styleCompiler');
    this.renderer=renderer;this.sceneCoordinator=sceneCoordinator;this.geometryCompiler=geometryCompiler;this.styleCompiler=styleCompiler;this.sinks=new Map();
  }
  createLayer(key,{state={},sequence=0}={}){
    const id=String(key);if(this.sinks.has(id))return this.sinks.get(id);
    const sink=new RendererFeatureSink({renderer:this.renderer,geometryCompiler:this.geometryCompiler,styleCompiler:this.styleCompiler,referencePublisher:this.sceneCoordinator.publisher(id,{...state,sequence})});
    sink.setLayerState(state);this.sinks.set(id,sink);this.sceneCoordinator.updateLayer(id,{...state,sequence});return sink;
  }
  createVectorTileLayer(key,{state={},sequence=0}={}){
    const id=String(key);if(this.sinks.has(id))return this.sinks.get(id);
    const sink=new RendererVectorTileSink({renderer:this.renderer,geometryCompiler:this.geometryCompiler,styleCompiler:this.styleCompiler,referencePublisher:this.sceneCoordinator.publisher(id,{...state,sequence})});
    sink.setLayerState(state);this.sinks.set(id,sink);this.sceneCoordinator.updateLayer(id,{...state,sequence});return sink;
  }
  updateLayer(key,{state={},sequence=0}={}){
    const id=String(key),sink=this.sinks.get(id);if(sink)sink.setLayerState(state);this.sceneCoordinator.updateLayer(id,{...state,sequence});return sink||null;
  }
  removeLayer(key){
    const id=String(key),sink=this.sinks.get(id);if(sink)sink.clear();this.sinks.delete(id);return this.sceneCoordinator.removeLayer(id);
  }
  clear(){for(const key of [...this.sinks.keys()])this.removeLayer(key);}
  get layerCount(){return this.sinks.size;}
}
