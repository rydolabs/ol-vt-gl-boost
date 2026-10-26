import {packFlatLineVertexGroup,writeDirectGpuJoinPath} from '../tile/RenderFeatureLinePacker.js';
import { lineVertexShader, lineGpuJoinVertexShader, lineFlatVertexShader, lineFragmentShader } from './shaders.js';
const ATTRS=[['a_segmentStart',2],['a_segmentEnd',2],['a_distance',1],['a_joinAngles',2],['a_angleTangentSum',1]];
const GPU_JOIN_ATTRS=[['a_prevPoint',2],['a_segmentStart',2],['a_segmentEnd',2],['a_nextPoint',2]];
// A ReferenceStore can re-publish *new objects* with the same signature without
// marking the line renderer dirty. Preserve an exact-value lookup for those
// references; the WeakMap remains the zero-allocation common frame path.
function sliceSignature(r){return JSON.stringify([r.id??null,r.geometryId,r.styleId,r.order??0,r.sceneLayerKey??null,r.sceneStyleZIndex??0,r.sceneWorldOffsetX??0,r.sceneLayerZIndex??0,r.sceneLayerSequence??0,r.tileKey??null]);}
function angleBetweenXY(x0,y0,xa,ya,xb,yb){const ax=xa-x0,ay=ya-y0,bx=xb-x0,by=yb-y0;if((ax===0&&ay===0)||(bx===0&&by===0))return 0;let a=Math.atan2(ax*by-ay*bx,ax*bx+ay*by);if(a<=0)a+=(Math.PI*2);return a}
function reader(g){
  if(g.positions){const base=g.offset||0;return {count:g.count,get(i){const j=(base+i)*2;return [g.positions[j],g.positions[j+1]]}};}
  return {count:g.coords.length,get(i){return g.coords[i]}};
}
// Pack line parts into a single style-independent instance arena without
// connecting the end of one polyline to the beginning of the next. Joins and
// distance accumulation restart at each independent path, as before.
function writeLineInstanceData(g,data,start=0){
  const r=reader(g), n=Math.max(0,r.count-1), joins=new Float64Array(r.count); if(r.count){joins[0]=-1;joins[r.count-1]=-1}
  for(let i=1;i<r.count-1;i++){const p=r.get(i),nxt=r.get(i+1),prv=r.get(i-1);joins[i]=angleBetweenXY(p[0],p[1],nxt[0],nxt[1],prv[0],prv[1])}
  let dist=0,tanSum=0,o=start;
  for(let i=0;i<n;i++){const p0=r.get(i),p1=r.get(i+1),a0=joins[i],a1=i<n-1?Math.PI*2-joins[i+1]:-1;
    data[o++]=p0[0];data[o++]=p0[1];data[o++]=p1[0];data[o++]=p1[1];data[o++]=dist;data[o++]=a0;data[o++]=a1;data[o++]=tanSum;
    if(i>0&&Math.abs(Math.cos(a0))<=.98)tanSum+=Math.tan((a0-Math.PI)/2); if(i<n-1&&Math.abs(Math.cos(a1))<=.98)tanSum+=Math.tan((Math.PI-a1)/2); dist+=Math.hypot(p1[0]-p0[0],p1[1]-p0[1]);
  }
  return n;
}
export function createLineInstanceDataFromGeometry(g){
  if(g.flatGpu===true||g.directGpuJoin===true)return {raw:g,instanceCount:g.instanceCount};
  if(g.instanceData instanceof Float32Array)
    return {instanceData:g.instanceData,instanceCount:g.instanceCount};
  if(Array.isArray(g.paths)){
    let count=0;
    for(const path of g.paths)count+=Math.max(0,(path?.length||0)-1);
    const data=new Float32Array(count*8);
    let offset=0;
    for(const path of g.paths)offset+=writeLineInstanceData({coords:path},data,offset*8);
    return {instanceData:data,instanceCount:count};
  }
  const count=Math.max(0,(g.positions?g.count:(g.coords?.length||0))-1);
  const data=new Float32Array(count*8);
  writeLineInstanceData(g,data);
  return {instanceData:data,instanceCount:count};
}
function ortho(cx,cy,bw,bh,vw,vh,scale=1,rot=0){const res=Math.max(bw/vw,bh/vh),sx=2/(vw*res*scale),sy=2/(vh*res*scale),c=Math.cos(rot),s=Math.sin(rot);return new Float32Array([sx*c,sx*s,0,0,-sy*s,sy*c,0,0,0,0,1,0,-cx*sx*c+cy*sy*s,-cx*sx*s-cy*sy*c,0,1])}
export class LineRenderer {
  constructor({bounds,drawStreamThreshold=4096,bulkLineStreamThreshold=Infinity,shareIdenticalStyleBuffers=false,gpuCapacityHeadroomFactor=1}={}){this.bounds=bounds;this.gpuCapacityHeadroomFactor=gpuCapacityHeadroomFactor;this.shareIdenticalStyleBuffers=shareIdenticalStyleBuffers;this.resource=null;this.patternKeys=new Set();this.drawStreamThreshold=drawStreamThreshold;this.bulkLineStreamThreshold=bulkLineStreamThreshold;this.instanceCache=new Map();
    // This renderer never draws through ResourceManager's generic geometry VBO.
    this.usesStandaloneGeometryStream=true;
    // Each RenderSchedule pass owns a stable reference array. Draw commands are
    // compiled once for that array, rather than rebuilding 50k+ string keys on
    // every frame. Reference/geometry changes invalidate this cache.
    this._drawPackets=new WeakMap();
    this.drawPacketStats={builds:0,hits:0};
  }
  _invalidateDrawPackets(){this._drawPackets=new WeakMap();}
  _instances(g){const cached=this.instanceCache.get(g.id);if(cached&&cached.version===g.version)return cached.data;const data=createLineInstanceDataFromGeometry(g);this.instanceCache.set(g.id,{version:g.version,data});return data;}
  prepare(backend, geometryEntries, references, styleStore, resourceManager){
    const gl=backend.gl, physical=new Map(), keep=new Set(), geometryById=new Map(); let totalInstances=0;
    const packedLineScene=geometryEntries.some(g=>Array.isArray(g.paths)||g.instanceData instanceof Float32Array||g.flatGpu===true||g.directGpuJoin===true);
    // Dense polygon outlines must start in the grouped draw stream *on their
    // first tile*. Waiting for >=4096 references drew thousands of individual
    // line parts during progressive loading. For this opt-in bulk mode (and
    // packed lines), avoid allocating the unused line.instances GPU stream.
    // Keep the decision stable until the next full prepare, even if a tile is
    // subsequently removed: falling back would reference absent allocations.
    const streamOnlyScene=packedLineScene || geometryEntries.length>=this.bulkLineStreamThreshold;
    if(!streamOnlyScene)resourceManager.beginStreamUploadBatch('line.instances',{alignment:32});
    try {
      for(const g of geometryEntries){
        const c=this._instances(g); keep.add(g.id); geometryById.set(g.id,g); totalInstances+=c.instanceCount;
        if(streamOnlyScene){physical.set(g.id,{startInstance:0,instanceCount:c.instanceCount,floatLength:c.instanceData?.length??0,byteLength:c.instanceData?.byteLength??0});}
        if(!streamOnlyScene){
          const range=resourceManager.upsertStreamResource('line.instances',g.id,c.instanceData,{alignment:32});
          physical.set(g.id,{startInstance:range.offset/32,instanceCount:c.instanceCount,floatLength:c.instanceData?.length??0,byteLength:c.instanceData?.byteLength??0});
        }
      }
    } finally {if(!streamOnlyScene)resourceManager.endStreamUploadBatch('line.instances');}
    resourceManager.retainStreamResources('line.instances',streamOnlyScene?new Set():keep);
    for(const id of this.instanceCache.keys())if(!keep.has(id))this.instanceCache.delete(id);
    // Full rebuilds/context restore must not leak quad buffers.
    if(this.resource){gl.deleteBuffer?.(this.resource.quadVB);gl.deleteBuffer?.(this.resource.quadIB);}
    this._invalidateDrawPackets();
    const quadVB=gl.createBuffer();backend.bindBuffer(gl.ARRAY_BUFFER,quadVB);backend.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const quadIB=gl.createBuffer();backend.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,quadIB);backend.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,1,3,2]),gl.STATIC_DRAW);
    this._syncPatternTextures(references,styleStore,resourceManager);this.resource={quadVB,quadIB,styleStore,physical,totalInstances,references,resourceManager,geometryById,layoutVersion:resourceManager.getStreamLayoutVersion('line.instances'),packedLineScene,streamOnlyScene,drawStream:null,drawStreamLayoutVersion:-1,drawStreamFlatLayoutVersion:-1};this._buildDrawStream(references,resourceManager);return this.resource;
  }

  _drawGroupKey(r,g){const key=`${String(r.sceneLayerKey??'__default')}|${Number(r.sceneStyleZIndex??0)}|${r.styleId}|${Number(r.sceneWorldOffsetX??0)}`;return g?.flatGpu?`${key}|flat`:g?.gpuJoin?`${key}|gpu`:key;}
  _buildDrawStream(references,resourceManager=this.resource?.resourceManager){
    if(!this.resource)return;
    this._invalidateDrawPackets();
    if((references?.length||0)<this.drawStreamThreshold && !this.resource.streamOnlyScene){resourceManager?.retainStreamResources?.('line.drawInstances',new Set());this.resource.drawStream=null;this.resource.drawStreamLayoutVersion=resourceManager?.getStreamLayoutVersion?.('line.drawInstances')??-1;if(resourceManager?.streams?.has('line.flatVertices'))resourceManager.retainStreamResources('line.flatVertices',new Set());return;}
    const groups=new Map();
    // The upload arena can be grouped by style, but compositing cannot: A-B-A
    // must issue three draws in that order. Remember the precise physical
    // subrange of each reference so a draw packet can replay ordered slices.
    for(const r of references||[]){
      if(r.visible===false)continue;
      const g=this.resource.geometryById.get(r.geometryId);if(!g)continue;
      const c=this._instances(g);if(!c.instanceCount)continue;
      const key=this._drawGroupKey(r,g);
      let x=groups.get(key);
      if(!x){x={key,flatGpu:g.flatGpu===true,gpuJoin:g.gpuJoin===true,vertexCount:0,styleId:r.styleId,layerKey:String(r.sceneLayerKey??'__default'),styleZIndex:Number(r.sceneStyleZIndex??0),worldOffsetX:Number(r.sceneWorldOffsetX??0),parts:[],slices:[],floatLength:0,instanceCount:0};groups.set(key,x);}
      if(g.flatGpu){
        const isPath=Number.isInteger(r.packedPathIndex);
        const raw=isPath ? {...c.raw,
          flatStart:c.raw.flatStart+r.packedPathPointStart*c.raw.flatStride,
          flatEnd:c.raw.flatStart+(r.packedPathPointStart+r.packedPathPointCount)*c.raw.flatStride,
          flatEnds:null,flatPointCount:r.packedPathPointCount,flatPathCount:1,
          instanceCount:r.packedPathCount} : c.raw;
        const spanVertices=raw.flatPointCount;
        x.slices.push({reference:r,relativeStart:x.vertexCount,instanceCount:isPath?r.packedPathCount:c.instanceCount,spanVertices});
        x.parts.push(raw);x.vertexCount+=spanVertices;
        x.floatLength=(x.vertexCount+2)*3;x.instanceCount+=isPath?r.packedPathCount:c.instanceCount;
      }else{
        const isPath=Number.isInteger(r.packedPathIndex);
        const part=g.directGpuJoin===true
          ? {direct:g,pointStart:isPath?r.packedPathPointStart:0,
             pointCount:isPath?r.packedPathPointCount:(g.flatEnd-g.flatStart)/g.flatStride,
             instanceCount:isPath?r.packedPathCount:c.instanceCount}
          : (isPath ? c.instanceData.subarray(r.packedPathStart*8,(r.packedPathStart+r.packedPathCount)*8) : c.instanceData);
        x.slices.push({reference:r,relativeStart:x.instanceCount,instanceCount:isPath?r.packedPathCount:c.instanceCount});
        x.parts.push(part);x.floatLength+=g.directGpuJoin===true?part.instanceCount*8:part.length;
        x.instanceCount+=isPath?r.packedPathCount:c.instanceCount;
      }
    }
    const keep=new Set(),flatKeep=new Set(),batches=new Map(),physicalOwners=[];
    const prior=this.resource.drawStream?.batches;
    resourceManager.beginStreamUploadBatch('line.drawInstances',{alignment:32,gpuCapacityHeadroomFactor:this.gpuCapacityHeadroomFactor});
    const useFlatStream=[...groups.values()].some(g=>g.flatGpu)||resourceManager.streams.has('line.flatVertices');
    if(useFlatStream)resourceManager.beginStreamUploadBatch('line.flatVertices',{alignment:48,gpuCapacityHeadroomFactor:this.gpuCapacityHeadroomFactor});
    try {
      for(const [key,g] of groups){
        if(!g.instanceCount)continue;
        // A shader style is a set of uniforms, not a copy of Geometry.
        // Alias only groups with *the same ordered immutable Float32Array
        // instances*, which also preserves all existing draw-call ordering.
        // Different filters/orders/geometries never alias. A removed owner is
        // safely replaced at the next rebuild; the arena's retainOnly() drops
        // resources no longer referenced by any draw group.
        const shared=(this.shareIdenticalStyleBuffers||g.flatGpu)&&this.resource.packedLineScene
          ? physicalOwners.find(owner=>owner.flatGpu===g.flatGpu && owner.floatLength===g.floatLength &&
              owner.parts.length===g.parts.length &&
              owner.parts.every((part,i)=>part===g.parts[i] ||
                (part instanceof Float32Array && g.parts[i] instanceof Float32Array &&
                 part.buffer===g.parts[i].buffer && part.byteOffset===g.parts[i].byteOffset && part.length===g.parts[i].length)))
          : null;
        if(shared){
          batches.set(key,{...g,startInstance:shared.startInstance,storageKey:shared.storageKey,streamName:shared.streamName});
          continue;
        }
        const streamName=g.flatGpu?'line.flatVertices':'line.drawInstances';
        const old=prior?.get(key),previousParts=old?.parts;
        let range=null;
        // Instance arrays are memoized by geometry id/version. If the same
        // references appear in the same order, this group's actual bytes are
        // unchanged. Retain its existing arena range instead of rebuilding a
        // giant Float32Array, comparing it byte-by-byte and copying it again.
        if(previousParts?.length===g.parts.length && old.floatLength===g.floatLength){
          let unchanged=true;
          for(let i=0;i<g.parts.length;i++){
            const a=previousParts[i],b=g.parts[i];
            if(a!==b && !(a instanceof Float32Array && b instanceof Float32Array &&
              a.buffer===b.buffer && a.byteOffset===b.byteOffset && a.length===b.length) &&
              !(a?.direct && b?.direct && a.direct.flatCoordinates===b.direct.flatCoordinates &&
                a.direct.flatStart===b.direct.flatStart && a.direct.flatEnd===b.direct.flatEnd &&
                a.direct.flatStride===b.direct.flatStride && a.pointStart===b.pointStart && a.pointCount===b.pointCount)){
              unchanged=false;break;
            }
          }
          if(unchanged)range=resourceManager.getStreamRange(streamName,key);
        }
        if(!range){
          let data;
          if(g.flatGpu){
            const packed=packFlatLineVertexGroup(g.parts);
            if(packed.vertexCount!==g.vertexCount+2)throw Error('Flat vertex count mismatch');
            data=packed.data;
          }else{
            data=new Float32Array(g.floatLength);
            let o=0;
            for(const part of g.parts){
              if(part?.direct)o=writeDirectGpuJoinPath(data,o,part.direct,part.pointStart,part.pointCount);
              else {data.set(part,o);o+=part.length;}
            }
            if(o!==g.floatLength)throw Error('Direct GPU Join stream length mismatch');
          }
          range=resourceManager.upsertStreamResource(streamName,key,data,{alignment:g.flatGpu?48:32});
        }
        (g.flatGpu?flatKeep:keep).add(key);
        // Keep identities, not copies of the large Float32 payloads. The
        // renderer's geometry instance cache remains their single owner.
        const owner={...g,startInstance:range.offset/(g.flatGpu?12:32),storageKey:key,streamName};
        batches.set(key,owner);
        physicalOwners.push(owner);
      }
    } finally {resourceManager.endStreamUploadBatch('line.drawInstances');if(useFlatStream)resourceManager.endStreamUploadBatch('line.flatVertices');}
    resourceManager.retainStreamResources('line.drawInstances',keep);
    if(useFlatStream)resourceManager.retainStreamResources('line.flatVertices',flatKeep);
    const refSlices=new WeakMap(),refSlicesBySignature=new Map();
    for(const [key,g] of groups){
      if(!batches.has(key))continue;
      for(const slice of g.slices){
        let occurrences=refSlices.get(slice.reference);
        if(!occurrences){occurrences=[];refSlices.set(slice.reference,occurrences);}
        const entry={key,relativeStart:slice.relativeStart,instanceCount:slice.instanceCount,spanVertices:slice.spanVertices};
        occurrences.push(entry);
        const signature=sliceSignature(slice.reference);
        let equivalents=refSlicesBySignature.get(signature);
        if(!equivalents){equivalents=[];refSlicesBySignature.set(signature,equivalents);}
        equivalents.push(entry);
      }
    }
    this.resource.drawStream={batches,refSlices,refSlicesBySignature};
    this.resource.drawStreamLayoutVersion=resourceManager.getStreamLayoutVersion('line.drawInstances');
    this.resource.drawStreamFlatLayoutVersion=resourceManager.streams.get('line.flatVertices')?.layoutVersion??-1;
  }
  _syncDrawStreamLayout(){
    const rm=this.resource?.resourceManager,ds=this.resource?.drawStream;
    if(!rm||!ds)return;
    const v=rm.getStreamLayoutVersion('line.drawInstances'),fv=rm.streams.get('line.flatVertices')?.layoutVersion??-1;
    if(v===this.resource.drawStreamLayoutVersion&&fv===this.resource.drawStreamFlatLayoutVersion)return;
    for(const [key,b] of ds.batches){
      const stream=b.streamName||'line.drawInstances';
      const range=rm.getStreamRange(stream,b.storageKey||key);
      if(range)b.startInstance=range.offset/(b.flatGpu?12:32);
    }
    this.resource.drawStreamLayoutVersion=v;
    this.resource.drawStreamFlatLayoutVersion=fv;
    this._invalidateDrawPackets();
  }

  updateGeometry(backend,g){
    if(this.resource?.drawStream){
      // A changed/new geometry must not force prepare() for *every* geometry
      // already resident in the renderer. Stage only this geometry's physical
      // data. The kernel rebuilds reference/draw groups once after all dirty
      // geometries have been uploaded, with their cached instance arrays.
      const rm=this.resource.resourceManager,c=this._instances(g);
      const previous=this.resource.physical.get(g.id);
      if(this.resource.streamOnlyScene){this.resource.physical.set(g.id,{startInstance:0,instanceCount:c.instanceCount,floatLength:c.instanceData?.length??0,byteLength:c.instanceData?.byteLength??0});}
      if(!this.resource.streamOnlyScene){
        const range=rm.upsertStreamResource('line.instances',g.id,c.instanceData,{alignment:32});
        this.resource.physical.set(g.id,{startInstance:range.offset/32,instanceCount:c.instanceCount,floatLength:c.instanceData?.length??0,byteLength:c.instanceData?.byteLength??0});
      }
      this.resource.geometryById.set(g.id,g);
      this.resource.totalInstances+=c.instanceCount-(previous?.instanceCount||0);
      // Do not advance layoutVersion here: existing physical offsets may be
      // stale after arena growth. _syncPhysical will refresh every offset if
      // the draw stream is later disabled by a reference-count reduction.
      return {rebuild:false,referenceDirty:true,compiled:1,uploadedBytes:c.instanceData?.byteLength??0};
    }
    const p=this.resource?.physical.get(g.id);if(!p)return {rebuild:true,compiled:0,uploadedBytes:0};const c=this._instances(g);if(c.instanceCount!==p.instanceCount||(c.instanceData?.length??0)!==p.floatLength)return {rebuild:true,compiled:1,uploadedBytes:0};
    const range=this.resource.resourceManager.upsertStreamResource('line.instances',g.id,c.instanceData,{alignment:32});
    p.startInstance=range.offset/32; this.resource.layoutVersion=this.resource.resourceManager.getStreamLayoutVersion('line.instances');
    return {rebuild:false,compiled:1,uploadedBytes:c.instanceData?.byteLength??0};
  }
  _patternKey(style){return style.strokePatternTextureKey||style.textureKey||'line.pattern.default';}
  _patternDescriptor(){return {width:20,height:20,sourceFactory:()=>{const c=document.createElement('canvas');c.width=c.height=20;const x=c.getContext('2d');x.fillStyle='green';x.fillRect(0,0,20,20);x.fillStyle='red';x.fillRect(8,0,4,20);x.fillRect(0,8,20,4);return c;}};}
  _syncPatternTextures(references,styleStore,resourceManager){const next=new Set();for(const r of references){const s=styleStore.get(r.styleId);if(s?.useStrokePattern)next.add(this._patternKey(s));}for(const key of this.patternKeys)if(!next.has(key))resourceManager.releaseTexture(key);for(const key of next)if(!this.patternKeys.has(key))resourceManager.acquireTexture(key,this._patternDescriptor());this.patternKeys=next;}
  setUniforms(backend,c,style,scale=1,frame=null){const gl=backend.gl,cv=backend.canvas,b=this.bounds;const pr=frame?.pixelRatio||window.devicePixelRatio||1;const vw=frame?.size?.[0]||cv.width/pr,vh=frame?.size?.[1]||cv.height/pr;const m=frame?.clipMatrix||ortho((b.minLon+b.maxLon)/2,(b.minLat+b.maxLat)/2,b.maxLon-b.minLon,b.maxLat-b.minLat,cv.width,cv.height,scale,style.rotation||0);backend.uniformMatrix4fv(backend.uniform(c,'u_projectionMatrix'),false,m);backend.uniform2f(backend.uniform(c,'u_viewportSizePx'),vw,vh);backend.uniform1f(backend.uniform(c,'u_pixelRatio'),pr);backend.uniform1f(backend.uniform(c,'u_globalAlpha'),1);backend.uniform1f(backend.uniform(c,'u_depth'),0);backend.uniform1f(backend.uniform(c,'u_resolution'),1);backend.uniform4fv(backend.uniform(c,'u_strokeColor'),style.strokeColor);backend.uniform1f(backend.uniform(c,'u_strokeWidth'),style.strokeWidth);backend.uniform1f(backend.uniform(c,'u_strokeOffset'),style.strokeOffset||0);backend.uniform1f(backend.uniform(c,'u_strokeCap'),style.strokeCap||0);backend.uniform1f(backend.uniform(c,'u_strokeJoin'),style.strokeJoin||0);backend.uniform1f(backend.uniform(c,'u_strokeMiterLimit'),style.strokeMiterLimit||10);backend.uniform1i(backend.uniform(c,'u_useStrokePattern'),style.useStrokePattern?1:0);if(style.useStrokePattern){gl.activeTexture(gl.TEXTURE0);backend.bindTexture(gl.TEXTURE_2D,this.resource.resourceManager.getTexture(this._patternKey(style)));backend.uniform1i(backend.uniform(c,'u_strokePatternTexture'),0);backend.uniform2f(backend.uniform(c,'u_strokePatternTextureSize'),20,20);backend.uniform2f(backend.uniform(c,'u_strokePatternTextureOffset'),...(style.strokePatternTextureOffset||[0,0]));backend.uniform2f(backend.uniform(c,'u_strokePatternTextureSampleSize'),20,20);backend.uniform1f(backend.uniform(c,'u_strokePatternTextureSpacing'),style.strokePatternTextureSpacing||20);backend.uniform1f(backend.uniform(c,'u_strokePatternTextureStartOffset'),style.strokePatternTextureStartOffset||0);backend.uniform1i(backend.uniform(c,'u_dashCount'),0);}else if(style.dashPattern?.length){const arr=new Float32Array(style.dashPattern);backend.uniform1fv(backend.uniform(c,'u_dashPattern'),arr);backend.uniform1i(backend.uniform(c,'u_dashCount'),arr.length);backend.uniform1f(backend.uniform(c,'u_dashOffset'),style.dashOffset||0);let total=0;for(const x of arr)total=Math.fround(total+Math.fround(x));backend.uniform1f(backend.uniform(c,'u_dashTotalLength'),total);}else backend.uniform1i(backend.uniform(c,'u_dashCount'),0);}
  updateReferences(backend,references,styleStore){ this._syncPatternTextures(references,styleStore,this.resource.resourceManager); this.resource.references=references; this.resource.styleStore=styleStore; this._buildDrawStream(references,this.resource.resourceManager); return {referenceRebuilds:1,referenceUploadBytes:0}; }
  _syncPhysical(){const rm=this.resource.resourceManager,v=rm.getStreamLayoutVersion('line.instances');if(v===this.resource.layoutVersion)return;for(const [id,p] of this.resource.physical){const range=rm.getStreamRange('line.instances',id);if(range)p.startInstance=range.offset/32;}this.resource.layoutVersion=v;}
  buildBatches(references){this._syncPhysical();const batches=[];for(const r of references){const p=this.resource.physical.get(r.geometryId);if(!p)continue;const worldOffsetX=Number(r.sceneWorldOffsetX??0);const prev=batches[batches.length-1];if(prev&&prev.styleId===r.styleId&&prev.worldOffsetX===worldOffsetX&&prev.endInstance===p.startInstance){prev.instanceCount+=p.instanceCount;prev.endInstance+=p.instanceCount;}else batches.push({styleId:r.styleId,worldOffsetX,startInstance:p.startInstance,endInstance:p.startInstance+p.instanceCount,instanceCount:p.instanceCount});}return batches;}
  // A Draw Packet represents the precompiled commands for exactly one
  // RenderSchedule pass. Cache on the pass array's identity: the Kernel creates
  // new arrays when references/schedule change; updateReferences explicitly
  // invalidates the cache when geometry or streams change without a new pass.
  _drawPacket(references){
    if(this.resource.drawStream){
      this._syncDrawStreamLayout();
      const pass=Array.isArray(references)?references:[];
      const cached=this._drawPackets.get(pass);
      if(cached && cached.streamName==='line.drawInstances'){
        this.drawPacketStats.hits++;
        return cached;
      }
      const batches=[],seen=new Map(),stream=this.resource.drawStream;
      // Replay the caller's *ordered* pass, never the insertion order of the
      // globally grouped style buffers. Adjacent slices can be coalesced only
      // if they are also physically adjacent and use identical uniforms.
      for(const r of pass){
        if(r.visible===false)continue;
        let slices=stream.refSlices.get(r),identity=r;
        if(!slices){identity=sliceSignature(r);slices=stream.refSlicesBySignature.get(identity);}
        if(!slices?.length){
          throw new Error(`Line draw pass contains an uncompiled reference: ${String(r.id??r.geometryId)}`);
        }
        const used=seen.get(identity)||0;
        seen.set(identity,used+1);
        const slice=slices[Math.min(used,slices.length-1)];
        const group=stream.batches.get(slice.key);
        if(!group)continue;
        const startInstance=group.startInstance+slice.relativeStart;
        const prev=batches[batches.length-1];
        if(prev&&prev.key===slice.key&&(group.flatGpu?prev.startInstance+prev.spanVertices===startInstance:prev.startInstance+prev.instanceCount===startInstance)){
          prev.instanceCount+=slice.instanceCount+(group.flatGpu?1:0);
          if(group.flatGpu)prev.spanVertices+=slice.spanVertices;
        }else{
          batches.push({key:slice.key,styleId:group.styleId,worldOffsetX:group.worldOffsetX,
            startInstance,instanceCount:slice.instanceCount,spanVertices:slice.spanVertices,gpuJoin:group.gpuJoin,flatGpu:group.flatGpu,streamName:group.streamName});
        }
      }
      const packet={streamName:'line.drawInstances',batches};
      this._drawPackets.set(pass,packet);
      this.drawPacketStats.builds++;
      return packet;
    }
    // Fallback batches depend on physical locations. Preserve their existing
    // semantics (and resynchronization) until draw-stream mode becomes active.
    return {streamName:'line.instances',batches:this.buildBatches(references)};
  }
  draw(backend,references,{scale=1,frame=null}={}){
    const gl=backend.gl,{batches,streamName}=this._drawPacket(references);
    let mode=null,c=null;
    for(const batch of batches){
      const flat=batch.flatGpu===true,gpuJoin=batch.gpuJoin===true;
      const nextMode=flat?'flat':gpuJoin?'gpu':'cpu';
      if(mode!==nextMode){
        c=backend.program(flat?'solid-line-flat-vertices':gpuJoin?'solid-line-gpu-join':'full-line',flat?lineFlatVertexShader:gpuJoin?lineGpuJoinVertexShader:lineVertexShader,lineFragmentShader);
        backend.useProgram(c.program);backend.disableAllAttribs?.();
        backend.bindBuffer(gl.ARRAY_BUFFER,this.resource.quadVB);
        backend.bindFloatAttrib(c,'a_quadCorner',2,0,0,0);
        backend.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.resource.quadIB);
        mode=nextMode;
      }
      backend.bindBuffer(gl.ARRAY_BUFFER,this.resource.resourceManager.getStreamBuffer(batch.streamName||streamName));
      if(flat){
        const stride=12,off=batch.startInstance*stride;
        backend.bindFloatAttrib(c,'a_prevPoint',2,stride,off,1);
        backend.bindFloatAttrib(c,'a_segmentStart',2,stride,off+12,1);
        backend.bindFloatAttrib(c,'a_segmentEnd',2,stride,off+24,1);
        backend.bindFloatAttrib(c,'a_nextPoint',2,stride,off+36,1);
        backend.bindFloatAttrib(c,'a_startFlags',1,stride,off+20,1);
        backend.bindFloatAttrib(c,'a_endFlags',1,stride,off+32,1);
      }else{
        const stride=32;let off=batch.startInstance*stride;
        for(const [name,size] of gpuJoin?GPU_JOIN_ATTRS:ATTRS){backend.bindFloatAttrib(c,name,size,stride,off,1);off+=size*4;}
      }
      this.setUniforms(backend,c,this.resource.styleStore.get(batch.styleId),scale,frame);
      backend.uniform1f(backend.uniform(c,'u_worldOffsetX'),batch.worldOffsetX||0);
      backend.drawElementsInstanced(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0,batch.instanceCount);
    }
  }
}
