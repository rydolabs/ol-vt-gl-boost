import { classifyFlatPolygon, encodeFlatPolygonIndexed } from './polygon.js';
import { clipTriangleMeshToExtent } from './clip.js';
import { classifyPolygonClip } from './clip.js';
function xy(p){return [Number(p?.[0]??0),Number(p?.[1]??0)];}
function same(a,b){return a[0]===b[0]&&a[1]===b[1];}
function area(ring){let a=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)a+=(ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1]);return a/2;}
function cross(a,b,c){return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function inTri(p,a,b,c){const c1=cross(a,b,p),c2=cross(b,c,p),c3=cross(c,a,p);const neg=c1<0||c2<0||c3<0,pos=c1>0||c2>0||c3>0;return !(neg&&pos);}
function cleanRing(input){const pts=(input||[]).map(xy);if(pts.length>1&&same(pts[0],pts[pts.length-1]))pts.pop();const out=[];for(const p of pts)if(!out.length||!same(p,out[out.length-1]))out.push(p);return out;}

/** Ear-clipping triangulation for one simple polygon ring. */
export function triangulateSimpleRing(input, boundingBoxPrecheck=false){
  let ring=cleanRing(input);if(ring.length<3)return new Float32Array();
  if(area(ring)<0)ring=ring.slice().reverse();
  const ids=ring.map((_,i)=>i), tris=[];let guard=0;
  while(ids.length>3&&guard++<ring.length*ring.length){
    let clipped=false;
    for(let k=0;k<ids.length;k++){
      const ia=ids[(k-1+ids.length)%ids.length],ib=ids[k],ic=ids[(k+1)%ids.length];
      const a=ring[ia],b=ring[ib],c=ring[ic];if(cross(a,b,c)<=0)continue;
      // A triangle can never contain a finite point beyond its AABB. Most
      // candidate ears have a much smaller AABB than the full polygon, so
      // skip three cross products for exterior vertices without reordering
      // the test, triangle emission or Float32 rounding.
      const lowX=boundingBoxPrecheck?Math.min(a[0],b[0],c[0]):0;
      const highX=boundingBoxPrecheck?Math.max(a[0],b[0],c[0]):0;
      const lowY=boundingBoxPrecheck?Math.min(a[1],b[1],c[1]):0;
      const highY=boundingBoxPrecheck?Math.max(a[1],b[1],c[1]):0;
      let contains=false;for(const id of ids){
        if(id===ia||id===ib||id===ic)continue;
        const p=ring[id];
        if(boundingBoxPrecheck&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&
           (p[0]<lowX||p[0]>highX||p[1]<lowY||p[1]>highY))continue;
        if(inTri(p,a,b,c)){contains=true;break;}
      }
      if(contains)continue;tris.push(...a,...b,...c);ids.splice(k,1);clipped=true;break;
    }
    if(!clipped)throw new Error('Unable to triangulate polygon ring (self-intersection or degeneracy)');
  }
  if(ids.length===3)tris.push(...ring[ids[0]],...ring[ids[1]],...ring[ids[2]]);
  return new Float32Array(tris);
}

/**
 * Experimental indexed equivalent of triangulateSimpleRing(). Preserve the
 * original ear-removal order exactly; unlike the expanded triangle stream,
 * each ring vertex is stored once and only indices are appended.
 */
export function triangulateSimpleRingIndexed(input){
  let ring=cleanRing(input);
  if(ring.length<3)return {data:new Float32Array(0),indices:new Uint32Array(0)};
  if(area(ring)<0)ring=ring.slice().reverse();
  const ids=ring.map((_,i)=>i),indices=[];let guard=0;
  while(ids.length>3&&guard++<ring.length*ring.length){
    let clipped=false;
    for(let k=0;k<ids.length;k++){
      const ia=ids[(k-1+ids.length)%ids.length],ib=ids[k],ic=ids[(k+1)%ids.length];
      const a=ring[ia],b=ring[ib],c=ring[ic];if(cross(a,b,c)<=0)continue;
      let contains=false;for(const id of ids){if(id===ia||id===ib||id===ic)continue;if(inTri(ring[id],a,b,c)){contains=true;break;}}
      if(contains)continue;indices.push(ia,ib,ic);ids.splice(k,1);clipped=true;break;
    }
    if(!clipped)throw new Error('Unable to triangulate polygon ring (self-intersection or degeneracy)');
  }
  if(ids.length===3)indices.push(ids[0],ids[1],ids[2]);
  const data=new Float32Array(ring.length*2);
  for(let i=0;i<ring.length;i++){data[i*2]=ring[i][0];data[i*2+1]=ring[i][1];}
  return {data,indices:new Uint32Array(indices)};
}

/** Convert neutral adapter geometry into the renderer's platform-neutral geometry payload. */
export class NeutralGeometryCompiler {
  constructor({polygonTriangulator=null,polygonClipPrecheck=false,polygonIndexedInside=false,polygonEarcutSimple=false}={}){this.polygonTriangulator=polygonTriangulator;this.polygonClipPrecheck=polygonClipPrecheck===true;this.polygonIndexedInside=polygonIndexedInside===true;this.polygonEarcutSimple=polygonEarcutSimple===true;}
  compile(neutral){
    if(!neutral)throw new Error('neutral geometry is required');
    if(neutral.kind==='point'){if(neutral.directFeaturePoint===true)return {type:'point',data:new Float32Array([neutral.flatCoordinates[neutral.flatStart],neutral.flatCoordinates[neutral.flatStart+1]])};return {type:'point',data:new Float32Array(xy(neutral.coordinates))};}
    if(neutral.kind==='line' && neutral.directGpuJoin===true)
      return {type:'line',directGpuJoin:true,gpuJoin:true,flatCoordinates:neutral.flatCoordinates,flatEnds:neutral.flatEnds,flatStart:neutral.flatStart,flatEnd:neutral.flatEnd,flatStride:neutral.flatStride,instanceCount:neutral.instanceCount};
    if(neutral.kind==='line' && neutral.flatGpu===true)
      return {type:'line',flatGpu:true,gpuJoin:true,flatCoordinates:neutral.flatCoordinates,flatEnds:neutral.flatEnds,flatStart:neutral.flatStart,flatEnd:neutral.flatEnd,flatStride:neutral.flatStride,flatPointCount:neutral.flatPointCount,flatPathCount:neutral.flatPathCount,instanceCount:neutral.instanceCount};
    if(neutral.kind==='line' && neutral.instanceData instanceof Float32Array)
      return {type:'line',instanceData:neutral.instanceData,instanceCount:neutral.instanceCount,gpuJoin:neutral.gpuJoin===true};
    if(neutral.kind==='line')return Array.isArray(neutral.parts)
      ? {type:'line',paths:neutral.parts.map(path=>(path||[]).map(xy))}
      : {type:'line',coords:(neutral.coordinates||[]).map(xy)};
    if(neutral.kind==='polygon'){
      if(neutral.flatPolygonBuffers===true && this.polygonClipPrecheck &&
         this.polygonIndexedInside && this.polygonEarcutSimple && this.polygonTriangulator){
        const location=classifyFlatPolygon(neutral.flatCoordinates,neutral.flatRanges,neutral.flatStride,neutral.clipExtent);
        if(location==='outside')return {type:'polygon',data:new Float32Array(0)};
        if(location==='inside')return {type:'polygon',...encodeFlatPolygonIndexed(neutral.flatCoordinates,neutral.flatRanges,neutral.flatStride)};
        // Partial polygon / invalid or missing extent: preserve old tile-edge
        // clipping and OL Earcut behavior (including triangle expansion).
      }
      const rings=neutral.rings||[];
      // Only the optional experimental path does the ring-level precheck.
      // Default compiler behavior remains unchanged for every caller.
      const location=this.polygonClipPrecheck
        ? classifyPolygonClip(rings,neutral.clipExtent) : 'partial';
      if(location==='outside')return {type:'polygon',data:new Float32Array(0)};
      // The feature is entirely within the tile; source vertices plus an
      // index list are sufficient. For boundary-crossing geometry the old
      // clipping path remains authoritative to preserve exact edge behavior.
      if(this.polygonIndexedInside && location==='inside'){
        const indexed=rings.length>1
          ? this.polygonTriangulator?.triangulateIndexed?.(rings)
          : (this.polygonEarcutSimple ? this.polygonTriangulator?.triangulateIndexed?.(rings) : triangulateSimpleRingIndexed(rings[0]||[]));
        if(indexed?.data instanceof Float32Array && indexed.indices instanceof Uint32Array)
          return {type:'polygon',data:indexed.data,indices:indexed.indices};
      }
      let mesh;
      if(rings.length>1){
        if(!this.polygonTriangulator?.triangulate)throw new Error('Polygon holes require an injected polygon triangulator');
        mesh=this.polygonTriangulator.triangulate(rings);
      }else mesh=this.polygonEarcutSimple && location==='inside' && this.polygonTriangulator?.triangulate
        ? this.polygonTriangulator.triangulate(rings) : triangulateSimpleRing(rings[0]||[]);
      return {type:'polygon',data:location==='inside'?mesh:clipTriangleMeshToExtent(mesh,neutral.clipExtent)};
    }
    throw new Error(`Unsupported neutral geometry kind: ${neutral.kind}`);
  }
}
