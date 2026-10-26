/**
 * An ordered *view*, not a GeometryStore/ReferenceStore resource. Expand a
 * single-style packed MultiLineString into virtual path draw spans in the exact
 * same order as the legacy `parts` compiler. Only minimal metadata is copied.
 *
 * A per-tile sink's orderSeed resets at zero, so global sorting MUST include
 * every original path's local order: sorting by the packed feature order alone
 * reorders overlapping, alpha-blended lines across tiles.
 */
export function expandPackedPathOrder(references){
  if(!(references||[]).some(r=>Array.isArray(r.packedPathInstanceCounts)))return references;
  const out=[];
  for(const r of references){
    const counts=r.packedPathInstanceCounts;
    if(!Array.isArray(counts)){out.push(r);continue;}
    let start=0,pointStart=0;
    for(let i=0;i<counts.length;i++){
      const count=counts[i];
      // Zero-length path still participates in ordering, matching legacy PARTS.
      out.push({...r,id:`${r.id}:ordered-path:${i}`,order:(r.order??0)+i,
        packedPathIndex:i,packedPathStart:start,packedPathCount:count,
        packedPathPointStart:pointStart,packedPathPointCount:r.packedPathVertexCounts?.[i]??count+1});
      start+=count;
      pointStart+=r.packedPathVertexCounts?.[i]??count+1;
    }
  }
  return out;
}
