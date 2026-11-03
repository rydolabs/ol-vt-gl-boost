import assert from 'node:assert/strict';
import OLMap from 'ol/Map.js';
import OriginalWebGLVectorTileLayer from 'ol/layer/WebGLVectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import {BoostWebGLVectorTileLayer,BoostMap,createBoostMapClass} from '../src/index.js';
import DefaultBoostWebGLVectorTileLayer from '../src/BoostWebGLVectorTileLayer.js';

assert.equal(BoostWebGLVectorTileLayer,DefaultBoostWebGLVectorTileLayer);
assert.equal(typeof BoostMap,'function');
assert.ok(BoostMap.prototype instanceof OLMap,'BoostMap preserves the OL Map prototype');
assert.ok(BoostWebGLVectorTileLayer.prototype instanceof OriginalWebGLVectorTileLayer,
  'Boost layer must inherit actual OL 10.10.0 WebGLVectorTileLayer');

const makeLayer=(i,Layer=BoostWebGLVectorTileLayer,extra={})=>{
  const source=new VectorTileSource({format:new MVT(),url:'/tiles/'+i+'/{z}/{x}/{y}.pbf'});
  const style={'stroke-color':'#336699','stroke-width':2};
  const layer=new Layer({source,style,disableHitDetection:true,visible:true,opacity:1,zIndex:i,...extra});
  return {layer,source,style};
};
const {layer,source,style}=makeLayer(1);
assert.ok(layer instanceof OriginalWebGLVectorTileLayer);
assert.equal(layer.getSource(),source);
assert.equal(layer.style_,style,'OL native style constructor semantics must remain unchanged');
assert.equal(layer.hitDetectionDisabled_,true);
layer.setVisible(false);assert.equal(layer.getVisible(),false);
layer.setOpacity(0.45);assert.equal(layer.getOpacity(),0.45);
layer.setZIndex(77);assert.equal(layer.getZIndex(),77);
const nextStyle={'fill-color':'#ff3311','stroke-width':1};
layer.setStyle(nextStyle);assert.equal(layer.style_,nextStyle);
layer.updateStyleVariables({custom:123});assert.equal(layer.styleVariables_.custom,123);
const nextSource=new VectorTileSource({format:new MVT(),url:'/next/{z}/{x}/{y}.pbf'});
layer.setSource(nextSource);assert.equal(layer.getSource(),nextSource);
// Crucial: using the new named layer with an ordinary ol/Map is *not* an
// implicit GPU takeover. No private layer.render method or renderer is replaced.
assert.equal(Object.prototype.hasOwnProperty.call(layer,'render'),false);
assert.equal(layer.render,Reflect.get(OriginalWebGLVectorTileLayer.prototype,'render'));
assert.equal(layer.createRenderer,OriginalWebGLVectorTileLayer.prototype.createRenderer);
assert.equal(layer.getBoostStatus,undefined);

function viewport(){
 const names=new Set();
 return {names,el:{
   classList:{add:n=>names.add(n),remove:n=>names.delete(n),contains:n=>names.has(n)},
   ownerDocument:{createElement:()=>({style:{},remove(){this.removed=true;}})},
   appendChild(){}}
 };
}
class FakeMap {
 constructor({target=null,layers=[],view=null}={}){
   this.target=target;this.layers=layers;this.view=view;
   this.listeners=new globalThis.Map();this.area=viewport();this.rendered=0;
 }
 getAllLayers(){return this.layers;}
 getTargetElement(){return this.target?{}:null;}
 getViewport(){return this.area.el;}
 getView(){return this.view;}
 on(k,f){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(f);}
 un(k,f){this.listeners.get(k)?.delete(f);}
 setTarget(t){this.target=t;for(const f of this.listeners.get('change:target')||[])f();}
 render(){this.rendered++;}
 disposeInternal(){this.disposed=true;this.setTarget(null);}
}
class FakeBoost {
 constructor(args){this.args=args;this.started=false;this.syncs=0;this.destroyed=false;}
 start(){this.started=true;}
 sync(){this.syncs++;}
 destroy(){this.destroyed=true;this.started=false;}
}
let created=[];
const Map= createBoostMapClass({
 MapBase:FakeMap,LayerBase:OriginalWebGLVectorTileLayer,
 createBoost:args=>{const b=new FakeBoost(args);created.push(b);return b;},
 createCanvas:()=>({style:{}})
});

const layers=Array.from({length:50},(_,i)=>makeLayer(i+1).layer);
const existingView={center:[0,0]};
const compatible=new Map({target:'map',layers,view:existingView});
assert.equal(compatible.getBoostStatus().enabled,true);
assert.equal(created.length,1,'50 named Boost layers must share one backend');
assert.equal(compatible.getAllLayers(),layers,'all original 50 instances must be preserved');
assert.equal(compatible.getView(),existingView);
assert.equal(created[0].args.layerStyleResolver(layers[49]),layers[49].style_);
assert.equal(compatible.getViewport().classList.contains('olvt-boost-exclusive'),true);

const first=created[0];
const newStyle={'stroke-color':'#ff3300','stroke-width':4};
layers[1].setStyle(newStyle);
assert.equal(first.syncs,1,'new style should reach shared renderer');
assert.equal(first.args.layerStyleResolver(layers[1]),newStyle);
layers[0].setVisible(false);
assert.equal(first.destroyed,false);
layers[1].setStyle({'text-value':'name'});
assert.equal(compatible.getBoostStatus().enabled,false,
 'unsupported style must restore OL without replacing the native layer');
assert.equal(first.destroyed,true);
assert.equal(compatible.getViewport().classList.contains('olvt-boost-exclusive'),false);
assert.equal(compatible.getAllLayers()[1],layers[1]);

const noHit=makeLayer(51,BoostWebGLVectorTileLayer,{disableHitDetection:false}).layer;
const noHitMap=new Map({target:'map',layers:[noHit]});
assert.equal(noHitMap.getBoostStatus().enabled,false);
assert.match(noHitMap.getBoostStatus().reason,/Hit detection/);
const mixing=new Map({target:'map',layers:[makeLayer(1).layer,{kind:'raster'}]});
assert.equal(mixing.getBoostStatus().enabled,false);
assert.match(mixing.getBoostStatus().reason,/Mixed/);
const oldLayer=makeLayer(52,OriginalWebGLVectorTileLayer).layer;
const compatibleOld=new Map({target:'map',layers:[oldLayer]});
assert.equal(compatibleOld.getBoostStatus().enabled,true,
  'BoostMap must also accelerate unchanged stock OL vector tile layers');
assert.equal(compatibleOld.getAllLayers()[0],oldLayer);
compatibleOld.disableBoost();assert.equal(compatibleOld.getBoostStatus().enabled,false);
const last=created.at(-1);assert.equal(last.destroyed,true);
console.log('R76_BOOST_LAYER_PUBLIC_API_50_REAL_OL_LAYERS_PASS');
