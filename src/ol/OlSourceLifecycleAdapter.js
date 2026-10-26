import { OlFeatureAdapter } from './OlFeatureAdapter.js';

function on(source,type,fn){
  if(typeof source?.on==='function'){const key=source.on(type,fn);return ()=>{if(typeof source.un==='function')source.un(type,fn);else if(typeof key?.unlisten==='function')key.unlisten();};}
  if(typeof source?.addEventListener==='function'){source.addEventListener(type,fn);return ()=>source.removeEventListener?.(type,fn);}
  throw new Error('source must expose on/un or addEventListener/removeEventListener');
}
function eventFeature(e){return e?.feature??e?.target?.feature??null;}
function resolveStyles(feature,{styleLike=null,resolution=1}={}){
  let value=typeof feature?.getStyle==='function'?feature.getStyle():feature?.style;
  value=value??styleLike;if(typeof value==='function')value=value(feature,resolution);return (Array.isArray(value)?value:[value]).filter(Boolean);
}
function watchStyleImages(feature,options,notify){
  const disposers=[];
  for(const style of resolveStyles(feature,options)){
    const image=typeof style?.getImage==='function'?style.getImage():style?.image;
    if(typeof image?.listenImageChange==='function'){
      const fn=()=>notify();image.listenImageChange(fn);disposers.push(()=>image.unlistenImageChange?.(fn));
    }
  }
  return ()=>{for(const d of disposers)d();};
}

/** Convert OL VectorSource lifecycle into neutral feature sink operations. */
export class OlSourceLifecycleAdapter {
  constructor({source,featureAdapter=new OlFeatureAdapter(),sink,featureOptions={}}={}){
    if(!source)throw new Error('OlSourceLifecycleAdapter requires source');if(!sink)throw new Error('OlSourceLifecycleAdapter requires sink');
    this.source=source;this.featureAdapter=featureAdapter;this.sink=sink;this.featureOptions=featureOptions;this.disposers=[];this.featureChangeDisposers=new Map();this.started=false;
  }
  _adapt(f){return this.featureAdapter.adapt(f,this.featureOptions);}
  _watchFeature(feature){
    if(this.featureChangeDisposers.has(feature))return;
    let imageDispose=()=>{};
    const sync=()=>{imageDispose();imageDispose=watchStyleImages(feature,this.featureOptions,()=>this.sink.upsertFeature?.(this._adapt(feature)));this.sink.upsertFeature?.(this._adapt(feature));};
    let featureDispose=()=>{};
    if(typeof feature?.on==='function'){
      const key=feature.on('change',sync);featureDispose=()=>{if(typeof feature.un==='function')feature.un('change',sync);else if(typeof key?.unlisten==='function')key.unlisten();};
    }
    imageDispose=watchStyleImages(feature,this.featureOptions,()=>this.sink.upsertFeature?.(this._adapt(feature)));
    this.featureChangeDisposers.set(feature,()=>{featureDispose();imageDispose();});
  }
  _unwatchFeature(feature){const d=this.featureChangeDisposers.get(feature);if(d)d();this.featureChangeDisposers.delete(feature);}
  start({initialSync=true}={}){
    if(this.started)return this;this.started=true;
    if(initialSync){const fs=typeof this.source.getFeatures==='function'?this.source.getFeatures():[];for(const f of fs)this._watchFeature(f);this.sink.replaceFeatures?.(fs.map(f=>this._adapt(f)));}
    this.disposers.push(on(this.source,'addfeature',e=>{const f=eventFeature(e);if(!f)return;this._watchFeature(f);this.sink.upsertFeature?.(this._adapt(f));}));
    this.disposers.push(on(this.source,'removefeature',e=>{const f=eventFeature(e);if(!f)return;this._unwatchFeature(f);this.sink.removeFeature?.(this.featureAdapter.keyOf(f));}));
    this.disposers.push(on(this.source,'clear',()=>{for(const d of this.featureChangeDisposers.values())d();this.featureChangeDisposers.clear();this.sink.clear?.();}));
    return this;
  }
  stop(){for(const d of this.disposers.splice(0))d();for(const d of this.featureChangeDisposers.values())d();this.featureChangeDisposers.clear();this.started=false;return this;}
}
