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
