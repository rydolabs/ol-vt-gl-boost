import assert from 'node:assert/strict';
import {OLVectorTileBoost,DirectM5SceneBinding} from '../src/index.js';
class MockMap {
  constructor(){this.listeners=new Map();this.group={getLayers:()=>({getArray:()=>[]})};}
  getLayerGroup(){return this.group;}
  getView(){return {getResolution:()=>1};}
  on(name,cb){this.listeners.set(name,cb);return {unlisten:()=>this.listeners.delete(name)};}
  un(name){this.listeners.delete(name);}
  render(){} renderSync(){}
}
const map=new MockMap(),backend={canvas:{width:512,height:512},gl:{}};
assert.throws(()=>new OLVectorTileBoost({}),/requires an OpenLayers map/);
assert.throws(()=>new OLVectorTileBoost({map}),/requires a canvas or WebGL backend/);
const boost=new OLVectorTileBoost({map,backend});
assert(boost.scene instanceof DirectM5SceneBinding);
assert.equal(boost.workerEnabled,false);
assert.equal(boost.started,false);
assert.equal(boost.start({renderSync:false}),boost);
assert.equal(boost.started,true);
assert.equal(boost.snapshot().tileCount,0);
assert.equal(boost.sync().tileCount,0);
assert.equal(boost.stop(),boost);assert.equal(boost.started,false);
assert.equal(boost.destroy(),boost);
console.log('R67_FACADE_LIFECYCLE_PASS');
