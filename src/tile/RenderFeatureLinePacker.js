/**
 * RenderFeature flat XY[Z/M] coordinates -> M5 WebGL Line instance attributes.
 *
 * This is intentionally the same 8-float shader contract as LineRenderer's
 * existing writer. It never inflates [x,y] coordinate objects, builds neutral
 * paths, or writes an intermediate GeometryBuffer. Line joins and distance
 * remain CPU-derived for now to preserve the current GPU shader's exact pixels.
 *
 * `ends` are OpenLayers flat-coordinate offsets, not point indices.
 */
function angleBetweenXY(x0,y0,xa,ya,xb,yb){
  const ax=xa-x0,ay=ya-y0,bx=xb-x0,by=yb-y0;
  if((ax===0&&ay===0)||(bx===0&&by===0))return 0;
  let a=Math.atan2(ax*by-ay*bx,ax*bx+ay*by);
  if(a<=0)a+=Math.PI*2;
  return a;
}

export function packRenderFeatureLineInstances(flat, ends=null, stride=2, rangeStart=0, rangeEnd=flat.length, closedLineJoins=false){
  if(!flat || !Number.isInteger(stride) || stride<2)throw new Error('Invalid flat coordinates/stride');
  if(!Number.isInteger(rangeStart)||!Number.isInteger(rangeEnd)||rangeStart<0||rangeEnd>flat.length||rangeStart>rangeEnd)throw new Error('Invalid flat coordinate range');
  const stops=ends?.length?ends:[rangeEnd];
  let previous=rangeStart,total=0;
  for(const stop of stops){
    if(!Number.isInteger(stop)||stop<previous||stop>rangeEnd||(stop-previous)%stride!==0)
      throw new Error('Invalid RenderFeature line ends');
    total+=Math.max(0,(stop-previous)/stride-1);
    previous=stop;
  }
  if(previous!==rangeEnd)throw new Error('RenderFeature line ends do not cover coordinates');

  const data=new Float32Array(total*8);
  let o=0,start=rangeStart;
  for(const stop of stops){
    const count=(stop-start)/stride;
    const n=Math.max(0,count-1);
    const joins=new Float64Array(count);
    if(count){joins[0]=-1;joins[count-1]=-1;}
    const closed=closedLineJoins && count>=4 && flat[start]===flat[stop-stride] &&
      flat[start+1]===flat[stop-stride+1];
    if(closed){
      joins[0]=angleBetweenXY(flat[start],flat[start+1],
        flat[start+stride],flat[start+stride+1],flat[stop-2*stride],flat[stop-2*stride+1]);
      joins[count-1]=joins[0];
    }
    for(let i=1;i<count-1;i++){
      const idx=start+i*stride, nx=idx+stride, pv=idx-stride;
      joins[i]=angleBetweenXY(flat[idx],flat[idx+1],flat[nx],flat[nx+1],flat[pv],flat[pv+1]);
    }
    let dist=0,tanSum=0;
    for(let i=0;i<n;i++){
      const idx=start+i*stride,nx=idx+stride;
      const x0=flat[idx],y0=flat[idx+1],x1=flat[nx],y1=flat[nx+1];
      const a0=joins[i],a1=i<n-1||closed?Math.PI*2-joins[i+1]:-1;
      data[o++]=x0;data[o++]=y0;data[o++]=x1;data[o++]=y1;
      data[o++]=dist;data[o++]=a0;data[o++]=a1;data[o++]=tanSum;
      if(i>0&&Math.abs(Math.cos(a0))<=.98)tanSum+=Math.tan((a0-Math.PI)/2);
      if(i<n-1&&Math.abs(Math.cos(a1))<=.98)tanSum+=Math.tan((Math.PI-a1)/2);
      dist+=Math.hypot(x1-x0,y1-y0);
    }
    start=stop;
  }
  return {instanceData:data,instanceCount:total};
}

/**
 * Experimental GPU-join representation for solid lines only.
 * Eight floats per segment: [previous XY, start XY, end XY, next XY].
 * The first/last neighbors repeat the endpoint, letting the vertex shader
 * detect caps without another buffer. Repeated consecutive coordinates are
 * deliberately rejected: those need explicit cap flags to preserve semantics.
 * `ends` remain flat coordinate offsets; no paths or CPU join/trig work.
 * The legacy packer is required for dashes, patterns, offset and degenerate paths.
 */
export function packRenderFeatureGpuJoinNeighbors(flat, ends=null, stride=2, rangeStart=0, rangeEnd=flat.length){
  if(!flat || !Number.isInteger(stride) || stride<2)throw new Error('Invalid flat coordinates/stride');
  if(!Number.isInteger(rangeStart)||!Number.isInteger(rangeEnd)||rangeStart<0||rangeEnd>flat.length||rangeStart>rangeEnd)throw new Error('Invalid flat coordinate range');
  const stops=ends?.length?ends:[rangeEnd];
  let previous=rangeStart,total=0;
  for(const stop of stops){
    if(!Number.isInteger(stop)||stop<previous||stop>rangeEnd||(stop-previous)%stride!==0)
      throw new Error('Invalid RenderFeature line ends');
    for(let i=previous+stride;i<stop;i+=stride){
      if(Math.fround(flat[i])===Math.fround(flat[i-stride])&&Math.fround(flat[i+1])===Math.fround(flat[i-stride+1]))return null;
    }
    total+=Math.max(0,(stop-previous)/stride-1);previous=stop;
  }
  if(previous!==rangeEnd)throw new Error('RenderFeature line ends do not cover coordinates');
  const data=new Float32Array(total*8);
  let offset=0,start=rangeStart;
  for(const stop of stops){
    for(let i=start;i+stride<stop;i+=stride){
      const pv=i===start?i:i-stride;
      const next=i+2*stride<stop?i+2*stride:i+stride;
      data[offset++]=flat[pv];data[offset++]=flat[pv+1];
      data[offset++]=flat[i];data[offset++]=flat[i+1];
      data[offset++]=flat[i+stride];data[offset++]=flat[i+stride+1];
      data[offset++]=flat[next];data[offset++]=flat[next+1];
    }
    start=stop;
  }
  return {instanceData:data,instanceCount:total,gpuJoin:true};
}


/** Optional single-coordinate-pass GPU Join packer. The original writes a
 * degenerate check pass and a second payload pass. This variant computes only
 * segment capacity from `ends` then checks each segment WHILE writing its
 * 8 floats. Bad/degenerate features return null for the same CPU fallback.
 * It preserves every normal-path Float32 output byte and path end boundary.
 */
export function packRenderFeatureGpuJoinNeighborsFused(flat,ends=null,stride=2,rangeStart=0,rangeEnd=flat.length){
  if(!flat || !Number.isInteger(stride) || stride<2)throw new Error('Invalid flat coordinates/stride');
  if(!Number.isInteger(rangeStart)||!Number.isInteger(rangeEnd)||rangeStart<0||rangeEnd>flat.length||rangeStart>rangeEnd)throw new Error('Invalid flat coordinate range');
  const stops=ends?.length?ends:[rangeEnd];
  let previous=rangeStart,total=0;
  for(const stop of stops){
    if(!Number.isInteger(stop)||stop<previous||stop>rangeEnd||(stop-previous)%stride!==0)
      throw new Error('Invalid RenderFeature line ends');
    total+=Math.max(0,(stop-previous)/stride-1);previous=stop;
  }
  if(previous!==rangeEnd)throw new Error('RenderFeature line ends do not cover coordinates');
  const data=new Float32Array(total*8);
  let offset=0,start=rangeStart;
  for(const stop of stops){
    for(let i=start;i+stride<stop;i+=stride){
      if(Math.fround(flat[i])===Math.fround(flat[i+stride])&&
         Math.fround(flat[i+1])===Math.fround(flat[i+stride+1]))return null;
      const pv=i===start?i:i-stride;
      const next=i+2*stride<stop?i+2*stride:i+stride;
      data[offset++]=flat[pv];data[offset++]=flat[pv+1];
      data[offset++]=flat[i];data[offset++]=flat[i+1];
      data[offset++]=flat[i+stride];data[offset++]=flat[i+stride+1];
      data[offset++]=flat[next];data[offset++]=flat[next+1];
    }
    start=stop;
  }
  return {instanceData:data,instanceCount:total,gpuJoin:true};
}

/** WebGL1 direct-coordinate drawing: retain RenderFeature's original flat
 * buffer/ends; no per-segment Float32Array or intermediate path objects.
 * A joined GPU stream copies each source XY *once per vertex* (plus one guard
 * coordinate at each geometry boundary) and writes one flag float/vertex.
 * If repeated adjacent f32 positions would change GPU join semantics, return
 * null so the legacy precise CPU writer is used instead.
 */
export function referenceRenderFeatureFlatLine(flat,ends=null,stride=2,rangeStart=0,rangeEnd=flat?.length??0){
  if(!flat||!Number.isInteger(stride)||stride<2||rangeStart<0||rangeEnd>flat.length||rangeStart>rangeEnd||(rangeEnd-rangeStart)%stride)throw Error('Invalid flat coordinates/stride/range');
  const stops=ends?.length?ends:[rangeEnd];
  let last=rangeStart, paths=0;
  for(const stop of stops){
    if(!Number.isInteger(stop)||stop<last||stop>rangeEnd||(stop-last)%stride)throw Error('Invalid RenderFeature line ends');
    for(let i=last;i<stop;i+=stride){
      if(!Number.isFinite(Math.fround(flat[i]))||!Number.isFinite(Math.fround(flat[i+1])))return null;
      if(i>last&&Math.fround(flat[i])===Math.fround(flat[i-stride])&&Math.fround(flat[i+1])===Math.fround(flat[i-stride+1]))return null;
    }
    last=stop;paths++;
  }
  if(last!==rangeEnd)throw Error('RenderFeature line ends do not cover coordinates');
  const pointCount=(rangeEnd-rangeStart)/stride;
  return {flatGpu:true,gpuJoin:true,flatCoordinates:flat,flatEnds:ends,flatStart:rangeStart,flatEnd:rangeEnd,flatStride:stride,
    flatPointCount:pointCount,flatPathCount:paths,instanceCount:Math.max(0,pointCount-1)};
}

/** Sliding WebGL1 vertex window over the raw XY sequence. [x,y,flags] is
 * packed ONCE per coordinate. Bit 1=start, bit 2=end of path. Only one guard
 * at the start and end of the WHOLE style group (not every feature). The
 * virtual boundary instance between consecutive features is clipped in GLSL.
 * Each reference slice starts at its first raw vertex minus one, and spans
 * (pointCount-1) instances; merged slices cross exactly ONE virtual segment.
 */
export function packFlatLineVertexGroup(parts){
  const points=parts.reduce((n,g)=>n+g.flatPointCount,0);
  if(!points)throw Error('Cannot pack empty flat group');
  const vertexCount=points+2;
  const result=new Float32Array(vertexCount*3);let vertex=0,actualSegments=0;
  const push=(x,y,flags)=>{const o=vertex++*3;result[o]=x;result[o+1]=y;result[o+2]=flags;};
  const first=parts[0];
  push(first.flatCoordinates[first.flatStart],first.flatCoordinates[first.flatStart+1],3);
  for(const g of parts){
    const f=g.flatCoordinates,st=g.flatStride,from=g.flatStart,to=g.flatEnd;
    if(!g.flatPointCount)throw Error('Cannot pack empty flat path');
    let start=from;
    const ends=g.flatEnds?.length?g.flatEnds:[to];
    for(const end of ends){
      for(let i=start;i<end;i+=st){
        const first=i===start,last=i+st===end;
        push(f[i],f[i+1],(first?1:0)|(last?2:0));
      }
      actualSegments+=Math.max(0,(end-start)/st-1);
      start=end;
    }
    if(start!==to)throw Error('Uncovered flat geometry');
  }
  const last=parts[parts.length-1];
  push(last.flatCoordinates[last.flatEnd-last.flatStride],last.flatCoordinates[last.flatEnd-last.flatStride+1],3);
  return {data:result,vertexCount,instanceCount:vertexCount-3,actualSegments};
}

/** Prefer GPU neighbor instances for dense short paths: ANGLE instancing
 * cannot skip interior virtual gaps in WebGL1 without issuing a draw/path.
 * With few paths relative to real segments, raw vertices still save bytes
 * with limited extra GPU work. The threshold is conservative and OPT-IN.
 */
export function preferFlatLineVertexWindow(g,{maxVirtualSegmentRatio=0.125}={}){
  if(!g?.flatGpu||g.instanceCount<=0)return false;
  return g.flatPathCount/g.instanceCount<=maxVirtualSegmentRatio;
}

/**
 * OL disable-worker inspired M5 input descriptor. Unlike the legacy packer,
 * retains the original RenderFeature coordinate/ends buffers; no per-feature
 * segment Float32Array. Only valid, finite, nondegenerate GPU Join lines use
 * this opt-in representation. The exact shader contract is unchanged.
 */
export function referenceRenderFeatureGpuJoinDirect(flat,ends=null,stride=2,rangeStart=0,rangeEnd=flat?.length??0){
  if(!flat||!Number.isInteger(stride)||stride<2||!Number.isInteger(rangeStart)||!Number.isInteger(rangeEnd)||rangeStart<0||rangeEnd>flat.length||rangeStart>rangeEnd)return null;
  const stops=ends?.length?ends:[rangeEnd];
  let start=rangeStart,total=0;
  for(const end of stops){
    if(!Number.isInteger(end)||end<start||end>rangeEnd||(end-start)%stride)return null;
    for(let i=start;i<end;i+=stride){
      if(!Number.isFinite(Math.fround(flat[i]))||!Number.isFinite(Math.fround(flat[i+1])))return null;
      if(i>start&&Math.fround(flat[i])===Math.fround(flat[i-stride])&&Math.fround(flat[i+1])===Math.fround(flat[i-stride+1]))return null;
    }
    total+=Math.max(0,(end-start)/stride-1);
    start=end;
  }
  if(start!==rangeEnd)return null;
  return {directGpuJoin:true,gpuJoin:true,flatCoordinates:flat,flatEnds:ends,
    flatStart:rangeStart,flatEnd:rangeEnd,flatStride:stride,instanceCount:total};
}

/** Write a *single* virtual path straight into the final ordered group arena.
 * No join trigonometry, temporary segment storage or per-path Float32Array.
 * destOffset is in FLOATS and the returned value is the new float offset.
 */
export function writeDirectGpuJoinPath(target,destOffset,raw,pointStart,pointCount){
  if(raw?.directGpuJoin!==true)throw Error('Expected direct GPU Join descriptor');
  const f=raw.flatCoordinates,st=raw.flatStride,start=raw.flatStart+pointStart*st,end=start+pointCount*st;
  if(start<raw.flatStart||end>raw.flatEnd||pointCount<0||!Number.isInteger(pointStart)||!Number.isInteger(pointCount))throw Error('Invalid direct GPU Join span');
  // Slide a four-vertex window across the source flat coordinates. The
  // previous implementation re-read up to eight source scalars for every
  // segment. This reads the first two vertices once, then only the next
  // vertex for each segment, writing the same GPU shader attribute contract.
  // No temporary Float32Array, path object or transform is introduced.
  let o=destOffset;
  if(pointCount<2)return o;
  let px=f[start],py=f[start+1],x=px,y=py;
  let nx=f[start+st],ny=f[start+st+1];
  for(let i=start;i+st<end;i+=st){
    const nn=i+2*st<end?i+2*st:i+st;
    const nnx=f[nn],nny=f[nn+1];
    target[o++]=px;target[o++]=py;
    target[o++]=x;target[o++]=y;
    target[o++]=nx;target[o++]=ny;
    target[o++]=nnx;target[o++]=nny;
    px=x;py=y;x=nx;y=ny;nx=nnx;ny=nny;
  }
  return o;
}

/** Write MVT XY neighbors straight into a tile's final GPU-join stream.
 * No per-feature Instance TypedArray is allocated. Returns null on repeated
 * Float32 XY, preserving the legacy CPU-join fallback behavior. */
export function appendRenderFeatureGpuJoinNeighborsDirect(flat,ends,stride,writer,rangeStart=0,rangeEnd=flat.length,closedLineJoins=false){
  if(!flat||!Number.isInteger(stride)||stride<2||!Number.isInteger(rangeStart)||!Number.isInteger(rangeEnd)||rangeStart<0||rangeEnd>flat.length||rangeStart>rangeEnd)throw Error('Invalid flat coordinates/stride/range');
  const stops=ends?.length?ends:[rangeEnd];
  let previous=rangeStart,total=0;
  // Inspect only ends here. Adjacent-coordinate validation is fused into the
  // output pass instead of walking the whole feature a second time.
  for(const stop of stops){
    if(!Number.isInteger(stop)||stop<previous||stop>rangeEnd||(stop-previous)%stride)throw Error('Invalid RenderFeature line ends');
    total+=Math.max(0,(stop-previous)/stride-1);previous=stop;
  }
  if(previous!==rangeEnd)throw Error('RenderFeature line ends do not cover coordinates');
  const rollback=writer.length;
  writer.ensure(total*8);
  let start=rangeStart;
  try{
    for(const stop of stops){
      if(start+stride<stop){
        // A closed LineString must join its last segment to its first. The
        // duplicate first/last coordinate is a ring closure, not two caps.
        // Only accept exact source closure with >=3 distinct vertices. Keep
        // the legacy behavior opt-in for comparison against prior captures.
        const closed=closedLineJoins && stop-start>=8*stride/2 &&
          flat[start]===flat[stop-stride] && flat[start+1]===flat[stop-stride+1];
        // A four-point sliding window reads each new XY pair once rather
        // than re-reading the same endpoints/neighbors for every segment.
        // Degenerate validation is still fused with the final buffer write.
        let px=flat[closed?stop-2*stride:start],py=flat[(closed?stop-2*stride:start)+1],x=flat[start],y=flat[start+1];
        let nextX=flat[start+stride],nextY=flat[start+stride+1];
        for(let i=start;i+stride<stop;i+=stride){
          if(Math.fround(x)===Math.fround(nextX)&&Math.fround(y)===Math.fround(nextY)){
            writer.truncate(rollback);
            return null;
          }
          const nn=i+2*stride<stop?i+2*stride:(closed?start+stride:i+stride);
          const nnx=flat[nn],nny=flat[nn+1];
          writer.push8(px,py,x,y,nextX,nextY,nnx,nny);
          px=x;py=y;x=nextX;y=nextY;nextX=nnx;nextY=nny;
        }
      }
      start=stop;
    }
  }catch(error){
    writer.truncate(rollback);
    throw error;
  }
  return {instanceCount:total,gpuJoin:true};
}
