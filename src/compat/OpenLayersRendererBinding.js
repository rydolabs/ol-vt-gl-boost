import { OpenLayersAdapter } from '../ol/OpenLayersAdapter.js';
import { OlMapFrameBridge } from '../ol/frame.js';
import { OlMapSceneAdapter } from '../ol/OlMapSceneAdapter.js';
import { OlTargetLifecycleAdapter } from '../ol/host.js';
import { OlCanvasHost } from '../ol/host.js';
import { toRendererStyle } from '../ol/OlStyleAdapter.js';
import { NeutralGeometryCompiler } from '../tile/NeutralGeometryCompiler.js';
import { RendererLayerBindingPort } from './RendererLayerBindingPort.js';
import { RendererSceneCoordinator } from './RendererSceneCoordinator.js';

/**
 * Product-facing composition root for attaching the optimized renderer to an OL map.
 * OL observation stays in adapters; renderer/core remains host-neutral.
 *
 * Product policies:
 * - targetPolicy='retain' (default): target=null does not alter resource state.
 * - targetPolicy='suspend': target=null releases scene bindings and resumes when reattached.
 * - canvasMode='external' (default): caller owns the canvas.
 * - canvasMode='managed-overlay': this binding owns/mounts an overlay canvas. When no
 *   renderer is supplied, rendererFactory({canvas,map}) must create it.
 */
export class OpenLayersRendererBinding {
  /** Opt-in MVT Feature -> shared GPU buffers -> M4 WebGL scene. Legacy default remains unchanged. */
  static async createDirectScene(options={}){
    const {DirectM5SceneBinding}=await import('../ol/scene.js');
    return new DirectM5SceneBinding(options);
  }
  constructor({
    map,renderer=null,rendererFactory=null,canvas=null,canvasMode='external',canvasFactory=null,
    targetPolicy='retain',geometryCompiler=new NeutralGeometryCompiler(),styleCompiler=toRendererStyle,featureOptions={},vectorTileOptions={},layerStyleResolver=null,batchSceneUpdates=false,
    onEvent=null,onError=null,telemetry=null
  }={}){
    if(!map)throw new Error('OpenLayersRendererBinding requires map');
    if(!['retain','suspend'].includes(targetPolicy))throw new Error(`Unsupported targetPolicy: ${targetPolicy}`);
    this.map=map;this.targetPolicy=targetPolicy;this.geometryCompiler=geometryCompiler;this.styleCompiler=styleCompiler;this.featureOptions=featureOptions;this.vectorTileOptions=vectorTileOptions||{};this.layerStyleResolver=typeof layerStyleResolver==='function'?layerStyleResolver:null;
    this.onEvent=typeof onEvent==='function'?onEvent:null;this.onError=typeof onError==='function'?onError:null;this.telemetry=telemetry;
    this.canvasHost=new OlCanvasHost({map,canvas,mode:canvasMode,canvasFactory});this.canvas=this.canvasHost.canvas;
    if(!renderer){if(typeof rendererFactory!=='function')throw new Error('OpenLayersRendererBinding requires renderer or rendererFactory');renderer=rendererFactory({canvas:this.canvas,map});}
    if(!renderer)throw new Error('rendererFactory did not return a renderer');this.renderer=renderer;
    this.sceneCoordinator=new RendererSceneCoordinator({renderer,batchUpdates:batchSceneUpdates});
    this.layerPort=new RendererLayerBindingPort({renderer,sceneCoordinator:this.sceneCoordinator,geometryCompiler,styleCompiler});
    this.sceneAdapter=null;this.frameAdapter=null;this.frameBridge=null;this.targetAdapter=null;
    this.started=false;this.suspended=false;this.destroyed=false;this.startCount=0;this.stopCount=0;this.suspendCount=0;this.resumeCount=0;this.errorCount=0;this.eventCount=0;
    this._bindMap(map);
  }
  _record(name,detail={}){try{if(typeof this.telemetry==='function')this.telemetry(name,detail);else this.telemetry?.record?.(name,detail);}catch(_){} }
  _emit(type,detail={}){const event={type,binding:this,map:this.map,...detail};this.eventCount++;this._record(type,detail);try{this.onEvent?.(event);}catch(error){this._handleError(error,{phase:'onEvent',eventType:type},false);}return event;}
  _handleError(error,context={},rethrow=true){this.errorCount++;const detail={error,context};this._record('binding:error',{message:String(error?.message||error),context});try{this.onError?.(detail);}catch(_){}try{this.onEvent?.({type:'binding:error',binding:this,map:this.map,...detail});}catch(_){}if(rethrow)throw error;return error;}
  _bindMap(map){
    if(!map)throw new Error('OpenLayersRendererBinding requires map');
    this.map=map;this.canvasHost.setMap(map);
    this.sceneAdapter=new OlMapSceneAdapter({map,layerPort:this.layerPort,featureOptions:this.featureOptions,vectorTileOptions:this.vectorTileOptions,layerStyleResolver:this.layerStyleResolver});
    this.frameAdapter=new OpenLayersAdapter({sink:{setFrame:(frame)=>this.renderer.setFrame?.(frame)}});
    this.frameBridge=new OlMapFrameBridge({map,adapter:this.frameAdapter,renderer:this.renderer,canvas:this.canvas,beforeRender:()=>this.sceneCoordinator.flushPending()});
    this.targetAdapter=new OlTargetLifecycleAdapter({map,onDetach:()=>this._onTargetDetach(),onAttach:()=>this._onTargetAttach()});
  }
  _activate({renderSync=true}={}){
    this.canvasHost.attach();this.sceneAdapter.start({initialSync:true});this.frameBridge.start({renderSync});this.suspended=false;this._emit('binding:attach',{renderSync,canvas:this.canvasHost.snapshot()});return this;
  }
  _deactivate({detachCanvas=false}={}){
    this.frameBridge.stop();this.sceneAdapter.stop();this.layerPort.clear();if(detachCanvas)this.canvasHost.detach();this._emit('binding:detach',{canvas:this.canvasHost.snapshot()});return this;
  }
  _onTargetDetach(){
    this._emit('binding:target-detach',{policy:this.targetPolicy});
    if(this.targetPolicy==='suspend'&&this.started&&!this.suspended){try{this._deactivate({detachCanvas:true});this.suspended=true;this.suspendCount++;this._emit('binding:suspend');}catch(error){this._handleError(error,{phase:'target-detach'},false);}}
  }
  _onTargetAttach(){
    this._emit('binding:target-attach',{policy:this.targetPolicy});
    if(this.targetPolicy==='suspend'&&this.started&&this.suspended){try{this._activate({renderSync:true});this.resumeCount++;this._emit('binding:resume');}catch(error){this._handleError(error,{phase:'target-attach'},false);}}
  }
  start({renderSync=true}={}){
    if(this.destroyed)throw new Error('OpenLayersRendererBinding is destroyed');if(this.started)return this;
    try{this.started=true;this.startCount++;this.targetAdapter.start();const attached=this.targetAdapter.attached;if(this.targetPolicy==='suspend'&&!attached){this.suspended=true;this.canvasHost.detach();}else this._activate({renderSync});this._emit('binding:start',{renderSync,suspended:this.suspended});return this;}catch(error){this.started=false;return this._handleError(error,{phase:'start'});}
  }
  stop(){
    if(!this.started){this.layerPort.clear();this.canvasHost.detach();return this;}
    try{this.targetAdapter.stop();this._deactivate({detachCanvas:true});this.started=false;this.suspended=false;this.stopCount++;this._emit('binding:stop');return this;}catch(error){return this._handleError(error,{phase:'stop'});}
  }
  /** Backward-compatible non-terminal stop alias. */
  dispose(){return this.stop();}
  /** Terminal cleanup for product hosts. */
  destroy(){if(this.destroyed)return this;this.stop();this.canvasHost.destroy();this.destroyed=true;this._emit('binding:destroy');return this;}
  setMap(map,{restart=this.started,renderSync=true}={}){
    if(this.destroyed)throw new Error('OpenLayersRendererBinding is destroyed');if(!map)throw new Error('OpenLayersRendererBinding.setMap requires map');if(map===this.map)return this;
    const wasStarted=this.started,oldMap=this.map;
    try{this.stop();this._bindMap(map);if(restart&&wasStarted)this.start({renderSync});this._emit('binding:map-change',{oldMap,newMap:map});return this;}catch(error){return this._handleError(error,{phase:'setMap'});}
  }
  sync(){if(!this.started)throw new Error('OpenLayersRendererBinding is not started');if(this.suspended)return this.snapshot();try{this.sceneAdapter.sync();return this.snapshot();}catch(error){return this._handleError(error,{phase:'sync'});}}
  snapshot(){return {started:this.started,suspended:this.suspended,destroyed:this.destroyed,layers:this.sceneAdapter?.snapshot?.()||[],references:this.sceneCoordinator.references.length,startCount:this.startCount,stopCount:this.stopCount,suspendCount:this.suspendCount,resumeCount:this.resumeCount,errorCount:this.errorCount,eventCount:this.eventCount,canvas:this.canvasHost.snapshot()};}
  get layerCount(){return this.sceneAdapter?.layerCount||0;}
  get referenceCount(){return this.sceneCoordinator.references.length;}
}
