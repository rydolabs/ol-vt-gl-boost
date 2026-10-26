/**
 * Experimental direct MVT RenderFeature -> GPU-ready buffers -> WebGL route.
 * This deliberately does NOT construct NeutralGeometry, GeometryStore,
 * RenderReferences or RendererKernel DrawStreams. Each tile has immutable GPU
 * buffers and an ordered array of lightweight draw packets.
 *
 * Supported: Point/MultiPoint, LineString/MultiLineString (M5 CPU-join line
 * contract), Polygon/MultiPolygon (OL winding + Earcut, M5 clip fallback).
 * Unsupported style effects explicitly reject instead of silently rendering
 * different pixels. This implementation is opt-in, not the default renderer.
 */
import {toNeutralStyles,toRendererStyle} from '../ol/OlStyleAdapter.js';
import {olPolygonRangesWithBounds} from '../ol/PolygonRingGrouping.js';
import {appendFlatPolygonIndexedDirect,materializeFlatPolygonRings} from '../tile/DirectFeaturePolygonBuffers.js';
import {validClipExtent,clipPolylineToExtent,forEachClippedTriangle} from '../tile/clip.js';
import {EarcutPolygonTriangulator} from '../tile/EarcutPolygonTriangulator.js';
import {triangulateSimpleRing} from '../tile/NeutralGeometryCompiler.js';
import {triangulateEarcutFlat,triangulateSimpleFlat} from '../tile/DirectFeatureFlatTriangulation.js';
import {packRenderFeatureLineInstances,appendRenderFeatureGpuJoinNeighborsDirect} from '../tile/RenderFeatureLinePacker.js';
import {lineVertexShader,lineGpuJoinVertexShader,lineFragmentShader} from './shaders.js';
import {LineRenderer} from './LineRenderer.js';

// Reuse the existing M4 WebGL1 simple shader instead of a parallel shader.
import {M4_SIMPLE_VERTEX_SHADER,M4_SIMPLE_FRAGMENT_SHADER} from '../compat/renderers.js';
const DEFAULT_MATRIX=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const emptyStyle=Object.freeze([]);
const clipper=new EarcutPolygonTriangulator();
const get=(f,name,method)=>typeof f?.[method]==='function'?f[method]():f?.[name];
function withOpacity(style,alpha){if(alpha===1)return style;return {...style,fill:style.fill?{...style.fill,color:style.fill.color?.map((x,i)=>i===3?x*alpha:x)}:null,stroke:style.stroke?{...style.stroke,color:style.stroke.color?.map((x,i)=>i===3?x*alpha:x)}:null};}
function unsupportedEffect(style){return !!(style?.point?.kind==='icon'||style?.text||style?.stroke?.patternSrc||style?.stroke?.dash?.length||style?.stroke?.offset||style?.stroke?.dashOffset);}
function asFlat(path){const coords=new Float64Array(path.length*2);for(let i=0;i<path.length;i++){coords[2*i]=path[i][0];coords[2*i+1]=path[i][1];}return coords;}
function ensureRange(flat,ends,stride){if(!flat||!Number.isInteger(stride)||stride<2||flat.length%stride)throw Error('Invalid Feature coordinates');let last=0;for(const end of ends){if(!Number.isInteger(end)||end<=last||end>flat.length||(end-last)%stride)throw Error('Invalid MVT ends');last=end;}if(ends.length&&last!==flat.length)throw Error('Incomplete MVT ends');}

/** Growable FINAL GPU streams. subarray() exposes the populated region with
 * zero finalization copy; any growth copies the existing tile stream once.
 * This replaces feature-chunk allocations and the end-of-tile merge pass. */
class FloatStreamWriter{
  constructor(initial=1024){this.data=new Float32Array(initial);this.length=0;this.growthCopies=0;}
  ensure(extra){const needed=this.length+extra;if(needed<=this.data.length)return;
    const next=new Float32Array(Math.max(needed,Math.max(16,this.data.length*2)));
    next.set(this.data.subarray(0,this.length));this.growthCopies+=this.length*4;this.data=next;
  }
  push2(a,b){this.ensure(2);this.push2Reserved(a,b);}
  // Caller has reserved capacity for the entire ring/part.
  push2Reserved(a,b){this.data[this.length++]=a;this.data[this.length++]=b;}
  push8(a,b,c,d,e,f,g,h){this.ensure(8);const v=this.data;let n=this.length;
    v[n++]=a;v[n++]=b;v[n++]=c;v[n++]=d;v[n++]=e;v[n++]=f;v[n++]=g;v[n++]=h;this.length=n;}
  push8Reserved(a,b,c,d,e,f,g,h){const v=this.data;let n=this.length;
    v[n++]=a;v[n++]=b;v[n++]=c;v[n++]=d;v[n++]=e;v[n++]=f;v[n++]=g;v[n++]=h;this.length=n;}
  append(data){this.ensure(data.length);this.data.set(data,this.length);this.length+=data.length;}
  truncate(length){this.length=length;}
  view(){return this.data.subarray(0,this.length);}
}
class IndexStreamWriter{
  constructor(initial=1024){this.data=new Uint16Array(initial);this.length=0;this.growthCopies=0;}
  upgrade(){if(this.data instanceof Uint32Array)return;
    const out=new Uint32Array(this.data.length);out.set(this.data.subarray(0,this.length));this.growthCopies+=this.length*2;this.data=out;}
  ensure(extra){const needed=this.length+extra;if(needed<=this.data.length)return;
    const out=new this.data.constructor(Math.max(needed,Math.max(16,this.data.length*2)));
    out.set(this.data.subarray(0,this.length));this.growthCopies+=this.length*this.data.BYTES_PER_ELEMENT;this.data=out;
  }
  push(value){if(value>65535)this.upgrade();this.ensure(1);this.data[this.length++]=value;}
  appendTriangle(offset){
    if(offset+2>65535 && !(this.data instanceof Uint32Array))this.upgrade();
    this.ensure(3);const i=this.length,d=this.data;
    d[i]=offset;d[i+1]=offset+1;d[i+2]=offset+2;this.length=i+3;
  }
  appendOffset(source,offset,knownMaxIndex=null){
    if(!source.length)return;
    // Earcut indices are bounded by the polygon's retained vertex count.
    // Skip a second index scan when the entire possible index range fits 16 bits.
    // Fall back to the historical scan near the boundary to preserve index type.
    if(!(this.data instanceof Uint32Array) &&
       !(knownMaxIndex!==null && offset+knownMaxIndex<=65535)){
      for(let i=0;i<source.length;i++)if(offset+source[i]>65535){this.upgrade();break;}
    }
    this.ensure(source.length);let position=this.length;const data=this.data;
    for(let i=0;i<source.length;i++)data[position++]=offset+source[i];
    this.length=position;
  }
  view(){return this.data.subarray(0,this.length);}
}

/** Cheap header-only capacity hint: read coordinate ARRAY LENGTHS, not XY values.
 * The encoder remains a single coordinate-processing pass. A larger mesh from
 * clipping falls back to geometric growth without losing any vertex. */
function estimateTileCapacity(features,{clipped=false}={}){
  if(!Array.isArray(features))return {vertices:1024,indices:1024,lines:1024,polygonStrokeFloats:0};
  let vertices=0,indices=0,lines=0,polygonStrokeFloats=0,polygonVertices=0;
  for(const entry of features){
    const f=entry?.__olDisableWorkerEntry===true?entry.feature:entry;
    const kind=get(f,'type','getType'),flat=get(f,'flatCoordinates','getFlatCoordinates');
    if(!flat)continue;
    const stride=Number(get(f,'stride','getStride')||2),count=Math.ceil(flat.length/stride);
    if(kind==='Polygon'||kind==='MultiPolygon'){
      vertices+=count*2;polygonVertices+=count*2;indices+=count*3;
      // A ring of N points produces at most about N line segments when inside.
      // Clipped paths may exceed this conservative estimate; growth stays safe.
      polygonStrokeFloats+=count*8;
    }else if(kind==='LineString'||kind==='MultiLineString'){
      const ends=get(f,'ends','getEnds');
      lines+=Math.max(0,count-(ends?.length||1))*8;
    }else if(kind==='Point'||kind==='MultiPoint'){
      vertices+=count*2;indices+=count;
    }
  }
  // Clipped polygons can create boundary vertices that are not present in the
  // MVT source. Reserve 50% headroom only for polygons when clipping is on;
  // the growth fallback handles pathological cases without losing data.
  if(clipped)vertices+=Math.ceil(polygonVertices*0.5);
  return {vertices:Math.max(16,vertices),indices:Math.max(16,indices),
    lines:Math.max(16,lines),polygonStrokeFloats};
}

/** A single-pass, tile-scoped CPU encoder; references are only draw metadata. */
export function encodeDirectFeatureTile(features,{styleFor=()=>null,clipExtent=null,layerProperty='layer',opacity=1,styleMode='parts',batchDraws=true,drawMode='painter',polygonInsideSegmentFastPath=true,polygonEarBBoxPrecheck=true,polygonFlatTriangulation=true,lineDirectRange=true,stableStyleIdentityCache=false,polygonStrokeFringePx=0,closedLineJoins=false}={}){
  // Write straight to final GPU-ready streams instead of feature chunks.
  const hint=estimateTileCapacity(features,{clipped:clipExtent!==null});
  const verticesWriter=new FloatStreamWriter(hint.vertices),indicesWriter=new IndexStreamWriter(hint.indices),lineWriter=new FloatStreamWriter(hint.lines);
  // In style-pass mode, write *draw ranges* directly while emitting geometry.
  // Each lane represents one contiguous GPU stream+shader/style; no Part packets
  // are allocated and no Part packet sort/merge pass is needed. The mode is
  // experimental because Fill-all -> Stroke-all may differ from painter order.
  if(drawMode!=='painter'&&drawMode!=='style-pass')throw Error('Unsupported Direct draw mode');
  const passBatches=drawMode==='style-pass'?new Map():null;
  const packets=[];
  let emittedRanges=0,originalPacketCount=0;
  let passOrder=0,strokeCapacityReserved=false;
  const counters={features:0,parts:0,polygons:0,inside:0,outside:0,partial:0,points:0,lineSegments:0,geometryStores:0,virtualReferences:0};
  const appendLine=(flat,ends,stride,rangeStart=0,rangeEnd=flat.length)=>{
    const first=lineWriter.length/8;
    const gpu=null; // R48 strict-OL candidate: use existing CPU line-join encoder
    if(!gpu){
      // The legacy CPU-join fallback needs a self-contained part. Create it
      // only when float32-degenerate neighbors were found.
      const own=rangeStart===0&&rangeEnd===flat.length?flat:
        (flat.subarray?flat.subarray(rangeStart,rangeEnd):flat.slice(rangeStart,rangeEnd));
      const line=packRenderFeatureLineInstances(own,ends,stride,0,own.length,closedLineJoins);
      lineWriter.append(line.instanceData);
      counters.lineSegments+=line.instanceCount;
      return {first,count:line.instanceCount,gpuJoin:false};
    }
    counters.lineSegments+=gpu.instanceCount;
    return {first,count:gpu.instanceCount,gpuJoin:true};
  };
  // Clip partial triangles into FINAL VBO/EBO, eliminating the expanded
  // JS triangle output array and its additional Float32Array copy.
  const appendClippedMesh=(mesh,extent)=>{
    const indexStart=indicesWriter.length;
    // R30 experimental GPU scissor fill. Tile scissor still enabled in renderer.
    if(globalThis.__m5R30ScissorFill===true && validClipExtent(extent)){
      const x0=extent[0],y0=extent[1],x1=extent[2],y1=extent[3];
      for(let i=0;i+5<mesh.length;i+=6){
        const ax=mesh[i],ay=mesh[i+1],bx=mesh[i+2],by=mesh[i+3],cx=mesh[i+4],cy=mesh[i+5];
        if(Math.max(ax,bx,cx)<x0||Math.min(ax,bx,cx)>x1||
           Math.max(ay,by,cy)<y0||Math.min(ay,by,cy)>y1)continue;
        const offset=verticesWriter.length/2;
        verticesWriter.ensure(6);
        verticesWriter.push2Reserved(ax,ay);
        verticesWriter.push2Reserved(bx,by);
        verticesWriter.push2Reserved(cx,cy);
        indicesWriter.appendTriangle(offset);
      }
      return {indexStart,count:indicesWriter.length-indexStart};
    }

    // Exact legacy triangle ordering is preserved; every emitted vertex is
    // rounded by the Float32 writer at the same point as the legacy output.
    forEachClippedTriangle(mesh,extent,(ax,ay,bx,by,cx,cy)=>{
      const offset=verticesWriter.length/2;
      verticesWriter.ensure(6);verticesWriter.push2Reserved(ax,ay);
      verticesWriter.push2Reserved(bx,by);verticesWriter.push2Reserved(cx,cy);
      indicesWriter.appendTriangle(offset);
    });
    return {indexStart,count:indicesWriter.length-indexStart};
  };
  /** Clip source-ring segments directly to the final GPU Join writer. The
   * old Liang-Barsky operation order and flush boundaries are preserved, but
   * no [x,y] rings, clipped-path objects or per-path Float64Array are created.
   * Float32-degenerate segments trigger an exact legacy fallback for the ring. */
  const appendFlatClippedStrokeRing=(flat,start,end,stride,extent)=>{
    const rawCount=(end-start)/stride;
    if(rawCount<2)return [];
    const firstX=Number(flat[start]),firstY=Number(flat[start+1]);
    const lastX=Number(flat[end-stride]),lastY=Number(flat[end-stride+1]);
    const count=rawCount+((firstX===lastX&&firstY===lastY)?0:1);
    const hasBounds=validClipExtent(extent),rollback=lineWriter.length;
    // Without a valid extent the historical path preserves every input point
    // (including duplicate vertices). Keep that exact exceptional contract.
    if(!hasBounds)return null;
    const ranges=[];
    let runCount=0,rx0=0,ry0=0,rx1=0,ry1=0,rxPrev=0,ryPrev=0,lastPX=0,lastPY=0;
    let bad=false;
    const emitSegment=(px,py,ax,ay,bx,by,nx,ny)=>{
      if(Math.fround(ax)===Math.fround(bx)&&Math.fround(ay)===Math.fround(by)){
        bad=true;return;
      }
      lineWriter.push8(px,py,ax,ay,bx,by,nx,ny);
    };
    const addPoint=(x,y)=>{
      if(runCount===0){rx0=x;ry0=y;lastPX=x;lastPY=y;runCount=1;return;}
      if(x===lastPX&&y===lastPY)return;
      if(runCount===1){rx1=x;ry1=y;lastPX=x;lastPY=y;runCount=2;return;}
      emitSegment(runCount===2?rx0:rxPrev,runCount===2?ry0:ryPrev,rx0,ry0,rx1,ry1,x,y);
      // The first segment's previous point is its own start, including when x=0.
      rxPrev=rx0;ryPrev=ry0;rx0=rx1;ry0=ry1;rx1=x;ry1=y;
      lastPX=x;lastPY=y;runCount++;
    };
    const flush=()=>{
      if(runCount>=2){
        const first=lineWriter.length/8-(runCount-2);
        emitSegment(runCount===2?rx0:rxPrev,runCount===2?ry0:ryPrev,rx0,ry0,rx1,ry1,rx1,ry1);
        const written=runCount-1;
        if(!bad){ranges.push({first,count:written,gpuJoin:true});counters.lineSegments+=written;}
      }
      runCount=0;
    };
    const coord=(i,axis)=>Number(flat[(i===rawCount?start:start+i*stride)+axis]);
    for(let i=1;i<count;i++){
      if(bad)break;
      const ax=coord(i-1,0),ay=coord(i-1,1),bx=coord(i,0),by=coord(i,1);
      const dx=bx-ax,dy=by-ay;
      if(dx===0&&dy===0)continue;
      let t0=0,t1=1,visible=true;
      // No Liang-Barsky division is needed if BOTH segment endpoints are
      // finite and already inside. t0/t1 remain exactly 0/1, so interpolation,
      // joins, path flush boundaries and final Float32 rounding are unchanged.
      // Use source doubles (not the Float32 BBox) for this proof: values just
      // outside an edge can round onto the border after Math.fround().
      const fullyInside=polygonInsideSegmentFastPath &&
        Number.isFinite(ax)&&Number.isFinite(ay)&&Number.isFinite(bx)&&Number.isFinite(by)&&
        ax>=extent[0]&&ax<=extent[2]&&bx>=extent[0]&&bx<=extent[2]&&
        ay>=extent[1]&&ay<=extent[3]&&by>=extent[1]&&by<=extent[3];
      if(hasBounds&&!fullyInside){
        for(let edge=0;edge<4;edge++){
          const q=edge===0?ax-extent[0]:edge===1?extent[2]-ax:edge===2?ay-extent[1]:extent[3]-ay;
          const p=edge===0?-dx:edge===1?dx:edge===2?-dy:dy;
          if(p===0){if(q<0){visible=false;break;}continue;}
          const t=q/p;
          if(p<0)t0=Math.max(t0,t);else t1=Math.min(t1,t);
          if(t0>t1){visible=false;break;}
        }
      }
      if(!visible||t1-t0<=1e-12){flush();continue;}
      const sx=ax+t0*dx,sy=ay+t0*dy,ex=ax+t1*dx,ey=ay+t1*dy;
      if(runCount && !(lastPX===sx&&lastPY===sy))flush();
      if(!runCount)addPoint(sx,sy);
      addPoint(ex,ey);
      if(t1<1)flush();
    }
    if(!bad)flush();
    if(bad){lineWriter.truncate(rollback);counters.lineSegments-=ranges.reduce((n,r)=>n+r.count,0);return null;}
    return ranges;
  };
  // Stroke Clip returns point pairs; write directly into M5 GPU Join attrs
  // instead of allocating another flat-coordinate array for normal paths.
  const appendStrokePath=(path)=>{
    const count=path.length,instances=Math.max(0,count-1);
    const first=lineWriter.length/8,rollback=lineWriter.length;
    lineWriter.ensure(instances*8);
    // The degenerate check now runs as the GPU stream is written. Roll back
    // the stream before using the exact legacy CPU-join fallback.
    try{
      for(let i=0;i<instances;i++){
        const a=path[i],b=path[i+1];
        if(Math.fround(a[0])===Math.fround(b[0])&&Math.fround(a[1])===Math.fround(b[1])){
          lineWriter.truncate(rollback);
          return appendLine(asFlat(path),null,2);
        }
        const closed=globalThis.__m5R18ClosedRingJoin===true && count>=4 && path[0] && path[count-1] &&
          path[0][0]===path[count-1][0] && path[0][1]===path[count-1][1];
        const prev=path[i?i-1:(closed?count-2:0)],next=path[i+2<count?i+2:(closed?1:i+1)];
        lineWriter.push8Reserved(prev[0],prev[1],a[0],a[1],b[0],b[1],next[0],next[1]);
      }
    }catch(error){lineWriter.truncate(rollback);throw error;}
    counters.lineSegments+=instances;
    return {first,count:instances,gpuJoin:true};
  };
  // Opt-in: read polygon stroke rings directly from flat feature coordinates.
  // Float32-degenerate segments fall back to original materialized CPU path.
  const appendUnclippedFlatStrokeRing=(flat,start,end,stride)=>{
    if(globalThis.__m5R30FastStrokeRing===true){
      const n=(end-start)/stride;
      if(n<2)return null;
      const sx=Number(flat[start]),sy=Number(flat[start+1]);
      const endIndex=end-stride;
      const closed=sx===Number(flat[endIndex])&&sy===Number(flat[endIndex+1]);
      const count=n+(closed?0:1),instances=count-1;
      const joinClosed=globalThis.__m5R18ClosedRingJoin===true&&closed&&count>=4;
      const first=lineWriter.length/8,rollback=lineWriter.length;
      lineWriter.ensure(instances*8);
      const target=lineWriter.data;
      let targetOffset=rollback;
      for(let i=0,at=start;i<instances;i++,at+=stride){
        const offsetB=i+1===n?start:at+stride;
        const ax=Number(flat[at]),ay=Number(flat[at+1]);
        const bx=Number(flat[offsetB]),by=Number(flat[offsetB+1]);
        if(Math.fround(ax)===Math.fround(bx)&&Math.fround(ay)===Math.fround(by)){
          lineWriter.truncate(rollback);return null;
        }
        const offPrev=i?at-stride:(joinClosed?start+(count-2)*stride:start);
        const offNext=i+2<count?(i+2===n?start:start+(i+2)*stride):(joinClosed?start+stride:offsetB);
        target[targetOffset++]=flat[offPrev];target[targetOffset++]=flat[offPrev+1];
        target[targetOffset++]=ax;target[targetOffset++]=ay;
        target[targetOffset++]=bx;target[targetOffset++]=by;
        target[targetOffset++]=flat[offNext];target[targetOffset++]=flat[offNext+1];
      }
      lineWriter.length=targetOffset;
      counters.lineSegments+=instances;
      return [{first,count:instances,gpuJoin:true}];
    }

    const sourceCount=(end-start)/stride;
    if(sourceCount<2)return null;
    const firstX=Number(flat[start]),firstY=Number(flat[start+1]);
    const lastX=Number(flat[end-stride]),lastY=Number(flat[end-stride+1]);
    const closed=firstX===lastX&&firstY===lastY;
    const count=sourceCount+(closed?0:1),instances=count-1;
    const readX=i=>Number(flat[(i===sourceCount?start:start+i*stride)]);
    const readY=i=>Number(flat[(i===sourceCount?start+1:start+i*stride+1)]);
    const first=lineWriter.length/8,rollback=lineWriter.length;
    lineWriter.ensure(instances*8);
    for(let i=0;i<instances;i++){
      const ax=readX(i),ay=readY(i),bx=readX(i+1),by=readY(i+1);
      if(Math.fround(ax)===Math.fround(bx)&&Math.fround(ay)===Math.fround(by)){
        lineWriter.truncate(rollback);return null;
      }
      const joinClosed=globalThis.__m5R18ClosedRingJoin===true&&closed&&count>=4;
      const prev=i?i-1:(joinClosed?count-2:0),next=i+2<count?i+2:(joinClosed?1:i+1);
      lineWriter.push8Reserved(readX(prev),readY(prev),ax,ay,bx,by,readX(next),readY(next));
    }
    counters.lineSegments+=instances;
    return [{first,count:instances,gpuJoin:true}];
  };
  // Styles are normalized once for each feature; their neutral objects are
  // stable through this tile encode. A polygon ring or multipart line can emit
  // thousands of ranges using the SAME style, so converting it and building
  // JSON batch keys for every range is wasted work. Cache only within this
  // encode call: opacity, pass order and style cannot go stale across tiles.
  const renderedStyleCache=new WeakMap();
  // Opt-in only: reusing a mutable OL Style identity across features is unsafe
  // if a style function mutates that object. The caller promises stable values.
  const neutralByRawStyle=stableStyleIdentityCache?new WeakMap():null;
  // logicalCount lets the single-style Line fast path coalesce consecutive
  // Parts without materializing intermediate Packet objects. The original
  // emission order remains stable (including later cross-feature packets).
  const addPacket=(type,range,neutral,logicalCount=1)=>{
    if(!range?.count)return;
    const originalOrder=originalPacketCount;
    originalPacketCount+=logicalCount;
    emittedRanges+=logicalCount;
    let perStyle=renderedStyleCache.get(neutral);
    if(!perStyle){perStyle=new Map();renderedStyleCache.set(neutral,perStyle);}
    // gpuJoin changes the batch identity but not the converted rendering
    // style. Keep passOrder in the key because one tile may contain several
    // OL style passes even when the neutral style object is shared.
    const identity=type+'|'+(range.gpuJoin===true?'1':'0')+'|'+passOrder;
    let prepared=perStyle.get(identity);
    if(!prepared){
      const style=toRendererStyle(withOpacity(neutral,opacity),type==='line'?'line':type);
      const styleKey=JSON.stringify(style),zIndex=Number(neutral.zIndex??0);
      prepared={style,styleKey,zIndex,
        laneKey:passBatches?JSON.stringify([passOrder,zIndex,type,range.gpuJoin===true,styleKey]):null};
      perStyle.set(identity,prepared);
    }
    const {style,styleKey,zIndex}=prepared;
    if(passBatches){
      // Directly extend a contiguous render pass range, instead of allocating
      // one packet per Polygon Part. Separate lanes use separate GPU buffers.
      const key=prepared.laneKey;
      let lane=passBatches.get(key);
      if(!lane){lane={passOrder,zIndex,type,order:passBatches.size,batches:[]};passBatches.set(key,lane);}
      const last=lane.batches.at(-1);
      const contiguous=last&&(type==='line'?last.first+last.count===range.first:last.indexStart+last.count===range.indexStart);
      if(contiguous)last.count+=range.count;
      else lane.batches.push({...range,type,style,styleKey,zIndex,passOrder,order:originalOrder});
    }else packets.push({...range,type,style,styleKey,zIndex,passOrder,order:originalOrder});
  };
  for(const featureEntry of features||[]){
    const styledEntry=featureEntry?.__olDisableWorkerEntry===true;
    const feature=styledEntry?featureEntry.feature:featureEntry;
    passOrder=styledEntry?featureEntry.passOrder:0;
    const kind=get(feature,'type','getType');const flat=get(feature,'flatCoordinates','getFlatCoordinates');
    const ends=get(feature,'ends','getEnds')||emptyStyle;const stride=Number(get(feature,'stride','getStride')||2);
    ensureRange(flat,ends,stride);
    const properties=get(feature,'properties','getProperties')||{};
    const layer=properties[layerProperty]??properties.layer??null;
    const rawStyle=styledEntry?featureEntry.style:styleFor(feature,layer);
    // The OL FlatStyle normalizer omits unsupported text properties. Reject
    // them explicitly: silently dropping labels would corrupt pixel parity.
    // Stable source-layer Line FlatStyles often apply to hundreds of features.
    // Normalize once, then reuse the same neutral Style and addPacket key per
    // tile. Feature-specific style functions must be resolved on every feature;
    // a returned mutable object is safe to reuse only with this explicit opt-in.
    const cacheKey=neutralByRawStyle&&(kind==='LineString'||kind==='MultiLineString')&&rawStyle&&typeof rawStyle==='object'?rawStyle:null;
    let styles=cacheKey?neutralByRawStyle.get(cacheKey):null;
    if(!styles){
      const rawList=Array.isArray(rawStyle)?rawStyle:[rawStyle];
      for(const raw of rawList){
        if(raw&&typeof raw==='object'&&Object.keys(raw).some(key=>
            /^(?:text-|fill-pattern-|icon-)/.test(key)))
          throw Error('Direct pipeline cannot render text, fill patterns or icons exactly; use legacy path');
      }
      styles=toNeutralStyles(rawStyle,{feature});
      if(styles.some(unsupportedEffect))throw Error('Direct pipeline cannot render complex style exactly; use legacy path');
      if(cacheKey&&styles.length)neutralByRawStyle.set(cacheKey,styles);
    }
    if(!styles.length)continue;
    const emit=(partIndex,draw)=>{
      const selected=styleMode==='stack'?styles:[styles[Math.min(partIndex,styles.length-1)]];
      draw(selected);
      counters.parts++;
    };
    if(kind==='Polygon'||kind==='MultiPolygon'){
      // Retain outside source rings if their antialiased stroke can enter the
      // exact scissored tile. Tile-unit conversion assumes MVT extent 4096 and
      // 256 logical CSS px per tile (the canonical direct MVT scene contract).
      // Importantly, fill clipping remains at the unexpanded tile boundary.
      const maxStroke=styles.reduce((w,s)=>Math.max(w,Number(s.stroke?.width||0)),0);
      const fringeUnits=clipExtent&&maxStroke>0&&polygonStrokeFringePx>0?
        (maxStroke*.5+polygonStrokeFringePx*.5)*(clipExtent[2]-clipExtent[0])/256:0;
      const paddedExtent=fringeUnits?[
        clipExtent[0]-fringeUnits,clipExtent[1]-fringeUnits,
        clipExtent[2]+fringeUnits,clipExtent[3]+fringeUnits]:clipExtent;
      const groups=olPolygonRangesWithBounds(flat,ends,stride,clipExtent,fringeUnits);
      groups.forEach(({ranges,location,strokeLocation},part)=>{
        emit(part,selected=>{
          counters.polygons++;counters[location]++;
          if(location==='outside'&&strokeLocation==='outside')return;
          let rings=null;
          const needsFill=selected.some(s=>!!s.fill);
          const needsStroke=selected.some(s=>!!s.stroke);
          let fillRange=null,strokeRanges=[];
          if(needsFill&&location!=='outside'){
            let mesh;
            if(location==='inside')fillRange=appendFlatPolygonIndexedDirect(flat,ranges,stride,verticesWriter,indicesWriter);
            else{
              if(polygonFlatTriangulation){
                mesh=ranges.length>1?triangulateEarcutFlat(flat,ranges,stride):
                  triangulateSimpleFlat(flat,ranges[0]?.[0]??0,ranges[0]?.[1]??0,stride,polygonEarBBoxPrecheck);
              }else{
                rings=materializeFlatPolygonRings(flat,ranges,stride);
                mesh=rings.length>1?clipper.triangulate(rings):triangulateSimpleRing(rings[0]||[],polygonEarBBoxPrecheck);
              }
            }
            if(mesh)fillRange=appendClippedMesh(mesh,clipExtent);
          }
          if(needsStroke&&strokeLocation!=='outside'){
            // Reserve only after observing an actually stroked polygon.  This
            // avoids large unused line buffers in fill-only scenes.  We make
            // one metadata-only count pass up front, not a second XY traversal.
            if(!strokeCapacityReserved){
              lineWriter.ensure(hint.lines+hint.polygonStrokeFloats-lineWriter.length);
              strokeCapacityReserved=true;
            }
            const strokeClipExtent=globalThis.__m5R18PolygonStrokeUnclipped===true?null:paddedExtent;
            for(const [start,end] of ranges){
              const direct=globalThis.__m5R18FlatUnclippedStroke===true&&strokeClipExtent===null?
                appendUnclippedFlatStrokeRing(flat,start,end,stride):
                appendFlatClippedStrokeRing(flat,start,end,stride,strokeClipExtent);
              if(direct!==null){strokeRanges.push(...direct);continue;}
              // Rare Float32-degenerate or precision-boundary fallbacks must
              // preserve the old clipped-path/CPU-join rendering contract.
              const fallback=materializeFlatPolygonRings(flat,[[start,end]],stride)[0];
              for(const path of clipPolylineToExtent(fallback,strokeClipExtent))strokeRanges.push(appendStrokePath(path));
            }
          }
          for(const style of selected){if(style.fill)addPacket('polygon',fillRange,style);if(style.stroke)for(const r of strokeRanges)addPacket('line',r,style);}
        });
      });
    }else if(kind==='LineString'||kind==='MultiLineString'){
      const stops=kind==='LineString'?[flat.length]:ends;
      if(styles.length===1&&(batchDraws||passBatches)){
        // A one-style multipart LineString is the common Road MVT case.
        // Encode every Part as before, but create a draw range only when
        // contiguous GPU instances change join type or have a gap. Retain
        // virtual emission/order counts for exact metadata parity.
        const style=styles[0],paint=!!style.stroke;
        let start=0,pending=null,pendingCount=0;
        const flush=()=>{
          if(pending){addPacket('line',pending,style,pendingCount);pending=null;pendingCount=0;}
        };
        for(let part=0;part<stops.length;part++){
          const end=stops[part];counters.parts++;
          if(paint){
            const range=lineDirectRange?appendLine(flat,null,stride,start,end):
              appendLine(flat.subarray?flat.subarray(start,end):flat.slice(start,end),null,stride);
            if(range.count){
              if(pending && pending.gpuJoin===range.gpuJoin && pending.first+pending.count===range.first){
                pending.count+=range.count;pendingCount++;
              }else{flush();pending={...range};pendingCount=1;}
            }
          }
          start=end;
        }
        flush();
      }else{
        let start=0;
        stops.forEach((end,part)=>{
          emit(part,selected=>{
            if(!selected.some(s=>s.stroke))return;
            const range=lineDirectRange?appendLine(flat,null,stride,start,end):
              appendLine(flat.subarray?flat.subarray(start,end):flat.slice(start,end),null,stride);
            for(const s of selected)if(s.stroke)addPacket('line',range,s);
          });start=end;
        });
      }
    }else if(kind==='Point'||kind==='MultiPoint'){
      for(let pos=0,part=0;pos<flat.length;pos+=stride,part++){
        emit(part,selected=>{
          const vertexOffset=verticesWriter.length/2,indexStart=indicesWriter.length;
          verticesWriter.push2(Number(flat[pos]),Number(flat[pos+1]));indicesWriter.push(vertexOffset);
          const range={indexStart,count:1};counters.points++;
          for(const s of selected)if(s.point)addPacket('point',range,s);
        });
      }
    }else throw Error(`Unsupported MVT type: ${kind}`);
    counters.features++;
  }
  if(passBatches){
    // Stable render-pass order: polygon fills, line strokes, then symbols.
    // This is opt-in until OL parity under alpha blending has been measured.
    const rank={polygon:0,line:1,point:2};
    for(const lane of [...passBatches.values()].sort((a,b)=>
      a.passOrder-b.passOrder||a.zIndex-b.zIndex||rank[a.type]-rank[b.type]||a.order-b.order))
      for(const batch of lane.batches)packets.push(batch);
  }else{
    // Preserve painter's order within a Z group, including A-B-A alpha blends.
    packets.sort((a,b)=>a.passOrder-b.passOrder||a.zIndex-b.zIndex||a.order-b.order);
  }
  // Adjacent packets may share one GPU draw only when painter order and
  // the *physical* vertex/instance range are both contiguous. Never reorder
  // transparent A-B-A or a fill followed by a stroke to maximize batching.
  if(!passBatches && batchDraws && packets.length>1){
    let write=1;
    for(let read=1;read<packets.length;read++){
      const next=packets[read],prior=packets[write-1];
      const contiguous=next.type==='line'?prior.first+prior.count===next.first:
        prior.indexStart+prior.count===next.indexStart;
      if(prior.type===next.type && prior.gpuJoin===next.gpuJoin &&
         prior.passOrder===next.passOrder && prior.zIndex===next.zIndex && prior.styleKey===next.styleKey && contiguous){
        prior.count+=next.count;
      }else packets[write++]=next;
    }
    packets.length=write;
  }
  // The index format matches the historical <=65536-vertex contract.
  if(verticesWriter.length/2>65536)indicesWriter.upgrade();
  const vertices=verticesWriter.view(),indices=indicesWriter.view(),lineInstances=lineWriter.view();
  const indexType=indices instanceof Uint16Array?'UNSIGNED_SHORT':'UNSIGNED_INT';
  const result={vertices,indices,lineInstances,packets,counters,clipExtent:clipExtent?Array.from(clipExtent):null,indexType,indexBytes:indices.BYTES_PER_ELEMENT,
    drawMode,emittedRanges,
    bufferStats:{featureChunks:0,finalMergeCopies:0,growthCopyBytes:verticesWriter.growthCopies+indicesWriter.growthCopies+lineWriter.growthCopies,
      vertexGrowthCopyBytes:verticesWriter.growthCopies,indexGrowthCopyBytes:indicesWriter.growthCopies,
      lineGrowthCopyBytes:lineWriter.growthCopies,
      allocatedCapacityBytes:verticesWriter.data.byteLength+indicesWriter.data.byteLength+lineWriter.data.byteLength}};
  result.byteLength=vertices.byteLength+indices.byteLength+lineInstances.byteLength;
  return result;
}

/** Tile-owned GPU buffers. No GeometryStore/RendererKernel/ReferenceStore round trips. */
export class DirectFeatureWebGLPipeline {
  constructor(backend,{bounds={minLon:0,minLat:0,maxLon:4096,maxLat:4096},resourceManager=null,gpuArenaHeadroomFactor=1}={}){
    this.backend=backend;this.tiles=new Map();this.bounds=bounds;
    this.resourceManager=resourceManager;
    // Only dedicated Direct GPU streams opt into spare GPU capacity.
    // This does not change CPU allocator offsets or geometry bytes.
    this.gpuArenaHeadroomFactor=gpuArenaHeadroomFactor;
    if(resourceManager)resourceManager.attachBackend(backend);
    this.lineUniforms=new LineRenderer({bounds});
    this.quadVB=null;this.quadIB=null;
  }
  _uploadEncoded(encoded,backend=this.backend){
    const buffers={};
    try{
      for(const [name,target,data] of [['vertices','ARRAY_BUFFER',encoded.vertices],['indices','ELEMENT_ARRAY_BUFFER',encoded.indices],['lineInstances','ARRAY_BUFFER',encoded.lineInstances]]){
        if(name==='indices'&&data instanceof Uint32Array&&data.length&&!backend.supportsUint32ElementIndices?.())throw Error('OES_element_index_uint required');
        if(!data.length){buffers[name]=null;continue;}
        const buffer=backend.createBufferResource(target,data.byteLength,'STATIC_DRAW');
        buffers[name]=buffer;
        backend.uploadBufferResource(target,buffer,0,data);
      }
      return buffers;
    }catch(error){for(const buffer of Object.values(buffers))backend.deleteBufferResource(buffer);throw error;}
  }
  _sharedName(kind){return `direct.feature.${kind}`;}
  _upsertShared(key,encoded,assumeOwnedData=false){
    const rm=this.resourceManager;
    const fields=[['vertices','ARRAY_BUFFER',8],['indices','ELEMENT_ARRAY_BUFFER',4],['lineInstances','ARRAY_BUFFER',32]];
    for(const [kind,target,alignment] of fields){
      const data=encoded[kind],name=this._sharedName(kind);
      if(kind==='indices'&&data instanceof Uint32Array&&data.length&&!this.backend.supportsUint32ElementIndices?.())throw Error('OES_element_index_uint required');
      if(!data.length){rm.removeStreamResource(name,key);continue;}
      // Stage first and flush once.  Without a batch, a growing packed
      // GPU stream reuploads the just-inserted tile during _ensureCapacity()
      // and uploads the same payload again after returning from it.
      rm.beginStreamUploadBatch(name,{target,alignment,gpuCapacityHeadroomFactor:this.gpuArenaHeadroomFactor});
      try{rm.upsertStreamResource(name,key,data,{target,alignment,assumeOwnedData});}
      finally{rm.endStreamUploadBatch(name);}
    }
  }
  replaceTile(tileKey,features,options){
    const timing=options?.diagnostics;
    const start=timing?performance.now():0;
    const encoded=encodeDirectFeatureTile(features,options);
    const encodeEnd=timing?performance.now():0;
    const result=this.replaceEncodedTile(tileKey,encoded,options);
    if(timing){
      timing.encodeCpuMs=encodeEnd-start;
      timing.totalPrepareMs+=encodeEnd-start;
    }
    return result;
  }
  /** Accept a prebuilt tile emitted by the reusable Worker Pool. No geometry
   * parsing or Earcut runs on this thread. Exactly the same upload path,
   * rollback, ownership and painter packet order as replaceTile(). */
  replaceEncodedTile(tileKey,encoded,options={}){
    if(!(encoded?.vertices instanceof Float32Array)||
       !(encoded.indices instanceof Uint16Array||encoded.indices instanceof Uint32Array)||
       !(encoded.lineInstances instanceof Float32Array)||!Array.isArray(encoded.packets)||
       !encoded.counters||!Number.isFinite(encoded.byteLength))
      throw Error('Worker tile must contain valid GPU-ready typed arrays and draw packets');
    const timing=options?.diagnostics;
    const uploadStart=timing?performance.now():0;
    const key=String(tileKey),old=this.tiles.get(key);
    const transfer=options?.transferGpuBuffers===true&&!!this.resourceManager;
    if(this.resourceManager){
      try{this._upsertShared(key,encoded,transfer);}
      catch(error){if(old)this._upsertShared(key,old);else for(const kind of ['vertices','indices','lineInstances'])this.resourceManager.removeStreamResource(this._sharedName(kind),key);throw error;}
      this.tiles.set(key,{...encoded,buffers:null});
    }else{
      const buffers=this._uploadEncoded(encoded);
      this.tiles.set(key,{...encoded,buffers});
      if(old)for(const buffer of Object.values(old.buffers))this.backend.deleteBufferResource(buffer);
    }
    if(timing){
      timing.arenaAndWebglApiMs=performance.now()-uploadStart;
      timing.totalPrepareMs=timing.arenaAndWebglApiMs;
      timing.encodedBytes=encoded.byteLength;
      timing.drawPackets=encoded.packets.length;
      timing.emittedRanges=encoded.emittedRanges;
    }
    return transfer?{packets:encoded.packets.map(p=>({...p})),counters:{...encoded.counters},
      bufferStats:{...encoded.bufferStats},byteLength:encoded.byteLength,
      indexType:encoded.indexType,indexBytes:encoded.indexBytes}:encoded;
  }
  /** Recreate GPU storage from retained tile TypedArrays after context loss. */
  restoreAfterContextLoss(backend=this.backend){
    if(this.resourceManager){
      // Must be called after ResourceManager.handleContextLost(), or on a
      // fresh ResourceManager. Restoring existing streams reuploads each tile.
      this.backend=backend;
      this.resourceManager.restoreBackend(backend);
      this.quadVB=null;this.quadIB=null;
      return this.tiles.size;
    }
    const rebuilt=new Map();
    try{for(const [key,tile] of this.tiles)rebuilt.set(key,this._uploadEncoded(tile,backend));}
    catch(error){for(const buffers of rebuilt.values())for(const buffer of Object.values(buffers))backend.deleteBufferResource(buffer);throw error;}
    this.backend=backend;this.quadVB=null;this.quadIB=null;
    for(const [key,buffers] of rebuilt)this.tiles.get(key).buffers=buffers;
    return rebuilt.size;
  }
  // OlVectorTileSourceAdapter calls this *before* constructing NeutralGeometry.
  replaceRawTile(tileKey,features,options={}){
    if(options.coordinateTransform && options.sourceProjection!==options.targetProjection)
      throw Error('Direct buffer mode requires coordinates already in target projection');
    const encoded=this.replaceTile(tileKey,features,options);
    return encoded;
  }
  removeTile(tileKey){const key=String(tileKey),old=this.tiles.get(key);if(!old)return false;
    if(this.resourceManager){for(const kind of ['vertices','indices','lineInstances'])this.resourceManager.removeStreamResource(this._sharedName(kind),key);}
    else for(const buf of Object.values(old.buffers))this.backend.deleteBufferResource(buf);
    this.tiles.delete(key);return true;}
  clear(){for(const key of [...this.tiles.keys()])this.removeTile(key);if(this.quadVB){this.backend.deleteBufferResource(this.quadVB);this.quadVB=null;}if(this.quadIB){this.backend.deleteBufferResource(this.quadIB);this.quadIB=null;}}
  _quad(){if(this.quadVB)return;const b=this.backend,g=b.gl;
    this.quadVB=b.createBufferResource('ARRAY_BUFFER',32,'STATIC_DRAW');b.uploadBufferResource('ARRAY_BUFFER',this.quadVB,0,new Float32Array([-1,-1,-1,1,1,-1,1,1]));
    this.quadIB=b.createBufferResource('ELEMENT_ARRAY_BUFFER',12,'STATIC_DRAW');b.uploadBufferResource('ELEMENT_ARRAY_BUFFER',this.quadIB,0,new Uint16Array([0,1,2,1,3,2]));
  }
  /** Call after backend.beginFrame(). Does not clear the canvas. */
  draw({frame=null,worldOffsetX=0,tiles=null,packetSchedule=null}={}){
    const b=this.backend,g=b.gl,rm=this.resourceManager;
    // Resolve each tile's shared GPU base offsets once per frame, not once
    // per Part/Batch. No selected.map/filter temporary tuple arrays.
    const resolved=new Map();
    const resolve=(key,tile)=>{
      let info=resolved.get(key);
      if(info)return info;
      const vertexBase=rm?(rm.getStreamRange(this._sharedName('vertices'),key)?.offset||0):0;
      const indexBase=rm?(rm.getStreamRange(this._sharedName('indices'),key)?.offset||0):0;
      const lineBase=rm?(rm.getStreamRange(this._sharedName('lineInstances'),key)?.offset||0):0;
      const vertexBuffer=rm?rm.getStreamBuffer(this._sharedName('vertices')):tile.buffers.vertices;
      const indexBuffer=rm?rm.getStreamBuffer(this._sharedName('indices')):tile.buffers.indices;
      const lineBuffer=rm?rm.getStreamBuffer(this._sharedName('lineInstances')):tile.buffers.lineInstances;
      info={vertexBase,indexBase,lineBase,vertexBuffer,indexBuffer,lineBuffer};resolved.set(key,info);
      return info;
    };
    // Source MVT geometries can extend beyond their unbuffered tile extent.
    // OL clips fragments to that extent to prevent cross-tile overdraw.
    const clipToTile=(tile,worldOffsetX)=>{
      if(!this.tileScissorEnabled||!frame?.clipMatrix||!tile.clipExtent){
        if(this.tileScissorEnabled)g.disable(g.SCISSOR_TEST);
        return;
      }
      const [minX,minY,maxX,maxY]=tile.clipExtent,m=frame.clipMatrix;
      const width=b.canvas.width,height=b.canvas.height;
      const point=(x,y)=>{
        const xx=x+worldOffsetX;
        return [(m[0]*xx+m[4]*y+m[12]+1)*width*0.5,(m[1]*xx+m[5]*y+m[13]+1)*height*0.5];
      };
      const corners=[point(minX,minY),point(minX,maxY),point(maxX,minY),point(maxX,maxY)];
      const left=Math.max(0,Math.min(width,Math.ceil(Math.min(...corners.map(p=>p[0]))-0.000001)));
      const bottom=Math.max(0,Math.min(height,Math.ceil(Math.min(...corners.map(p=>p[1]))-0.000001)));
      const right=Math.max(0,Math.min(width,Math.ceil(Math.max(...corners.map(p=>p[0]))-0.000001)));
      const top=Math.max(0,Math.min(height,Math.ceil(Math.max(...corners.map(p=>p[1]))-0.000001)));
      g.enable(g.SCISSOR_TEST);
      g.scissor(left,bottom,Math.max(0,right-left),Math.max(0,top-bottom));
    };
    const drawOne=(key,tile,p,tileWorldOffsetX)=>{
      clipToTile(tile,tileWorldOffsetX);
      const {vertexBase,indexBase,lineBase,vertexBuffer,indexBuffer,lineBuffer}=resolve(key,tile);
        if(p.type==='line'){
          this._quad();const gpuJoin=p.gpuJoin===true;
          const c=b.program(gpuJoin?'direct-feature-line-gpu':'direct-feature-line-cpu',gpuJoin?lineGpuJoinVertexShader:lineVertexShader,lineFragmentShader);
          b.useProgram(c.program);b.disableAllAttribs?.();b.bindBuffer(g.ARRAY_BUFFER,this.quadVB);b.bindFloatAttrib(c,'a_quadCorner',2,0,0,0);
          b.bindBuffer(g.ARRAY_BUFFER,lineBuffer);
          let off=lineBase+p.first*32;
          const layout=gpuJoin?[['a_prevPoint',2],['a_segmentStart',2],['a_segmentEnd',2],['a_nextPoint',2]]:[['a_segmentStart',2],['a_segmentEnd',2],['a_distance',1],['a_joinAngles',2],['a_angleTangentSum',1]];
          for(const [name,count] of layout){b.bindFloatAttrib(c,name,count,32,off,1);off+=count*4;}
          b.bindBuffer(g.ELEMENT_ARRAY_BUFFER,this.quadIB);
          this.lineUniforms.setUniforms(b,c,p.style,1,frame);
          b.uniform1f(b.uniform(c,'u_worldOffsetX'),tileWorldOffsetX);
          b.drawElementsInstanced(g.TRIANGLES,6,g.UNSIGNED_SHORT,0,p.count);
        }else{
          const c=b.program('direct-feature-simple',M4_SIMPLE_VERTEX_SHADER,M4_SIMPLE_FRAGMENT_SHADER);
          b.useProgram(c.program);b.disableAllAttribs?.();b.bindBuffer(g.ARRAY_BUFFER,vertexBuffer);b.bindFloatAttrib(c,'a_pos',2,0,vertexBase,0);
          b.bindBuffer(g.ELEMENT_ARRAY_BUFFER,indexBuffer);
          b.uniformMatrix4fv(b.uniform(c,'u_projectionMatrix'),false,frame?.clipMatrix||DEFAULT_MATRIX);
          b.uniform1f(b.uniform(c,'u_worldOffsetX'),tileWorldOffsetX);
          b.uniform2f(b.uniform(c,'u_viewportSizeCss'),frame?.size?.[0]||b.canvas.width,frame?.size?.[1]||b.canvas.height);
          const style=p.style,point=p.type==='point';
          b.uniform4fv(b.uniform(c,'u_color'),style.color||[1,1,1,1]);
          b.uniform1i(b.uniform(c,'u_isPoint'),point?1:0);
          b.uniform1f(b.uniform(c,'u_spriteOpacity'),1);
          b.uniform2f(b.uniform(c,'u_spriteSize'),1,1);
          b.uniform1f(b.uniform(c,'u_spriteRotation'),0);
          b.uniform1i(b.uniform(c,'u_premultiplyAlpha'),style.premultiplyAlpha?1:0);
          b.uniform1f(b.uniform(c,'u_pointSize'),point?(style.pointSize||6)*(frame?.pixelRatio||1):1);
          b.uniform1f(b.uniform(c,'u_pointShape'),point?(style.pointShape||0):0);
          b.uniform4fv(b.uniform(c,'u_pointStrokeColor'),style.pointStrokeColor||[0,0,0,0]);
          b.uniform1f(b.uniform(c,'u_pointStrokeWidth'),point?(style.pointStrokeWidth||0)*(frame?.pixelRatio||1):0);
          b.uniform2f(b.uniform(c,'u_pointDisplacement'),...(style.pointDisplacement||[0,0]));
          b.drawElements(point?g.POINTS:g.TRIANGLES,p.count,tile.indexType==='UNSIGNED_INT'?g.UNSIGNED_INT:g.UNSIGNED_SHORT,indexBase+p.indexStart*tile.indexBytes);
        }
    };
    if(packetSchedule){
      for(const item of packetSchedule){
        const key=String(item.tileKey),tile=this.tiles.get(key);
        if(!tile||!Number.isInteger(item.packetIndex))continue;
        const p=tile.packets[item.packetIndex];if(!p)continue;
        drawOne(key,tile,p,item.worldOffsetX);
      }
    }else if(tiles){
      for(const item of tiles){const key=String(item),tile=this.tiles.get(key);if(!tile)continue;
        for(const p of tile.packets)drawOne(key,tile,p,worldOffsetX);}
    }else{
      for(const [key,tile] of this.tiles)for(const p of tile.packets)drawOne(key,tile,p,worldOffsetX);
    }
    if(this.tileScissorEnabled)g.disable(g.SCISSOR_TEST);
  }
}
