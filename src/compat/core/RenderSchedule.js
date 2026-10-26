const PASS_ORDER=['polygon','line','point'];

/**
 * Host-neutral draw scheduler.
 *
 * Scene ordering rules intentionally mirror the semantics required by adapters:
 *   1. scene layer z-index
 *   2. scene layer sequence (collection/insertion order)
 *   3. style z-index inside each layer
 *   4. renderer pass order inside each style-z bucket
 *
 * The core does not know OpenLayers; adapters merely populate the neutral
 * sceneLayer* / sceneStyleZIndex metadata.
 */
export class RenderSchedule {
  constructor({passOrder=PASS_ORDER}={}){this.passOrder=[...passOrder];}
  build(references=[]){
    const visible=(references||[]).filter(r=>r.visible!==false);
    const hasLayers=visible.some(r=>r.sceneLayerKey!=null);
    if(!hasLayers){
      const passes={polygon:[],line:[],point:[]};
      for(const r of [...visible].sort((a,b)=>(a.sceneStyleZIndex??0)-(b.sceneStyleZIndex??0)||(a.order??0)-(b.order??0))) (passes[r.geometryType]??=[]).push(r);
      return [{key:'__default',zIndex:0,sequence:0,styleZIndex:0,passes,references:this.passOrder.flatMap(t=>passes[t]||[])}];
    }
    const layers=new Map();
    for(const r of visible){
      const key=String(r.sceneLayerKey??'__default');
      if(!layers.has(key)) layers.set(key,{key,zIndex:Number(r.sceneLayerZIndex??0),sequence:Number(r.sceneLayerSequence??0),refs:[]});
      const g=layers.get(key);g.refs.push(r);
      g.zIndex=Math.min(g.zIndex,Number(r.sceneLayerZIndex??g.zIndex));
      g.sequence=Math.min(g.sequence,Number(r.sceneLayerSequence??g.sequence));
    }
    const orderedLayers=[...layers.values()].sort((a,b)=>a.zIndex-b.zIndex||a.sequence-b.sequence||a.key.localeCompare(b.key));
    const out=[];
    for(const layer of orderedLayers){
      const zs=new Map();
      for(const r of layer.refs){
        const z=Number(r.sceneStyleZIndex??0);
        if(!zs.has(z))zs.set(z,{polygon:[],line:[],point:[]});
        (zs.get(z)[r.geometryType]??=[]).push(r);
      }
      for(const z of [...zs.keys()].sort((a,b)=>a-b)){
        const passes=zs.get(z);
        for(const type of this.passOrder) passes[type].sort((a,b)=>(a.order??0)-(b.order??0));
        out.push({key:layer.key,zIndex:layer.zIndex,sequence:layer.sequence,styleZIndex:z,passes,references:this.passOrder.flatMap(t=>passes[t]||[])});
      }
    }
    return out;
  }
}
