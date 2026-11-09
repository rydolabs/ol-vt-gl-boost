import assert from 'node:assert/strict';
import {createBoostMapClass} from '../src/ol/BoostMap.js';

class Events{
  constructor(){this._events=new Map();}
  on(type,cb){if(!this._events.has(type))this._events.set(type,new Set());this._events.get(type).add(cb);}
  un(type,cb){this._events.get(type)?.delete(cb);}
  emit(type){for(const fn of [...(this._events.get(type)||[])])fn();}
  listeners(type){return this._events.get(type)?.size||0;}
}
class Collection extends Events{
  constructor(items=[]){super();this.items=[...items];}
  getArray(){return this.items;}
  add(item){this.items.push(item);this.emit('add');}
  remove(item){this.items.splice(this.items.indexOf(item),1);this.emit('remove');}
}
class Group extends Events{
  constructor(items=[]){super();this.collection=new Collection(items);}
  getLayers(){return this.collection;}
}
class Layer extends Events{
  constructor(){super();this.style_={'stroke-color':'#aa6677','stroke-width':2};this.styleVariables_={};
    this.hitDetectionDisabled_=true;
    this.source={getTile(){},getSourceTiles(){},getTileGrid(){},getOverlaps(){}};
  }
  getSource(){return this.source;}
  render(){return 'original';}
  setStyle(style){this.style_=style;this.emit('change');}
  setVariables(vars){this.styleVariables_=vars;this.emit('change');}
  setSource(source){this.source=source;this.emit('change');}
}
function viewport(){
  const classes=new Set();
  return {ownerDocument:{createElement:()=>({style:{},remove(){}})},
    appendChild(){},
    classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),
      contains:key=>classes.has(key)}};
}
class BaseMap extends Events{
  constructor({target=null,layers=[],group=null}={}){
    super();this.target=target;this.group=group||new Group(layers);this.vp=viewport();
    this.renderCount=0;
  }
  getLayerGroup(){return this.group;}
  getAllLayers(){
    const out=[];
    const scan=group=>{
      for(const entry of group.getLayers().getArray())
        if(entry instanceof Group)scan(entry);
        else out.push(entry);
    };
    scan(this.group);return out;
  }
  getTargetElement(){return this.target?{}:null;}
  setTarget(target){this.target=target;this.emit('change:target');}
  getViewport(){return this.vp;}
  render(){this.renderCount++;this.emit('postrender');}
  disposeInternal(){this.disposed=true;}
}
const made=[];
function createBoost(options){
  const originals=new Map();
  const o={options,started:false,destroyCount:0,syncCount:0,
    start(){
      this.started=true;
      for(const layer of options.map.getAllLayers()){
        originals.set(layer,layer.render);
        layer.render=()=>null; // emulate the real exclusive host
      }
    },
    sync(){this.syncCount++},
    destroy(){
      this.destroyCount++;
      for(const [layer,render] of originals){
        delete layer.render;
        assert.equal(layer.render,render,'Original OL layer renderer must be restored');
      }
      originals.clear();
    },
  };
  made.push(o);return o;
}
const BoostMap=createBoostMapClass({
  MapBase:BaseMap,LayerBase:Layer,
  createBoost,createCanvas:()=>({style:{display:''}})
});
const addMap=()=>new BoostMap({target:'m',layers:[new Layer()]});

const map=addMap();
assert.equal(map.getBoostStatus().enabled,true);
assert.equal(map.boost.options.backendOptions.glErrorCheckMode,'strict',
  'Release default must synchronously detect non-context-loss WebGL errors');
const original=map.getAllLayers()[0];
const runtime=map.boost;
assert.equal(Object.hasOwn(original,'render'),true);
assert.equal(map.getLayerGroup().getLayers().listeners('add'),1);
map.getLayerGroup().getLayers().add({render(){}});
assert.equal(map.getBoostStatus().enabled,false,'Mixed added layer must fail closed synchronously');
assert.equal(map.boost,null);
assert.equal(runtime.destroyCount,1);
assert.equal(Object.hasOwn(original,'render'),false);
assert.equal(original.render(),'original');
assert.equal(map.vp.classList.contains('olvt-boost-exclusive'),false);
assert.equal(map.getLayerGroup().getLayers().listeners('add'),0,'No stale add listener');

const variable=addMap(),vLayer=variable.getAllLayers()[0];
vLayer.setVariables({foo:'bar'});
assert.match(variable.getBoostStatus().reason,/Style variables/);
assert.equal(Object.hasOwn(vLayer,'render'),false);

const mutate=addMap(),mLayer=mutate.getAllLayers()[0];
mLayer.style_['text-value']=['get','name']; // same object, no change event
mutate.render(); // postrender safety audit handles mutation
assert.match(mutate.getBoostStatus().reason,/Unsupported/);

const nested=new Group([new Layer()]);
const nestedMap=new BoostMap({target:'m',group:new Group([nested])});
const nestedLayer=nested.getLayers().getArray()[0],old=nestedMap.boost;
assert.equal(nestedMap.getBoostStatus().enabled,true);
assert.equal(nested.getLayers().listeners('add'),1);
nested.getLayers().add(new Layer()); // even supported addition must fall back,
assert.equal(nestedMap.getBoostStatus().enabled,false,'New supported OL layer must not draw underneath old Boost');
assert.match(nestedMap.getBoostStatus().reason,/layer tree changed/i);
assert.equal(old.destroyCount,1);
assert.equal(Object.hasOwn(nestedLayer,'render'),false);
assert.equal(nested.getLayers().listeners('add'),0);

const sourceMap=addMap(),srcLayer=sourceMap.getAllLayers()[0];
srcLayer.setSource({}); // unsupported source API
assert.match(sourceMap.getBoostStatus().reason,/VectorTileSource/);

const fast=new BoostMap({target:'m',layers:[new Layer()],boostOptions:{
 backendOptions:{glErrorCheckMode:'nonblocking'}
}});
assert.equal(fast.boost.options.backendOptions.glErrorCheckMode,'nonblocking',
 'Risk-accepting caller can explicitly opt into fast GL error policy');
fast.disableBoost();assert.equal(fast.getBoostStatus().enabled,false);

const fail=addMap(),oldError=fail.boost;
oldError.options.onError({phase:'forced-noncontext-gl-error',error:new Error('GL_INVALID_OPERATION')});
assert.equal(fail.getBoostStatus().enabled,false);
assert.equal(oldError.destroyCount,1);
assert.equal(Object.hasOwn(fail.getAllLayers()[0],'render'),false);
console.log('R83_RELEASE_SAFETY_STRICT_DEFAULT_DYNAMIC_TREE_VARIABLE_FALLBACK_PASS');
