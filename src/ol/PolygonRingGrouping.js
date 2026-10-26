/**
 * Orientation grouping equivalent to OpenLayers 10.10.0 inflateEnds() for
 * MVT RenderFeature's flat rings. This is an opt-in alternative to M5's
 * containment search; it uses O(vertices + rings) coordinate work.
 *
 * IMPORTANT: Orientation semantics are intentionally OL's, including
 * degenerate rings and the case where input winding is not conventional.
 * No mapping by containment and no per-ring BBox search is performed.
 */
export function linearRingIsClockwiseFlat(flat, start, end, stride=2) {
  let edge=0;
  let x1=flat[end-stride], y1=flat[end-stride+1];
  for(let i=start;i<end;i+=stride){
    const x2=flat[i],y2=flat[i+1];
    edge+=(x2-x1)*(y2+y1);
    x1=x2;y1=y2;
  }
  return edge===0?undefined:edge>0;
}

export function olPolygonEndss(flat,ends,stride=2){
  const out=[];
  let start=0,previousEndIndex=0,outerOrientation;
  for(let i=0;i<ends.length;i++){
    const end=ends[i];
    const winding=linearRingIsClockwiseFlat(flat,start,end,stride);
    if(outerOrientation===undefined)outerOrientation=winding;
    if(winding===outerOrientation){
      out.push(ends.slice(previousEndIndex,i+1));
    }else{
      if(out.length===0){start=end;continue;}
      out[out.length-1].push(ends[previousEndIndex]);
    }
    previousEndIndex=i+1;
    start=end;
  }
  return out;
}

/** Allocate each coordinate exactly once, after cheap flat-coordinate grouping. */
export function polygonPartsOlOrientation(flat,ends,stride=2){
  const grouped=olPolygonEndss(flat,ends,stride);
  const parts=[];
  const starts=new Map();
  let previous=0;
  for(const end of ends){starts.set(end,previous);previous=end;}
  for(const group of grouped){
    const rings=[];
    for(const end of group){
      const ring=[];
      const offset=starts.get(end)??0;
      for(let i=offset;i<end;i+=stride)ring.push([Number(flat[i]),Number(flat[i+1])]);
      if(ring.length && (ring[0][0]!==ring[ring.length-1][0]||ring[0][1]!==ring[ring.length-1][1]))ring.push([...ring[0]]);
      rings.push(ring);
    }
    parts.push(rings);
  }
  return parts;
}

/** Classify polygon ring orientation and tile BBox in ONE visit per source XY.
 * Matches olPolygonEndss() grouping and classifyFlatPolygon() Float32 BBox
 * semantics, including OL's undefined winding for zero-area rings.
 * This returns only range metadata: no [x,y] objects or coordinate copies.
 */
export function olPolygonRangesWithBounds(flat,ends,stride=2,extent=null,strokePadding=0){
  const groups=[];
  const ringByEnd=new Map();
  let start=0,previousEndIndex=0,outerOrientation;
  const hasExtent=Array.isArray(extent)&&extent.length===4&&extent.every(Number.isFinite)&&extent[0]<extent[2]&&extent[1]<extent[3];
  for(let i=0;i<ends.length;i++){
    const end=ends[i];
    let edge=0,x1=flat[end-stride],y1=flat[end-stride+1];
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,valid=true,seen=false;
    for(let j=start;j<end;j+=stride){
      const x2=flat[j],y2=flat[j+1];
      edge+=(x2-x1)*(y2+y1);x1=x2;y1=y2;
      const x=Math.fround(Number(x2)),y=Math.fround(Number(y2));
      if(!Number.isFinite(x)||!Number.isFinite(y))valid=false;
      seen=true;
      if(x<minX)minX=x;if(x>maxX)maxX=x;
      if(y<minY)minY=y;if(y>maxY)maxY=y;
    }
    // The source group maps rings by end offset, as does the old Map in the
    // Direct encoder. Keep the same lookup semantics for repeated end offsets.
    ringByEnd.set(end,{start,end,minX,minY,maxX,maxY,valid,seen});
    const winding=edge===0?undefined:edge>0;
    if(outerOrientation===undefined)outerOrientation=winding;
    if(winding===outerOrientation)groups.push(ends.slice(previousEndIndex,i+1));
    else{
      if(groups.length===0){start=end;continue;}
      groups[groups.length-1].push(ends[previousEndIndex]);
    }
    previousEndIndex=i+1;
    start=end;
  }
  return groups.map(group=>{
    const ranges=[];
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,valid=true,seen=false;
    for(const end of group){
      const ring=ringByEnd.get(end);
      // Invalid offsets are handled by the legacy path through classification;
      // normal RenderFeatures always have strictly increasing ring ends.
      if(!ring){valid=false;ranges.push([0,end]);continue;}
      ranges.push([ring.start,end]);
      valid&&=ring.valid;seen||=ring.seen;
      if(ring.minX<minX)minX=ring.minX;
      if(ring.minY<minY)minY=ring.minY;
      if(ring.maxX>maxX)maxX=ring.maxX;
      if(ring.maxY>maxY)maxY=ring.maxY;
    }
    const location=!hasExtent||!valid||!seen?'partial':
      maxX<extent[0]||minX>extent[2]||maxY<extent[1]||minY>extent[3]?'outside':
      minX>=extent[0]&&maxX<=extent[2]&&minY>=extent[1]&&maxY<=extent[3]?'inside':'partial';
    // A polygon whose fill is outside the tile can still contribute an
    // antialiased outline across the exact tile scissor boundary. Preserve the
    // original fill classification; only the stroke domain is expanded.
    const strokeLocation=(!hasExtent||strokePadding<=0)?location:
      maxX<extent[0]-strokePadding||minX>extent[2]+strokePadding||
      maxY<extent[1]-strokePadding||minY>extent[3]+strokePadding?'outside':
      minX>=extent[0]-strokePadding&&maxX<=extent[2]+strokePadding&&
      minY>=extent[1]-strokePadding&&maxY<=extent[3]+strokePadding?'inside':'partial';
    return {ranges,location,strokeLocation};
  });
}

