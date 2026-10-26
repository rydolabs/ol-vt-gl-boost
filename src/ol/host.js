// Origin: src/renderer/adapters/openlayers/OlCanvasHost.js
/**
 * Optional OpenLayers DOM host for the optimized renderer canvas.
 * `external` mode never mutates the DOM. `managed-overlay` owns one canvas and
 * mounts it in the map viewport using only public map methods.
 */
export class OlCanvasHost {
  constructor({map,canvas=null,mode='external',canvasFactory=null,className='ol-optimized-renderer',zIndex=10,pointerEvents='none'}={}){
    if(!map)throw new Error('OlCanvasHost requires map');
    if(!['external','managed-overlay'].includes(mode))throw new Error(`Unsupported canvas mode: ${mode}`);
    this.map=map;this.mode=mode;this.ownsCanvas=false;this.attached=false;
    if(canvas)this.canvas=canvas;
    else if(mode==='managed-overlay'){
      const factory=canvasFactory||(()=>globalThis.document?.createElement?.('canvas'));
      this.canvas=factory?.();if(!this.canvas)throw new Error('managed-overlay requires canvasFactory or document.createElement');this.ownsCanvas=true;
    }else this.canvas=null;
    this.className=className;this.zIndex=zIndex;this.pointerEvents=pointerEvents;
  }
  setMap(map){if(!map)throw new Error('OlCanvasHost.setMap requires map');if(map===this.map)return this;this.detach();this.map=map;return this;}
  attach(){
    if(this.mode!=='managed-overlay'||!this.canvas||this.attached)return this;
    const viewport=this.map.getViewport?.();if(!viewport?.appendChild)throw new Error('managed-overlay requires map.getViewport() DOM element');
    const s=this.canvas.style||{};s.position='absolute';s.left='0';s.top='0';s.width='100%';s.height='100%';s.pointerEvents=this.pointerEvents;s.zIndex=String(this.zIndex);
    if(this.className&&this.canvas.classList?.add)this.canvas.classList.add(this.className);
    viewport.appendChild(this.canvas);this.attached=true;return this;
  }
  detach(){if(this.mode==='managed-overlay'&&this.attached&&this.canvas?.parentNode?.removeChild)this.canvas.parentNode.removeChild(this.canvas);this.attached=false;return this;}
  destroy(){this.detach();if(this.ownsCanvas)this.canvas=null;return this;}
  snapshot(){return {mode:this.mode,owned:this.ownsCanvas,attached:this.attached,hasCanvas:!!this.canvas};}
}

// Origin: src/renderer/adapters/openlayers/OlTargetLifecycleAdapter.js
/**
 * Observes only the OpenLayers Map public `change:target` surface.
 * It deliberately does not guess that target=null means dispose(), because
 * temporary detach and Map.dispose() are indistinguishable through public API.
 */
export class OlTargetLifecycleAdapter {
  constructor({map,onAttach=null,onDetach=null}={}){
    if(!map)throw new Error('OlTargetLifecycleAdapter requires map');
    this.map=map;this.onAttach=onAttach;this.onDetach=onDetach;this.started=false;this.listener=null;this.attached=this._isAttached();
  }
  _isAttached(){return !!(this.map?.getTargetElement?.()||this.map?.getTarget?.());}
  _handle=()=>{
    const next=this._isAttached();if(next===this.attached)return;
    this.attached=next;
    if(next)this.onAttach?.({map:this.map});else this.onDetach?.({map:this.map});
  };
  start({initialNotify=false}={}){
    if(this.started)return this;this.started=true;this.attached=this._isAttached();
    this.listener=this.map.on?.('change:target',this._handle)||null;
    if(initialNotify){if(this.attached)this.onAttach?.({map:this.map,initial:true});else this.onDetach?.({map:this.map,initial:true});}
    return this;
  }
  stop(){
    if(!this.started)return this;
    if(typeof this.map.un==='function')this.map.un('change:target',this._handle);else if(typeof this.listener?.unlisten==='function')this.listener.unlisten();
    this.listener=null;this.started=false;return this;
  }
}
