import { OlFeatureAdapter } from './OlFeatureAdapter.js';
import { toNeutralFrame } from './frame.js';
import { OlSourceLifecycleAdapter } from './OlSourceLifecycleAdapter.js';
import { toNeutralLayerState } from './layer-state.js';
import { OlLayerLifecycleAdapter } from './layer-state.js';
import { OlLayerTreeAdapter } from './OlLayerTreeAdapter.js';
import { OlVectorTileSourceAdapter } from './OlVectorTileSourceAdapter.js';

/**
 * Thin host adapter. It does not know GPU offsets, allocators, or WebGL handles.
 * The consumer receives neutral feature/frame snapshots through injected ports.
 */
export class OpenLayersAdapter {
  constructor({featureAdapter=new OlFeatureAdapter(),sink=null}={}){this.featureAdapter=featureAdapter;this.sink=sink;}
  adaptFeature(feature,options){return this.featureAdapter.adapt(feature,options);}
  adaptFrame(frameState,options){return toNeutralFrame(frameState,options);}
  syncFeatures(features,options={}){
    const out=Array.from(features||[],f=>this.adaptFeature(f,options));
    this.sink?.replaceFeatures?.(out);
    return out;
  }
  syncFrame(frameState,options={}){const frame=this.adaptFrame(frameState,options);this.sink?.setFrame?.(frame);return frame;}
  adaptLayer(layer){return toNeutralLayerState(layer);}
  syncLayer(layer){const state=this.adaptLayer(layer);this.sink?.setLayerState?.(state);return state;}
  attachLayer(layer,{onState=null,initialSync=true}={}){const bridge=new OlLayerLifecycleAdapter({layer,sink:this.sink,onState});bridge.start({initialSync});return bridge;}
  attachSource(source,{featureOptions={},initialSync=true}={}){const bridge=new OlSourceLifecycleAdapter({source,featureAdapter:this.featureAdapter,sink:this.sink,featureOptions});bridge.start({initialSync});return bridge;}
  attachVectorTileSource(source,{sink=this.sink,featureAdapter,styleLike=null,resolutionProvider=null,layerProperty='layer'}={}){const bridge=new OlVectorTileSourceAdapter({source,sink,featureAdapter,styleLike,resolutionProvider,layerProperty});bridge.start();return bridge;}
  attachLayerTree(rootOrMap,{onSnapshot=null,initialSync=true}={}){const opts=rootOrMap?.getLayerGroup?{map:rootOrMap}:{root:rootOrMap};const bridge=new OlLayerTreeAdapter({...opts,onSnapshot});bridge.start({initialSync});return bridge;}
}


