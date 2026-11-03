import assert from 'node:assert/strict';
import {createBoostMapClass} from '../src/ol/BoostMap.js';

function fakeViewport(){
  const names=new Set(),elements=[];
  const vp={
    classList:{add:n=>names.add(n),remove:n=>names.delete(n),contains:n=>names.has(n)},
    ownerDocument:{createElement:tag=>({tag,textContent:'',style:{},removed:false,remove(){this.removed=true;}})},
    appendChild:el=>elements.push(el)
  };
  return {vp,names,elements};
}
class FakeLayer{
  constructor({style={'stroke-color':'#dc4137','stroke-width':3},hitDisabled=true,variables={}}={}){
    this.style_=style;this.styleVariables_=variables;this.hitDetectionDisabled_=hitDisabled;
    this.source={getTile(){},getSourceTiles(){},getTileGrid(){},getOverlaps(){}};
    this.listeners=new Map();
  }
  getSource(){return this.source;}
  on(k,f){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(f);}
  un(k,f){this.listeners.get(k)?.delete(f);}
  emit(k){for(const f of this.listeners.get(k)||[])f();}
  setStyle(style){this.style_=style;this.emit('change');}
  setSource(source){this.source=source;this.emit('change');}
  setVisible(visible){this.visible=visible;this.emit('change');}
}
class FakeMap{
  constructor({target=null,layers=[],view={center:[0,0]}}={}){
    this.target=target;this.layers=layers;this.view=view;this.listeners=new Map();
    this.viewport=fakeViewport();this.renderCount=0;this.disposed=false;
  }
  on(k,f){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(f);}
  un(k,f){this.listeners.get(k)?.delete(f);}
  emit(k){for(const f of this.listeners.get(k)||[])f();}
  getAllLayers(){return this.layers;}
  getTargetElement(){return this.target?{id:this.target}:null;}
  getViewport(){return this.viewport.vp;}
  getView(){return this.view;}
  setTarget(target){this.target=target;this.emit('change:target');}
  render(){this.renderCount++;}
  disposeInternal(){this.disposed=true;this.setTarget(null);}
}
const created=[];
class FakeBoost{
  constructor(options){this.options=options;this.started=false;this.syncs=0;this.destroys=0;created.push(this);}
  start({renderSync}={}){assert.equal(renderSync,false);this.started=true;return this;}
  sync(){this.syncs++;}
  destroy(){this.started=false;this.destroys++;}
  runtimeError(){this.options.onError({phase:'test-err',error:new Error('synthetic')});}
}
const Map=createBoostMapClass({
  MapBase:FakeMap,LayerBase:FakeLayer,createBoost:cfg=>new FakeBoost(cfg),
  createCanvas:()=>({style:{display:''}})
});
const one=new FakeLayer();
const originalView={center:[1,2]};
const m=new Map({target:'map',layers:[one],view:originalView});
assert.equal(m instanceof FakeMap,true);
assert.equal(m.getBoostStatus().enabled,true);
assert.equal(m.getView(),originalView);
assert.equal(m.getAllLayers()[0],one);
assert.equal(created.length,1);
assert.equal(created[0].options.stockOlRenderMode,'exclusive');
assert.equal(created[0].options.canvasMode,'managed-overlay');
assert.equal(created[0].options.layerStyleResolver(one),one.style_);
assert.equal(created[0].options.vectorTileOptions.olLayerFboComposition,true);
assert.equal(m.viewport.names.has('olvt-boost-exclusive'),true);
assert.equal(m.viewport.elements.length,1);
assert.ok(m.renderCount>=1);

const initial=created[0];
one.setVisible(false);
assert.equal(initial.syncs,0,'ordinary OL visibility change should not scan styles');
one.setStyle({'fill-color':'rgba(10,20,30,0.5)'});
assert.equal(initial.syncs,1,'new literal style is synced to the shared renderer');
assert.equal(m.getBoostStatus().enabled,true);

one.setStyle({'text-value':['get','name']});
assert.equal(m.getBoostStatus().enabled,false,'unsupported dynamic style must fall back');
assert.match(m.getBoostStatus().reason,/Unsupported/);
assert.equal(initial.destroys,1);
assert.equal(m.viewport.names.has('olvt-boost-exclusive'),false);
assert.equal(m.viewport.elements[0].removed,true);
assert.equal(m.getAllLayers()[0],one);

one.setStyle({'stroke-color':'#dc4137','stroke-width':3});
m.enableBoost();
assert.equal(m.getBoostStatus().enabled,true);
assert.equal(created.length,2);
m.disableBoost();
assert.equal(m.getBoostStatus().enabled,false);
assert.equal(created[1].destroys,1);
assert.equal(m.viewport.names.has('olvt-boost-exclusive'),false);
m.setTarget(null);m.setTarget('map');
assert.equal(m.getBoostStatus().enabled,false,'manual disable survives target detach/attach');
m.enableBoost();
assert.equal(m.getBoostStatus().enabled,true);
assert.equal(created.length,3);
m.setTarget(null);
assert.equal(created[2].destroys,1,'detached map cleans up Boost');
assert.equal(m.getBoostStatus().enabled,false);
m.setTarget('map');
assert.equal(created.length,4,'reattached map can safely initialize again');
created[3].runtimeError();
assert.equal(m.getBoostStatus().enabled,false);
assert.match(m.getBoostStatus().reason,/runtime fallback/);
assert.equal(created[3].destroys,1,'error fallback releases the shared renderer');

const noHit=new Map({target:'map',layers:[new FakeLayer({hitDisabled:false})]});
assert.equal(noHit.getBoostStatus().enabled,false);
assert.match(noHit.getBoostStatus().reason,/Hit detection/);
const mixed=new Map({target:'map',layers:[new FakeLayer(),{}]});
assert.equal(mixed.getBoostStatus().enabled,false);
assert.match(mixed.getBoostStatus().reason,/Mixed/);
const variableStyle=new Map({target:'map',layers:[new FakeLayer({variables:{color:'red'}})]});
assert.equal(variableStyle.getBoostStatus().enabled,false);
assert.match(variableStyle.getBoostStatus().reason,/Style variables/);
const expression=new Map({target:'map',layers:[new FakeLayer({style:{'stroke-width':['get','width']}})]});
assert.equal(expression.getBoostStatus().enabled,false);
assert.match(expression.getBoostStatus().reason,/Unsupported/);

const many=Array.from({length:50},()=>new FakeLayer());
const before=created.length;
const map50=new Map({target:'map',layers:many});
assert.equal(map50.getBoostStatus().enabled,true);
assert.equal(created.length,before+1,'50 layers must have one shared renderer');
assert.equal(map50.getAllLayers(),many);
assert.equal(created.at(-1).options.layerStyleResolver(many[49]),many[49].style_);
many[0].setStyle({'fill-color':'#abcdef'});
assert.equal(created.at(-1).syncs,1);
map50.disposeInternal();
assert.equal(map50.disposed,true);
assert.equal(map50.getBoostStatus().enabled,false);
assert.equal(created.at(-1).destroys,1);

const detached=new Map({target:null,layers:[new FakeLayer()]});
assert.equal(detached.getBoostStatus().enabled,false);
const n=created.length;
detached.setTarget('later');
assert.equal(detached.getBoostStatus().enabled,true);
assert.equal(created.length,n+1);
detached.disposeInternal();
assert.equal(detached.getBoostStatus().enabled,false);
assert.equal(created.at(-1).destroys,1);
console.log('R76_DROPIN_MAP_50_LAYERS_AND_SAFE_FALLBACK_PASS');
