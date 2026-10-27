/** R67: cohesive implementation, originally separate R64 files. */

// Origin: src/tile/DirectFeatureFlatTriangulation.js
import earcut from '../../vendor/openlayers-10.10.0-runtime/node_modules/earcut/src/earcut.js';

/** Use source RenderFeature coordinates without creating one [x,y] object per point.
 * Closure/duplicate removal and original-vertex order are identical to
 * materializeFlatPolygonRings() + EarcutPolygonTriangulator.cleanRing(). */
function cleanedFlatRing(flat,start,end,stride){
  const result=[];
  const n=(end-start)/stride;
  if(!n)return result;
  const firstX=Number(flat[start]),firstY=Number(flat[start+1]);
  const lastX=Number(flat[end-stride]),lastY=Number(flat[end-stride+1]);
  const stop=(n>1&&firstX===lastX&&firstY===lastY)?end-stride:end;
  let hasLast=false,lastSeenX,lastSeenY;
  for(let i=start;i<stop;i+=stride){
    const x=Number(flat[i]),y=Number(flat[i+1]);
    if(hasLast&&x===lastSeenX&&y===lastSeenY)continue;
    result.push(x,y);hasLast=true;lastSeenX=x;lastSeenY=y;
  }
  return result;
}

// Ring order, cleaning and index generation match EarcutPolygonTriangulator.
export function triangulateEarcutFlat(flat,ranges,stride=2){
  const coords=[],holes=[];
  for(const [start,end] of ranges){
    const cleaned=cleanedFlatRing(flat,start,end,stride);
    if(cleaned.length<6)continue;
    if(coords.length)holes.push(coords.length/2);
    for(let j=0;j<cleaned.length;j++)coords.push(cleaned[j]);
  }
  if(!coords.length)return new Float32Array(0);
  const indices=earcut(coords,holes,2);
  const out=new Float32Array(indices.length*2);
  let o=0;for(const idx of indices){out[o++]=coords[idx*2];out[o++]=coords[idx*2+1];}
  return out;
}

// Same original ear clipping algorithm/order; only the intermediate vertex
// representation changes from an array of [x,y] to interleaved doubles.
export function triangulateSimpleFlat(flat,start,end,stride=2,bbox=true){
  const ring=cleanedFlatRing(flat,start,end,stride),count=ring.length/2;
  if(count<3)return new Float32Array(0);
  // R29 opt-in: linearithmic earcut on partial single-ring polygon meshes.
  // Outputs mathematically equivalent triangle coverage with different internal
  // tessellation, so require an independent exact GPU output gate before use.
  if(globalThis.__m5R29EarcutPartial===true){
    const ids=earcut(ring,null,2),result=new Float32Array(ids.length*2);
    for(let i=0;i<ids.length;i++){result[2*i]=ring[2*ids[i]];result[2*i+1]=ring[2*ids[i]+1];}
    return result;
  }
  let signedArea=0;
  for(let i=0,j=count-1;i<count;j=i++){
    signedArea+=ring[2*j]*ring[2*i+1]-ring[2*i]*ring[2*j+1];
  }
  const ids=Array.from({length:count},(_,i)=>signedArea<0?count-1-i:i);
  const tris=[];
  let guard=0;
  const cross=(ia,ib,ic)=>{
    const a=ia*2,b=ib*2,c=ic*2;
    return (ring[b]-ring[a])*(ring[c+1]-ring[a+1])-(ring[b+1]-ring[a+1])*(ring[c]-ring[a]);
  };
  while(ids.length>3&&guard++<count*count){
    let clipped=false;
    for(let k=0;k<ids.length;k++){
      const ia=ids[(k-1+ids.length)%ids.length],ib=ids[k],ic=ids[(k+1)%ids.length];
      if(cross(ia,ib,ic)<=0)continue;
      const a=ia*2,b=ib*2,c=ic*2;
      const lowX=bbox?Math.min(ring[a],ring[b],ring[c]):0;
      const highX=bbox?Math.max(ring[a],ring[b],ring[c]):0;
      const lowY=bbox?Math.min(ring[a+1],ring[b+1],ring[c+1]):0;
      const highY=bbox?Math.max(ring[a+1],ring[b+1],ring[c+1]):0;
      let contains=false;
      for(const id of ids){
        if(id===ia||id===ib||id===ic)continue;
        const point=id*2,x=ring[point],y=ring[point+1];
        if(bbox&&Number.isFinite(x)&&Number.isFinite(y)&&(x<lowX||x>highX||y<lowY||y>highY))continue;
        const c1=cross(ia,ib,id),c2=cross(ib,ic,id),c3=cross(ic,ia,id);
        const neg=c1<0||c2<0||c3<0,pos=c1>0||c2>0||c3>0;
        if(!(neg&&pos)){contains=true;break;}
      }
      if(contains)continue;
      tris.push(ring[a],ring[a+1],ring[b],ring[b+1],ring[c],ring[c+1]);
      ids.splice(k,1);clipped=true;break;
    }
    if(!clipped)throw new Error('Unable to triangulate polygon ring (self-intersection or degeneracy)');
  }
  if(ids.length===3){for(const id of ids){const p=id*2;tris.push(ring[p],ring[p+1]);}}
  return new Float32Array(tris);
}

// Origin: src/tile/DirectFeaturePolygonBuffers.js
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
