import earcut from '../../vendor/openlayers-10.10.0-runtime/node_modules/earcut/src/earcut.js';
import {validClipExtent} from './clip.js';

/**
 * Opt-in OL disable-worker-style polygon encoder: feature flat coordinates and
 * a ring-end group become the final indexed vertex payload. The normal M5
 * GeometryStore/GPU Arena still owns and uploads the completed buffers.
 * No [x,y] ring objects, expanded triangle stream, or per-ring copies are
 * created on the fully-inside fast path.
 */
export function classifyFlatPolygon(flat, ranges, stride, extent){
  if(!validClipExtent(extent))return 'partial';
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,seen=false;
  for(const [start,end] of ranges){
    for(let i=start;i<end;i+=stride){
      const x=Math.fround(Number(flat[i])),y=Math.fround(Number(flat[i+1]));
      if(!Number.isFinite(x)||!Number.isFinite(y))return 'partial';
      seen=true;
      if(x<minX)minX=x;if(x>maxX)maxX=x;
      if(y<minY)minY=y;if(y>maxY)maxY=y;
    }
  }
  if(!seen)return 'partial';
  if(maxX<extent[0]||minX>extent[2]||maxY<extent[1]||minY>extent[3])return 'outside';
  return minX>=extent[0]&&maxX<=extent[2]&&minY>=extent[1]&&maxY<=extent[3]?'inside':'partial';
}

/** Same deduplication / closure semantics as EarcutPolygonTriangulator.cleanRing. */
export function encodeFlatPolygonIndexed(flat,ranges,stride=2){
  const coords=[],holes=[];
  let count=0;
  for(const [start,end] of ranges){
    const begin=count;
    const hasClosure=end-start>=2*stride && flat[start]===flat[end-stride] && flat[start+1]===flat[end-stride+1];
    const stop=hasClosure?end-stride:end;
    let lastX,lastY;
    for(let i=start;i<stop;i+=stride){
      const x=Number(flat[i]),y=Number(flat[i+1]);
      if(count>begin&&x===lastX&&y===lastY)continue;
      coords.push(x,y);count++;lastX=x;lastY=y;
    }
    if(count-begin<3){coords.length=begin*2;count=begin;continue;}
    if(begin>0)holes.push(begin);
  }
  if(!count)return {data:new Float32Array(),indices:new Uint32Array()};
  return {data:new Float32Array(coords),indices:new Uint32Array(earcut(coords,holes,2))};
}

/** Only called for stroked polygons or boundary/clipping fallback. */
export function materializeFlatPolygonRings(flat,ranges,stride=2){
  const rings=[];
  for(const [start,end] of ranges){
    const ring=[];
    for(let i=start;i<end;i+=stride)ring.push([Number(flat[i]),Number(flat[i+1])]);
    if(ring.length && (ring[0][0]!==ring[ring.length-1][0] || ring[0][1]!==ring[ring.length-1][1]))ring.push([...ring[0]]);
    rings.push(ring);
  }
  return rings;
}

/**
 * Append OL-compatible polygon vertices to the FINAL tile vertex writer.
 * Earcut still needs its temporary double-precision coordinate list for
 * topology (rounding it to Float32 before triangulation changes triangles).
 * Crucially there is no per-feature Float32Array, Uint32Array or vertex chunk:
 * the final GPU vertex and index writers are populated while parsing the MVT.
 */
export function appendFlatPolygonIndexedDirect(flat,ranges,stride,vertexWriter,indexWriter){
  const initialVertex=vertexWriter.length/2,initialIndex=indexWriter.length;
  // At most one output vertex per source vertex; reserve once, not per XY.
  let maximumVertices=0;
  for(const [start,end] of ranges)maximumVertices+=(end-start)/stride;
  vertexWriter.ensure(maximumVertices*2);
  const coords=[],holes=[];
  let count=0;
  for(const [start,end] of ranges){
    const begin=count;
    const hasClosure=end-start>=2*stride && flat[start]===flat[end-stride] && flat[start+1]===flat[end-stride+1];
    const stop=hasClosure?end-stride:end;
    let lastX,lastY;
    for(let i=start;i<stop;i+=stride){
      const x=Number(flat[i]),y=Number(flat[i+1]);
      if(count>begin&&x===lastX&&y===lastY)continue;
      coords.push(x,y);
      if(vertexWriter.push2Reserved)vertexWriter.push2Reserved(x,y);
      else vertexWriter.push2(x,y); // legacy/preloop writer compatibility
      count++;lastX=x;lastY=y;
    }
    if(count-begin<3){coords.length=begin*2;count=begin;vertexWriter.truncate((initialVertex+begin)*2);continue;}
    if(begin>0)holes.push(begin);
  }
  if(count){
    const triangleIndices=earcut(coords,holes,2);
    indexWriter.appendOffset(triangleIndices,initialVertex,count-1);
  }
  return {indexStart:initialIndex,count:indexWriter.length-initialIndex};
}
