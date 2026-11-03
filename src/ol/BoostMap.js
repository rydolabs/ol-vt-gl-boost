/**
 * R76 opt-in, one-import migration from ol/Map.js.
 *
 * Replace only the Map import; retain actual WebGLVectorTileLayer,
 * VectorTileSource, View and OL map APIs. This is deliberately not a
 * WebGLVectorTileLayer replacement: 50 layers must share one GPU backend.
 *
 * Conservative eligibility: unsupported styles, hit detection, and mixed
 * layer types use unchanged stock OpenLayers. OL 10.10.0 is pinned; style_
 * and hitDetectionDisabled_ are private OL fields inspected in this adapter.
 */
import OLMap from 'ol/Map.js';
import WebGLVectorTileLayer from 'ol/layer/WebGLVectorTile.js';
import {OLVectorTileBoost} from '../OLVectorTileBoost.js';

const ALLOWED_KEYS=new Set([
  'fill-color','stroke-color','stroke-width','stroke-line-cap','stroke-line-join',
  'stroke-miter-limit','z-index','circle-radius','circle-fill-color',
  'circle-stroke-color','circle-stroke-width','circle-opacity'
]);
const PAINT_KEYS=new Set(['fill-color','stroke-color','stroke-width','circle-radius']);
const COLOR_KEYS=new Set(['fill-color','stroke-color','circle-fill-color','circle-stroke-color']);
const VALID_CAPS=new Set(['round','butt','square']);
const VALID_JOINS=new Set(['round','bevel','miter']);

function safeLiteralStyle(style){
  if(!style || typeof style!=='object' || Array.isArray(style))return false;
  const entries=Object.entries(style);
  if(!entries.length || !entries.some(([k])=>PAINT_KEYS.has(k)))return false;
  for(const [key,value] of entries){
    if(!ALLOWED_KEYS.has(key))return false;
    if(COLOR_KEYS.has(key)){
      if(typeof value==='string')continue;
      if(Array.isArray(value) && (value.length===3||value.length===4) &&
        value.every(x=>typeof x==='number'&&Number.isFinite(x)))continue;
      return false;
    }
    if(key==='stroke-line-cap'){if(!VALID_CAPS.has(value))return false;continue;}
    if(key==='stroke-line-join'){if(!VALID_JOINS.has(value))return false;continue;}
    if(typeof value!=='number'||!Number.isFinite(value))return false;
  }
  return true;
}
function sourceSupported(layer){
  const source=layer.getSource?.();
  return !!(source&&typeof source.getTile==='function'&&
    typeof source.getSourceTiles==='function'&&
    typeof source.getTileGrid==='function'&&
    typeof source.getOverlaps==='function');
}
function checkScene(map,LayerClass){
  const layers=map.getAllLayers?.()||[];
  if(layers.length===0)return {reason:'No vector tile layers'};
  for(const layer of layers){
    if(!(layer instanceof LayerClass))return {reason:'Mixed or unsupported layer class'};
    if(!sourceSupported(layer))return {reason:'Expected an OpenLayers VectorTileSource'};
    // Without a Boost feature-picking implementation, keep OL hit detection.
    if(layer.hitDetectionDisabled_!==true)return {reason:'Hit detection enabled on a layer'};
    if(!Object.prototype.hasOwnProperty.call(layer,'style_')||
      !safeLiteralStyle(layer.style_))return {reason:'Unsupported/nonliteral layer style'};
    if(Object.keys(layer.styleVariables_||{}).length!==0)
      return {reason:'Style variables are not supported by the drop-in adapter'};
  }
  return {layers};
}

/**
 * Dependency injection supports deterministic lifecycle tests without a GPU.
 * Real callers should import the exported BoostMap class below.
 */
export function createBoostMapClass({MapBase,LayerBase,createBoost,createCanvas}){
  if(typeof MapBase!=='function'||typeof LayerBase!=='function'||typeof createBoost!=='function')
    throw Error('BoostMap requires MapBase, LayerBase and createBoost');
  return class BoostMap extends MapBase {
    constructor(options={}){
      const {boostOptions={},...mapOptions}=options||{};
      const originalTarget=mapOptions.target??null;
      // Prevent OL from rasterizing its first WebGL frame before Boost owns
      // exclusive per-instance layer.render. No caller changes to map options.
      super({...mapOptions,target:null});
      this._boostMapOptions=boostOptions;
      this._boostMapInstance=null;
      this._boostMapCanvas=null;
      this._boostMapStyle=null;
      this._boostMapLayerDisposers=[];
      this._boostMapState={enabled:false,reason:'Map has no attached target'};
      this._boostMapManualDisabled=false;
      this._boostMapDisposed=false;
      this._boostMapTargetChanged=()=>this._onBoostTargetChange();
      this.on?.('change:target',this._boostMapTargetChanged);
      if(originalTarget!==null)this.setTarget(originalTarget);
    }
    getBoostStatus(){return {...this._boostMapState};}
    get boost(){return this._boostMapInstance;}
    _watchBoostLayers(layers){
      this._unwatchBoostLayers();
      for(const layer of layers){
        let previousStyle=layer.style_,previousSource=layer.getSource();
        const changed=()=>{
          if(!this._boostMapInstance)return;
          const style=layer.style_,source=layer.getSource();
          if(style===previousStyle&&source===previousSource)return;
          previousStyle=style;previousSource=source;
          const result=checkScene(this,LayerBase);
          if(result.reason){this._disableBoost(result.reason);return;}
          try{this._boostMapInstance.sync();}
          catch(error){this._disableBoost('Layer update failed: '+String(error?.message||error));}
        };
        layer.on?.('change',changed);
        this._boostMapLayerDisposers.push(()=>layer.un?.('change',changed));
      }
    }
    _unwatchBoostLayers(){
      for(const fn of this._boostMapLayerDisposers.splice(0)){
        try{fn();}catch{}
      }
    }
    _toggleStockVisibility(enableBoost){
      const vp=this.getViewport?.();
      if(!vp)return;
      if(enableBoost){
        const el=vp.ownerDocument?.createElement?.('style');
        if(!el)throw Error('Map viewport has no owner document');
        // Only the existing OL layer DOM is hidden, never the Boost overlay.
        el.textContent='.olvt-boost-exclusive > .ol-layers .ol-layer { visibility: hidden !important; }';
        vp.appendChild(el);
        this._boostMapStyle=el;
        vp.classList?.add('olvt-boost-exclusive');
      }else{
        vp.classList?.remove('olvt-boost-exclusive');
        this._boostMapStyle?.remove?.();
        this._boostMapStyle=null;
      }
    }
    _disableBoost(reason='Disabled by caller'){
      this._unwatchBoostLayers();
      this._toggleStockVisibility(false);
      const boost=this._boostMapInstance;
      this._boostMapInstance=null;
      if(boost){
        try{boost.destroy();}catch(error){
          reason+='; cleanup: '+String(error?.message||error);
        }
      }
      if(this._boostMapCanvas?.style)this._boostMapCanvas.style.display='none';
      this._boostMapCanvas=null;
      this._boostMapState={enabled:false,reason};
      if(!this._boostMapDisposed)this.render?.();
    }
    disableBoost(){
      this._boostMapManualDisabled=true;
      this._disableBoost('Disabled by caller');
      return this;
    }
    enableBoost(){
      this._boostMapManualDisabled=false;
      this._startBoost();
      return this;
    }
    _startBoost(){
      if(this._boostMapDisposed||this._boostMapManualDisabled||this._boostMapInstance)return;
      if(!this.getTargetElement?.()){
        this._boostMapState={enabled:false,reason:'Map has no attached target'};
        return;
      }
      const eligibility=checkScene(this,LayerBase);
      if(eligibility.reason){
        this._boostMapState={enabled:false,reason:eligibility.reason};
        return;
      }
      let boost=null;
      try{
        const canvas=createCanvas?createCanvas(this):
          this.getViewport()?.ownerDocument?.createElement?.('canvas');
        if(!canvas)throw Error('Canvas unavailable');
        this._boostMapCanvas=canvas;
        boost=createBoost({
          map:this,canvas,canvasMode:'managed-overlay',
          stockOlRenderMode:'exclusive',
          // Only the opt-in BoostMap defaults to nonblocking. Direct backend
          // users retain strict per-frame error checks; callers can override.
          backendOptions:{glErrorCheckMode:'nonblocking',...(this._boostMapOptions.backendOptions||{})},
          layerStyleResolver:layer=>layer.style_,
          vectorTileOptions:{
            drawMode:'style-pass',stableStyleIdentityCache:true,
            olLayerFboComposition:true,closedLineJoins:true,
            ...(this._boostMapOptions.vectorTileOptions||{})
          },
          onError:event=>{
            this._disableBoost('Boost runtime fallback: '+String(event?.phase||'unknown'));
            this._boostMapOptions.onError?.(event);
          }
        });
        this._boostMapInstance=boost;
        boost.start({renderSync:false});
        this._toggleStockVisibility(true);
        this._watchBoostLayers(eligibility.layers);
        this._boostMapState={enabled:true,reason:null};
        this.render?.();
      }catch(error){
        this._disableBoost('Boost initialization failed: '+String(error?.message||error));
        this._boostMapOptions.onError?.({error,phase:'dropin-init'});
      }
    }
    _onBoostTargetChange(){
      if(!this.getTargetElement?.()){
        this._disableBoost('Map detached');
        return;
      }
      if(!this._boostMapManualDisabled)this._startBoost();
    }
    disposeInternal(){
      this._boostMapDisposed=true;
      this._disableBoost('Map disposed');
      this.un?.('change:target',this._boostMapTargetChanged);
      super.disposeInternal();
    }
  };
}

export const BoostMap=createBoostMapClass({
  MapBase:OLMap,
  LayerBase:WebGLVectorTileLayer,
  createBoost:options=>new OLVectorTileBoost(options)
});
export default BoostMap;
