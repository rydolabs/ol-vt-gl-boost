// Origin: src/renderer/adapters/openlayers/OlLayerAdapter.js
/** Convert an OL layer's public state into a renderer-neutral layer descriptor. */
export function toNeutralLayerState(layer){
  if(!layer) return {visible:true,opacity:1};
  const read=(method,prop,def)=>typeof layer[method]==='function'?layer[method]():layer[prop]??def;
  return {
    visible:Boolean(read('getVisible','visible',true)),
    opacity:Math.max(0,Math.min(1,Number(read('getOpacity','opacity',1)??1))),
    zIndex:Number(read('getZIndex','zIndex',0)??0),
  };
}

// Origin: src/renderer/adapters/openlayers/OlLayerLifecycleAdapter.js

/** Observe public OL layer state without leaking OL objects past the adapter. */
export class OlLayerLifecycleAdapter {
  constructor({layer,sink=null,onState=null}={}){
    if(!layer)throw new Error('OlLayerLifecycleAdapter requires layer');
    this.layer=layer;this.sink=sink;this.onState=onState;this.started=false;this._onChange=()=>this.sync();
  }
  sync(){const state=toNeutralLayerState(this.layer);this.sink?.setLayerState?.(state);this.onState?.(state);return state;}
  start({initialSync=true}={}){
    if(this.started)return this;this.started=true;
    for(const type of ['change:zIndex','change:visible','change:opacity'])this.layer.on?.(type,this._onChange);
    if(initialSync)this.sync();return this;
  }
  stop(){if(!this.started)return;for(const type of ['change:zIndex','change:visible','change:opacity'])this.layer.un?.(type,this._onChange);this.started=false;}
}
