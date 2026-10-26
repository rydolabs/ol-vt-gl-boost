/**
 * Observe an OpenLayers-style LayerGroup/Collection tree through public APIs.
 *
 * This module intentionally has no `ol/*` imports.  It emits a flattened leaf
 * snapshot with effective visibility/opacity/zIndex and current collection
 * sequence.  The renderer core only consumes the neutral state; concrete layer
 * objects are retained here solely so a composition root can bind their sources.
 */
export class OlLayerTreeAdapter {
  constructor({root=null,map=null,onSnapshot=null}={}){
    this.map=map||null;this.root=root||map?.getLayerGroup?.()||null;
    if(!this.root)throw new Error('OlLayerTreeAdapter requires root group or map');
    this.onSnapshot=onSnapshot;this.started=false;this._keys=new WeakMap();this._nextKey=1;this._unsubs=[];
    this._onChange=()=>this.sync();
    this._onRootChange=()=>{const next=this.map?.getLayerGroup?.()||null;if(next&&next!==this.root)this.root=next;this.sync();};
  }
  _key(layer){if(!this._keys.has(layer))this._keys.set(layer,`ol-layer-${this._nextKey++}`);return this._keys.get(layer);}
  _read(layer,method,prop,def){const v=typeof layer?.[method]==='function'?layer[method]():layer?.[prop];return v==null?def:v;}
  _rawZ(layer){return typeof layer?.getZIndex==='function'?layer.getZIndex():layer?.zIndex;}
  _collection(layer){return typeof layer?.getLayers==='function'?layer.getLayers():null;}
  _array(collection){if(!collection)return[];if(typeof collection.getArray==='function')return [...collection.getArray()];const out=[];collection.forEach?.(x=>out.push(x));return out;}
  _flatten(){
    const out=[];let sequence=0;
    const visit=(layer,parent={visible:true,opacity:1,defaultZ:0},depth=0)=>{
      const visible=parent.visible&&Boolean(this._read(layer,'getVisible','visible',true));
      const opacity=parent.opacity*Math.max(0,Math.min(1,Number(this._read(layer,'getOpacity','opacity',1))));
      const ownZ=this._rawZ(layer);const effectiveZ=ownZ==null?parent.defaultZ:Number(ownZ);
      const collection=this._collection(layer);
      if(collection){
        const nextDefault=ownZ==null?parent.defaultZ:Number(ownZ);
        for(const child of this._array(collection))visit(child,{visible,opacity,defaultZ:nextDefault},depth+1);
        return;
      }
      out.push({key:this._key(layer),layer,sequence:sequence++,depth,state:{visible,opacity,zIndex:effectiveZ}});
    };
    visit(this.root,{visible:true,opacity:1,defaultZ:0},0);return out;
  }
  _listen(target,type,listener=this._onChange){if(!target?.on||!target?.un)return;target.on(type,listener);this._unsubs.push(()=>target.un(type,listener));}
  _clearListeners(){for(const fn of this._unsubs.splice(0))try{fn();}catch{}}
  _subscribeTree(){
    this._clearListeners();const seen=new Set();
    if(this.map)this._listen(this.map,'change:layergroup',this._onRootChange);
    const visit=(layer)=>{if(!layer||seen.has(layer))return;seen.add(layer);for(const t of ['change:zIndex','change:visible','change:opacity','change:source','change:style'])this._listen(layer,t);const c=this._collection(layer);if(c){for(const t of ['add','remove','change:length'])this._listen(c,t);for(const child of this._array(c))visit(child);}};
    visit(this.root);
  }
  snapshot(){return this._flatten();}
  sync(){const snap=this.snapshot();if(this.started)this._subscribeTree();this.onSnapshot?.(snap);return snap;}
  start({initialSync=true}={}){if(this.started)return this;this.started=true;this._subscribeTree();if(initialSync)this.sync();return this;}
  stop(){if(!this.started)return;this.started=false;this._clearListeners();}
}
