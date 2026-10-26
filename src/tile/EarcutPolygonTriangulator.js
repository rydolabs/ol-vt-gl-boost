import earcut from '../../vendor/openlayers-10.10.0-runtime/node_modules/earcut/src/earcut.js';

function same(a,b){return a?.[0]===b?.[0]&&a?.[1]===b?.[1];}
function cleanRing(input){
  const pts=(input||[]).map(p=>[Number(p?.[0]??0),Number(p?.[1]??0)]);
  if(pts.length>1&&same(pts[0],pts[pts.length-1]))pts.pop();
  const out=[];
  for(const p of pts) if(!out.length||!same(p,out[out.length-1])) out.push(p);
  return out;
}

/**
 * Polygon triangulation strategy backed by earcut.
 * Kept in integration/ so NeutralGeometryCompiler stays dependency-free and
 * alternate triangulators can be injected without changing renderer core.
 */
export class EarcutPolygonTriangulator {
  /** Return original vertex storage and Earcut indices without expanding triangles. */
  triangulateIndexed(rings){
    const cleaned=(rings||[]).map(cleanRing).filter(r=>r.length>=3);
    if(!cleaned.length)return {data:new Float32Array(0),indices:new Uint32Array(0)};
    const flat=[];const holes=[];let vertexCount=0;
    for(let i=0;i<cleaned.length;i++){
      if(i>0)holes.push(vertexCount);
      for(const point of cleaned[i]){flat.push(point[0],point[1]);vertexCount++;}
    }
    return {data:new Float32Array(flat),indices:new Uint32Array(earcut(flat,holes,2))};
  }
  triangulate(rings){
    const cleaned=(rings||[]).map(cleanRing).filter(r=>r.length>=3);
    if(!cleaned.length)return new Float32Array();
    const flat=[];const holes=[];let vertexCount=0;
    for(let i=0;i<cleaned.length;i++){
      if(i>0)holes.push(vertexCount);
      for(const p of cleaned[i]){flat.push(p[0],p[1]);vertexCount++;}
    }
    const indices=earcut(flat,holes,2);
    const out=new Float32Array(indices.length*2);
    let o=0;for(const idx of indices){out[o++]=flat[idx*2];out[o++]=flat[idx*2+1];}
    return out;
  }
}
