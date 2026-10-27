/** R68: grouped legacy compatibility utilities; algorithms preserved without changes. */

// Consolidated from src/compat/core/RenderReferenceStore.js
function sig(r){
  return `${r.id ?? ''}|${r.geometryId}|${r.styleId}|${r.geometryType}|${r.order ?? 0}|${r.visible!==false?1:0}|${r.layerId ?? ''}|${r.tileId ?? ''}|${r.tileKey ?? ''}|${r.sceneLayerKey ?? ''}|${r.sceneLayerZIndex ?? 0}|${r.sceneLayerSequence ?? 0}|${r.sceneStyleZIndex ?? 0}|${r.sceneWorldOffsetX ?? 0}`;
}

// Most publications from RendererSceneCoordinator contain new *objects* with
// unchanged primitive fields. Comparing those fields without materializing
// string signatures avoids large temporary strings and GC pressure.
//
// The slow path preserves the exact legacy signature contract (including its
// string coercions) when a field differs or has an unexpected representation.
function sameSignature(a,b){
  if(a===b)return true;
  if((a.id??'')===(b.id??'') &&
     a.geometryId===b.geometryId && a.styleId===b.styleId &&
     a.geometryType===b.geometryType && (a.order??0)===(b.order??0) &&
     (a.visible!==false)===(b.visible!==false) &&
     (a.layerId??'')===(b.layerId??'') &&
     (a.tileId??'')===(b.tileId??'') && (a.tileKey??'')===(b.tileKey??'') &&
     (a.sceneLayerKey??'')===(b.sceneLayerKey??'') &&
     (a.sceneLayerZIndex??0)===(b.sceneLayerZIndex??0) &&
     (a.sceneLayerSequence??0)===(b.sceneLayerSequence??0) &&
     (a.sceneStyleZIndex??0)===(b.sceneStyleZIndex??0) &&
     (a.sceneWorldOffsetX??0)===(b.sceneWorldOffsetX??0))return true;
  return sig(a)===sig(b);
}

const TYPES=['polygon','line','point'];
export class RenderReferenceStore {
  constructor(references=[]){this.references=[];this.version=0;this.byType={polygon:[],line:[],point:[]};this.set(references);}
  set(references){
    const next=[...references];
    // Re-group old objects as well: the legacy store observes in-place edits
    // to geometryType when it compares the next publication. This scan is
    // cheap and preserves that contract without constructing signatures.
    const previous={polygon:[],line:[],point:[]};
    for(const r of this.references)if(previous[r.geometryType])previous[r.geometryType].push(r);
    const grouped={polygon:[],line:[],point:[]};
    for(const r of next)if(grouped[r.geometryType])grouped[r.geometryType].push(r);
    const changedTypes=new Set();
    for(const type of TYPES){
      const a=previous[type],b=grouped[type];
      if(a.length!==b.length){changedTypes.add(type);continue;}
      for(let i=0;i<a.length;i++){
        if(!sameSignature(a[i],b[i])){changedTypes.add(type);break;}
      }
    }
    this.references=next;
    this.byType=grouped;
    if(changedTypes.size)this.version++;
    return changedTypes;
  }
  getAll(){return this.references;}
}

// Consolidated from src/compat/core/RenderSchedule.js
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
