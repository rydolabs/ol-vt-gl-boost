/**
 * Opt-in real OpenLayers map/scene lifecycle for the direct MVT -> M4 WebGL path.
 *
 * Unlike the standalone bridge, every visible vector-tile layer shares one
 * backend, one GPU arena, and a global layer/pass-aware draw schedule.
 * Unsupported mixed scenes are rejected, NOT silently drawn with wrong order.
 * The ordinary OpenLayersRendererBinding is unchanged and remains the fallback.
 */
import {OlCanvasHost} from './host.js';
import {OlLayerTreeAdapter} from './layer.js';
import {OlVectorTileSourceAdapter} from './OlVectorTileSourceAdapter.js';
import {OlVectorTileFramePruner} from './OlVectorTileFramePruner.js';
import {toNeutralFrame} from './frame.js';
import {OLDisableWorkerM4Bridge} from './bridge.js';
import {ResourceManager} from '../gl/ResourceManager.js';
import {DeferredDirectTileHandover} from '../optional/worker/DeferredDirectTileHandover.js';

function subscribe(target,name,handler){
  const key=target?.on?.(name,handler);
  if(!key && !target?.un)throw Error('Map requires on()/un() event support');
  return ()=>{if(typeof target?.un==='function')target.un(name,handler);else key?.unlisten?.();};
}
const sourceOf=layer=>layer?.getSource?.()??layer?.source??null;
const styleOf=layer=>layer?.getStyleFunction?.()??layer?.getStyle?.()??null;
const tileSource=source=>!!(source&&typeof source.getTileGrid==='function'&&typeof source.getTile==='function'&&typeof source.getOverlaps==='function');
const ordered=(a,b)=>a.state.zIndex-b.state.zIndex||a.sequence-b.sequence||String(a.key).localeCompare(String(b.key));
export {exactEncodedTile as r45EqualEncodedTile} from '../optional/worker/EncodedTileExactGate.js';
function sameInstances(a,b){
  if(a.size!==b.size)return false;
  for(const [key,offsets] of b){const prior=a.get(key);if(!prior||prior.size!==offsets.size)return false;for(const value of offsets)if(!prior.has(value))return false;}
  return true;
}

export class DirectM5SceneBinding {
  constructor({map,backend,resourceManager=null,canvas=null,canvasMode='external',canvasFactory=null,
    vectorTileOptions={},layerStyleResolver=null,onError=null,strictVectorTiles=true,deferredWorker=null}={}){
    if(!map||!backend)throw Error('DirectM5SceneBinding requires an OL map and M4 WebGL backend');
    if(strictVectorTiles!==true)throw Error('Mixed legacy/direct scene composition is unsupported; use strictVectorTiles:true');
    this.map=map;this.backend=backend;this.resourceManager=resourceManager||new ResourceManager({backend});
    this.bridge=new OLDisableWorkerM4Bridge({backend,resourceManager:this.resourceManager,
      gpuArenaHeadroomFactor:vectorTileOptions.gpuArenaHeadroomFactor??1});
    this.canvasHost=new OlCanvasHost({map,canvas:canvas||backend.canvas,mode:canvasMode,canvasFactory});
    this.vectorTileOptions=vectorTileOptions;this.layerStyleResolver=layerStyleResolver;
    this.onError=onError;this.layers=new Map();
    // Disabled unless an application supplies a PBF-byte task resolver. A
    // failed/unsupported task leaves the already-painted CPU tile intact.
    this._deferredConfig=deferredWorker?.enabled===true?deferredWorker:null;
    this._newDeferredWorker=()=>new DeferredDirectTileHandover({...this._deferredConfig,
      getCpuEncoded:(state,key)=>this.bridge.tiles.get(this._key(state.key,key)),
        onError:error=>this.onError?.({error,phase:'deferred-worker'})});
    this.deferredWorker=this._deferredConfig?this._newDeferredWorker():null;this.tree=null;this.disposeFrame=null;
    this.started=false;this.frames=0;this.lastFrameStats=null;this.lastSchedule=[];
    this._tileProfiles=new Map();
    this.cacheSceneSchedule=vectorTileOptions.cacheSceneSchedule===true;
    this._scheduleDirty=true;this._cachedSchedule=null;this.scheduleBuilds=0;this.scheduleCacheHits=0;
    this._onFrame=event=>{try{if(event?.frameState)this.renderFrame(event.frameState);}catch(error){this._error(error,'frame');}};
  }
  _error(error,phase){this.onError?.({error,phase});throw error;}
  _key(layerKey,tileKey){return `${layerKey}::${tileKey}`;}
  _bind(entry){
    const source=sourceOf(entry.layer);
    if(!tileSource(source))throw Error(`Direct M5 Scene only supports vector tile sources; layer ${entry.key} requires legacy renderer`);
    const state={key:String(entry.key),layer:entry.layer,source,sequence:Number(entry.sequence||0),state:{...entry.state},worldInstances:new Map()};
    const sink={
      replaceRawTile:(tileKey,features,options)=>{
        const fullKey=this._key(state.key,tileKey);
        const diagnostics=this.vectorTileOptions.profileCPU?{}:null;
        const result=this.bridge.replaceRawTile(fullKey,features,{...options,opacity:state.state.opacity,
          ...(diagnostics?{diagnostics}:{})});
        if(diagnostics)this._tileProfiles.set(fullKey,diagnostics);
        this._scheduleDirty=true;this.map.render?.();return result;
      },
      replaceEncodedTile:(tileKey,encoded,options={})=>{
        const fullKey=this._key(state.key,tileKey);
        const diagnostics=this.vectorTileOptions.profileCPU?{}:null;
        const result=this.bridge.replaceEncodedTile(fullKey,encoded,{
          transferGpuBuffers:true,featureCount:options.featureCount,
          ...(diagnostics?{diagnostics}:{})});
        if(diagnostics)this._tileProfiles.set(fullKey,diagnostics);
        this._scheduleDirty=true;this.map.render?.();return result;
      },
      removeTile:tileKey=>{this.deferredWorker?.invalidateTile(state,tileKey);const key=this._key(state.key,tileKey);const result=this.bridge.removeTile(key);
        this._tileProfiles.delete(key);this._scheduleDirty=true;this.map.render?.();return result;},
      setWorldInstances:instances=>{const next=new Map(instances);
        if(!sameInstances(state.worldInstances,next)){state.worldInstances=next;this._scheduleDirty=true;}return true;},
    };
    const style=this.layerStyleResolver?.(entry.layer);
    state.styleLike=style??styleOf(entry.layer);
    const opts=this.vectorTileOptions;
    const adapter=new OlVectorTileSourceAdapter({source,sink,
      onCpuTile:(tile,context)=>this.deferredWorker?.enqueue({state,tile,...context}),
      styleLike:state.styleLike,sourceLayerStyles:opts.sourceLayerStyles,
      sourceLayerFilter:opts.sourceLayerFilter,sourceLayerStyleResolver:opts.sourceLayerStyleResolver,
      targetProjectionProvider:()=>this.map.getView?.()?.getProjection?.()??null,
      coordinateTransform:opts.coordinateTransform,styleArrayMode:opts.styleArrayMode,
      maxInactiveTiles:0,maxInactiveBytes:0,
      resolutionProvider:()=>this.map.getView?.()?.getResolution?.()??1,
      transferGpuBuffers:true,drawMode:opts.drawMode??'painter',layerProperty:opts.layerProperty??'layer',
      polygonInsideSegmentFastPath:opts.polygonInsideSegmentFastPath!==false,polygonEarBBoxPrecheck:opts.polygonEarBBoxPrecheck!==false,
      stableStyleIdentityCache:opts.stableStyleIdentityCache===true,
      polygonStrokeFringePx:opts.polygonStrokeFringePx??0,closedLineJoins:opts.closedLineJoins===true,
    }).start();
    state.sink=sink;state.adapter=adapter;
    state.pruner=new OlVectorTileFramePruner({map:this.map,source,sourceAdapter:adapter,
      graceFrames:opts.graceFrames??2,bufferTiles:opts.bufferTiles??0});
    this.layers.set(state.key,state);this._scheduleDirty=true;
    return state;
  }
  _unbind(key){const state=this.layers.get(String(key));if(!state)return;
    this.deferredWorker?.invalidateState(state);state.adapter.stop();state.pruner.stop();this.layers.delete(String(key));
    for(const profileKey of this._tileProfiles.keys())if(profileKey.startsWith(state.key+'::'))this._tileProfiles.delete(profileKey);
    this._scheduleDirty=true;}
  _snapshot(entries){
    // Reject incompatible scenes BEFORE detaching/replacing the previous one.
    for(const entry of entries)if(!tileSource(sourceOf(entry.layer)))
      throw Error(`Unsupported non-vector-tile layer ${entry.key}; use the ordinary M5 binding`);
    const live=new Set(entries.map(e=>String(e.key)));
    for(const key of [...this.layers.keys()])if(!live.has(key))this._unbind(key);
    for(const entry of entries){
      const key=String(entry.key),source=sourceOf(entry.layer);
      let state=this.layers.get(key);
      if(state&&state.source!==source){this._unbind(key);state=null;}
      if(!state)state=this._bind(entry);
      else{
        const oldOpacity=state.state.opacity,oldStyle=state.styleLike;
        const oldVisible=state.state.visible,oldZ=state.state.zIndex,oldSeq=state.sequence;
        const resolved=this.layerStyleResolver?.(entry.layer);
        const nextStyle=resolved??styleOf(entry.layer);
        state.sequence=Number(entry.sequence||0);state.state={...entry.state};
        state.styleLike=nextStyle;
        if(oldVisible!==state.state.visible||oldZ!==state.state.zIndex||oldSeq!==state.sequence)
          this._scheduleDirty=true;
        // Opacity/style is baked into GPU packet uniforms, while geometry
        // bytes remain identical and the shared arena avoids reupload.
        if(oldStyle!==nextStyle){state.adapter.styleLike=nextStyle;this.deferredWorker?.invalidateState(state);}
        if(oldOpacity!==state.state.opacity||oldStyle!==nextStyle){
          this.deferredWorker?.invalidateState(state);
          for(const tile of [...state.adapter.tiles.values()])state.adapter.ingestTile(tile);
        }
      }
    }
    this.map.render?.();
  }
  start({renderSync=true}={}){
    if(this.started)return this;
    if(this._deferredConfig?.enabled===true&&this.deferredWorker?.closed)
      this.deferredWorker=this._newDeferredWorker();
    try{
      this.canvasHost.attach();
      this.tree=new OlLayerTreeAdapter({map:this.map,onSnapshot:s=>this._snapshot(s)});
      this.tree.start({initialSync:true});
      this.disposeFrame=subscribe(this.map,'postrender',this._onFrame);
      this.started=true;
      if(renderSync)this.map.renderSync?.();
      return this;
    }catch(e){this.stop();throw e;}
  }
  stop(){this.disposeFrame?.();this.disposeFrame=null;this.tree?.stop();this.tree=null;
    for(const key of [...this.layers.keys()])this._unbind(key);
    void this.deferredWorker?.close();
    this.canvasHost.detach();this.started=false;this._scheduleDirty=true;this._cachedSchedule=null;return this;}
  destroy(){this.stop();this.bridge.clear();this.canvasHost.destroy();return this;}
  /** Call after WebGL1Backend.restoreContext() and ResourceManager.handleContextLost(). */
  restoreAfterContextLoss(backend=this.backend){
    this.backend=backend;
    const count=this.bridge.restoreAfterContextLoss(backend);
    this.map.render?.();
    return count;
  }
  sync(){if(!this.started)throw Error('Direct M5 Scene not started');this.tree?.sync();return this.snapshot();}
  /** Build a global painter-order schedule without constructing GeometryStores. */
  buildSchedule(frameState,{prune=true}={}){
    if(!prune){this._scheduleDirty=true;this._cachedSchedule=null;}
    // Pruning first is mandatory even when the rendering order is reusable:
    // it may evict tiles and the remove callback invalidates the cache.
    if(prune)for(const state of this.layers.values())state.pruner.sync(frameState);
    if(prune&&this.cacheSceneSchedule&&!this._scheduleDirty&&this._cachedSchedule){
      this.scheduleCacheHits++;this.lastSchedule=this._cachedSchedule;return this._cachedSchedule;
    }
    const schedule=[];
    for(const state of [...this.layers.values()].sort(ordered)){
      if(state.state.visible===false)continue;
      for(const [localKey] of state.adapter.tiles){
        const key=this._key(state.key,localKey),tile=this.bridge.tiles.get(key);
        if(!tile)continue;
        const offsets=state.worldInstances.get(localKey)||new Set([0]);
        for(const worldOffsetX of offsets){
          if(!Number.isFinite(worldOffsetX))throw Error('Nonfinite wrapped world offset');
          for(let packetIndex=0;packetIndex<tile.packets.length;packetIndex++){
            const packet=tile.packets[packetIndex];
            schedule.push({tileKey:key,packetIndex,worldOffsetX,
              sceneZ:Number(state.state.zIndex??0),sequence:state.sequence,
              passOrder:packet.passOrder,zIndex:packet.zIndex,
              tileKeyOrder:localKey,packetOrder:packet.order});
          }
        }
      }
    }
    schedule.sort((a,b)=>a.sceneZ-b.sceneZ||a.sequence-b.sequence||a.passOrder-b.passOrder||a.zIndex-b.zIndex||
      a.tileKeyOrder.localeCompare(b.tileKeyOrder)||a.packetOrder-b.packetOrder);
    this.lastSchedule=schedule;this.scheduleBuilds++;
    if(prune&&this.cacheSceneSchedule){this._cachedSchedule=schedule;this._scheduleDirty=false;}
    return schedule;
  }
  _renderCompositedLayers(frame,schedule){
    const b=this.backend,gl=b.gl,width=b.canvas.width,height=b.canvas.height;
    // The stock OL vector-tile layers each rasterize to an intermediate RGBA8 target.
    // A direct single-target shader program has different rounding for overlapping
    // translucent layers. This is opt-in and only for multi-layer scenes.
    const prior=this._layerFbo;
    if(prior&&(prior.width!==width||prior.height!==height)){
      gl.deleteFramebuffer(prior.framebuffer);gl.deleteTexture(prior.texture);
      this._layerFbo=null;
    }
    if(!this._layerFbo){
      const framebuffer=gl.createFramebuffer(),texture=gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('OL layer RGBA8 framebuffer incomplete');
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      this._layerFbo={framebuffer,texture,width,height};
    }
    const target=this._layerFbo;
    const vs='attribute vec2 a_vertex;varying vec2 v_uv;void main(){v_uv=(a_vertex+1.0)*0.5;gl_Position=vec4(a_vertex,0.0,1.0);}';
    const fs='precision highp float;uniform sampler2D u_image;varying vec2 v_uv;void main(){gl_FragColor=texture2D(u_image,v_uv);}';
    const program=b.program('r18.layer.composite',vs,fs);
    if(!this._layerFboQuad){
      this._layerFboQuad=b.createBufferResource('ARRAY_BUFFER',32,'STATIC_DRAW');
      b.uploadBufferResource('ARRAY_BUFFER',this._layerFboQuad,0,new Float32Array([-1,-1,1,-1,-1,1,1,1]));
    }
    const flush=items=>{
      if(!items.length)return;
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);
      gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      b.invalidateStateCache();
      this.bridge.pipeline.draw({frame,packetSchedule:items});
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,width,height);
      b.invalidateStateCache();b.disableAllAttribs();b.useProgram(program.program);
      b.bindBuffer(gl.ARRAY_BUFFER,this._layerFboQuad);
      b.bindFloatAttrib(program,'a_vertex',2,0,0,0);
      gl.activeTexture(gl.TEXTURE0);b.bindTexture(gl.TEXTURE_2D,target.texture);
      b.uniform1i(b.uniform(program,'u_image'),0);
      b.drawArrays(gl.TRIANGLE_STRIP,0,4);
      const err=gl.getError();if(err!==gl.NO_ERROR)throw Error("RGBA8 layer composition GL error "+err);
    };
    let group=[],priorLayer=null;
    for(const packet of schedule){
      const layerKey=String(packet.tileKey).split('::',1)[0];
      if(priorLayer!==null&&layerKey!==priorLayer){flush(group);group=[];}
      group.push(packet);priorLayer=layerKey;
    }
    flush(group);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    b.invalidateStateCache();
  }
  renderFrame(frameState){
    const timed=this.vectorTileOptions.profileCPU===true;
    const canvas=this.canvasHost.canvas;
    if(canvas&&frameState?.size){
      const pr=Number(frameState.pixelRatio??1);
      const width=Math.max(1,Math.round(frameState.size[0]*pr)),height=Math.max(1,Math.round(frameState.size[1]*pr));
      if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
    }
    const tSchedule=timed?performance.now():0;
    const schedule=this.buildSchedule(frameState);
    const tDraw=timed?performance.now():0;
    this.backend.beginFrame();
    const neutralFrame=toNeutralFrame(frameState);
    if(this.vectorTileOptions.olLayerFboComposition===true&&this.layers.size>1){
      this._renderCompositedLayers(neutralFrame,schedule);
    }else{
      this.bridge.pipeline.draw({frame:neutralFrame,packetSchedule:schedule});
    }
    const tEnd=timed?performance.now():0;
    this.lastFrameStats=this.backend.endFrame();this.frames++;
    this.deferredWorker?.afterDraw();
    if(timed){this.lastFrameStats.scheduleMs=tDraw-tSchedule;
      this.lastFrameStats.drawSubmitCpuMs=tEnd-tDraw;
      this.lastFrameStats.endFrameElapsedMs=performance.now()-tEnd;}
    return this.lastFrameStats;
  }
  snapshot(){return {mode:'direct-feature-scene',started:this.started,frames:this.frames,drawPackets:this.lastSchedule.length,
    ...(this.vectorTileOptions.profileCPU?{tileProfiles:[...this._tileProfiles.values()].map(p=>({...p}))}:{}),
    tileCount:this.bridge.tiles.size,
    layers:[...this.layers.values()].map(s=>({key:s.key,visible:s.state.visible!==false,
      opacity:s.state.opacity,zIndex:s.state.zIndex,sequence:s.sequence,tileCount:s.adapter.tiles.size})),
    frameStats:this.lastFrameStats,deferredWorker:this.deferredWorker?.snapshot()??{enabled:false},scheduleBuilds:this.scheduleBuilds,scheduleCacheHits:this.scheduleCacheHits};}
}
