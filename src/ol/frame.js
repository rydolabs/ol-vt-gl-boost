// Origin: src/renderer/adapters/openlayers/OlFrameAdapter.js
function projectionCode(projection){if(!projection)return null;if(typeof projection.getCode==='function')return projection.getCode();return projection.code||String(projection);}
function affineFromView(frameState){
  const v=frameState.viewState||{}, size=frameState.size||[1,1];
  const cx=Number(v.center?.[0]||0), cy=Number(v.center?.[1]||0), r=Number(v.resolution||1), rot=Number(v.rotation||0);
  const c=Math.cos(rot), s=Math.sin(rot), w=Number(size[0]||1), h=Number(size[1]||1);
  // world -> CSS pixel. Matches OL view convention for the neutral fallback path.
  return [c/r,s/r,s/r,-c/r,w/2-(c*cx+s*cy)/r,h/2-(s*cx-c*cy)/r];
}
export function coordinateToClipMatrix(frameState){
  const size=frameState?.size||[1,1], w=Number(size[0]||1), h=Number(size[1]||1);
  const t=(frameState?.coordinateToPixelTransform&&frameState.coordinateToPixelTransform.length>=6)
    ? Array.from(frameState.coordinateToPixelTransform.slice(0,6),Number)
    : affineFromView(frameState||{});
  const [a,b,c,d,e,f]=t;
  return new Float32Array([
    2*a/w,-2*b/h,0,0,
    2*c/w,-2*d/h,0,0,
    0,0,1,0,
    2*e/w-1,1-2*f/h,0,1,
  ]);
}
/** Convert OL frameState/viewState into a small platform-neutral frame descriptor. */
export function toNeutralFrame(frameState,{time=(globalThis.performance?.now?.()??Date.now())}={}){
  if(!frameState) throw new Error('frameState is required');
  const v=frameState.viewState||{};
  return {
    center:v.center?[...v.center]:[0,0], resolution:Number(v.resolution??1), rotation:Number(v.rotation??0), zoom:Number(v.zoom??0),
    pixelRatio:Number(frameState.pixelRatio??1), size:frameState.size?[...frameState.size]:null, extent:frameState.extent?[...frameState.extent]:null,
    projectionCode:projectionCode(v.projection), time:Number(time),
    coordinateToPixelTransform:frameState.coordinateToPixelTransform?Array.from(frameState.coordinateToPixelTransform.slice(0,6),Number):null,
    clipMatrix:coordinateToClipMatrix(frameState),
  };
}

// Origin: src/renderer/adapters/openlayers/OlMapFrameBridge.js
/**
 * Thin bridge from an OL Map's public postrender event to a neutral renderer frame.
 * No OpenLayers modules are imported; the map only needs on/un/renderSync methods.
 */
export class OlMapFrameBridge {
  constructor({map,adapter,renderer,canvas=null,beforeRender=null}={}){
    if(!map)throw new Error('OlMapFrameBridge requires map');
    if(!adapter)throw new Error('OlMapFrameBridge requires adapter');
    if(!renderer)throw new Error('OlMapFrameBridge requires renderer');
    this.map=map;this.adapter=adapter;this.renderer=renderer;this.canvas=canvas;this.beforeRender=beforeRender;this.listener=null;this.started=false;this.frames=0;
  }
  _resize(frameState){
    if(!this.canvas||!frameState?.size)return;
    const pr=Number(frameState.pixelRatio||1),w=Math.max(1,Math.round(frameState.size[0]*pr)),h=Math.max(1,Math.round(frameState.size[1]*pr));
    if(this.canvas.width!==w)this.canvas.width=w;if(this.canvas.height!==h)this.canvas.height=h;
    if(this.canvas.style){this.canvas.style.width=`${frameState.size[0]}px`;this.canvas.style.height=`${frameState.size[1]}px`;}
  }
  _onFrame=(event)=>{
    const fs=event?.frameState;if(!fs)return;
    this._resize(fs);this.adapter.syncFrame(fs);this.beforeRender?.();this.renderer.render();this.frames++;
  };
  start({renderSync=true}={}){
    if(this.started)return this;this.started=true;
    this.listener=this.map.on?.('postrender',this._onFrame)||null;
    if(renderSync)this.map.renderSync?.();
    return this;
  }
  stop(){
    if(!this.started)return this;
    if(typeof this.map.un==='function')this.map.un('postrender',this._onFrame);
    else if(typeof this.listener?.unlisten==='function')this.listener.unlisten();
    this.listener=null;this.started=false;return this;
  }
}
