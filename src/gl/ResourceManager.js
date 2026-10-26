import { GeometryAllocator } from './GeometryAllocator.js';
import { TextureCache } from './TextureCache.js';
import { GpuBudgetController } from './GpuBudgetController.js';
import { MaintenanceScheduler } from './MaintenanceScheduler.js';

function toFloat32Bytes(value) {
  if (value == null) return new Uint8Array(16);
  let floats;
  if (value instanceof Float32Array) floats = value;
  else if (ArrayBuffer.isView(value)) floats = new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 4));
  else if (Array.isArray(value)) {
    const flat = value.flat ? value.flat(Infinity) : value;
    floats = new Float32Array(flat);
  } else floats = new Float32Array(4);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength).slice();
}

function geometryPayload(g) {
  if (!g) return new Uint8Array(16);
  if (g.binary && g.positions) {
    const base = Math.max(0, g.offset || 0) * 2;
    const count = Math.max(0, g.count || 0) * 2;
    const view = g.positions.subarray ? g.positions.subarray(base, base + count) : Array.from(g.positions).slice(base, base + count);
    return toFloat32Bytes(view);
  }
  if (g.data != null) return toFloat32Bytes(g.data);
  if (g.coords != null) {
    // NeutralGeometryCompiler emits line coords as [[x,y], ...]. Avoid the
    // recursive Array.flat(Infinity) + temporary JS number array on this hot
    // path, retaining the generic converter for irregular/external geometry.
    const coords=g.coords;
    if(Array.isArray(coords) && coords.length){
      let xyPairs=true;
      for(let i=0;i<coords.length;i++){
        const p=coords[i];
        if(!Array.isArray(p) || p.length!==2 || !(0 in p) || !(1 in p) || Array.isArray(p[0]) || Array.isArray(p[1])){xyPairs=false;break;}
      }
      if(xyPairs){
        const packed=new Float32Array(coords.length*2);
        for(let i=0;i<coords.length;i++){
          packed[i*2]=coords[i][0];packed[i*2+1]=coords[i][1];
        }
        // The new ArrayBuffer is solely owned by this payload.
        return new Uint8Array(packed.buffer);
      }
    }
    return toFloat32Bytes(coords);
  }
  return new Uint8Array(16);
}

function paddedPayload(payload) {
  if (payload.byteLength >= 16) return payload;
  const out = new Uint8Array(16);
  out.set(payload);
  return out;
}


class PackedGpuStream {
  constructor(owner, name, { initialCapacity = 64 * 1024, alignment = 16, target = 'ARRAY_BUFFER', gpuCapacityHeadroomFactor = 1, gpuHeadroomCapBytes = 8 * 1024 * 1024 } = {}) {
    this.owner=owner; this.name=name; this.target=target; this.allocator=new GeometryAllocator({initialCapacity,alignment});
    this.resources=new Map(); this.gpuBuffer=null; this.gpuBufferCapacity=0; this.layoutVersion=0;
    this.gpuUploadBytes=0; this.gpuCompactionUploadBytes=0; this.gpuRelocationCount=0; this.gpuBufferReallocations=0;this.unchangedUpserts=0;this.uploadsSkippedBytes=0;
    this.uploadBatchDepth=0; this.pendingUploadIds=new Set(); this.uploadBatchCalls=0; this.uploadBatchResources=0;
    // Opt-in only: GPU storage may exceed the CPU arena without changing any
    // allocation offsets or the CPU allocator growth policy. This costs VRAM.
    this.gpuCapacityHeadroomFactor=Number.isFinite(gpuCapacityHeadroomFactor) ? Math.max(1,Math.min(4,gpuCapacityHeadroomFactor)) : 1;
    this.gpuHeadroomCapBytes=Math.max(0,Math.min(8*1024*1024,Number(gpuHeadroomCapBytes)||0));
    this.gpuCarryReuploadBytes=0; this.gpuChangedUploadBytes=0; this.gpuFullReallocationEvents=0;this.ownedAdoptions=0;this.payloadCopyBytes=0;
  }
  _gpuDesiredCapacity(){
    const cpu=this.allocator.capacity;
    if(this.gpuCapacityHeadroomFactor===1)return cpu;
    const extra=Math.min(this.gpuHeadroomCapBytes,Math.ceil(cpu*(this.gpuCapacityHeadroomFactor-1)));
    return Math.ceil((cpu+extra)/(64*1024))*(64*1024);
  }
  _createBuffer(capacity,count=true){
    const backend=this.owner.backend;if(!backend)return null;const old=this.gpuBuffer,next=backend.createBufferResource(this.target,capacity,'DYNAMIC_DRAW');
    this.gpuBuffer=next;this.gpuBufferCapacity=capacity;if(count)this.gpuBufferReallocations++;if(old)backend.deleteBufferResource(old);return next;
  }
  _ensureCapacity(){
    const backend=this.owner.backend;if(!backend)return;const capacity=this.allocator.capacity;if(this.gpuBuffer&&(this.gpuCapacityHeadroomFactor>1 ? this.gpuBufferCapacity>=capacity : this.gpuBufferCapacity===capacity))return;
    this._createBuffer(this._gpuDesiredCapacity(),true);for(const r of this.resources.values()){if(!r.allocation)continue;backend.uploadBufferResource(this.target,this.gpuBuffer,r.allocation.offset,r.payload);this.gpuUploadBytes+=r.payload.byteLength;}
  }
  // During a prepare/update pass, all ranges are allocated on the CPU first.
  // GPU storage is committed once before the draw. No draw ever sees a pending range.
  beginUploadBatch(){ this.uploadBatchDepth++; }
  endUploadBatch(){
    if(this.uploadBatchDepth<=0) throw new Error(`unbalanced upload batch: ${this.name}`);
    if(--this.uploadBatchDepth===0) this.flushUploadBatch();
  }
  _uploadRanges(resources){
    const backend=this.owner.backend;
    if(!backend || !this.gpuBuffer || !resources.length)return 0;
    const ordered=resources.filter(r=>r?.allocation && r.payload?.byteLength).sort((a,b)=>a.allocation.offset-b.allocation.offset);
    const maxBatchBytes=2*1024*1024;
    let uploaded=0;
    for(let i=0;i<ordered.length;){
      const first=ordered[i],start=first.allocation.offset;
      let end=start+first.payload.byteLength,allocatedEnd=start+first.allocation.size,j=i+1;
      while(j<ordered.length){
        const r=ordered[j],candidateEnd=r.allocation.offset+r.payload.byteLength;
        // Merge only successive *allocated* regions. Never overwrite an
        // unchanged allocation in a gap: its GPU bytes must remain intact.
        if(r.allocation.offset!==allocatedEnd || candidateEnd-start>maxBatchBytes)break;
        end=candidateEnd; allocatedEnd=r.allocation.offset+r.allocation.size;j++;
      }
      let bytes;
      if(j===i+1) bytes=first.payload;
      else{
        bytes=new Uint8Array(end-start);
        for(let k=i;k<j;k++){
          const r=ordered[k];bytes.set(r.payload,r.allocation.offset-start);
        }
      }
      backend.uploadBufferResource(this.target,this.gpuBuffer,start,bytes);
      uploaded+=bytes.byteLength;this.uploadBatchCalls++;
      i=j;
    }
    this.gpuUploadBytes+=uploaded;this.uploadBatchResources+=ordered.length;
    return uploaded;
  }
  flushUploadBatch(){
    if(this.uploadBatchDepth>0)return;
    if(!this.owner.backend){this.pendingUploadIds.clear();return;}
    const resized=!this.gpuBuffer || (this.gpuCapacityHeadroomFactor>1 ? this.gpuBufferCapacity<this.allocator.capacity : this.gpuBufferCapacity!==this.allocator.capacity);
    if(resized){this._createBuffer(this._gpuDesiredCapacity(),true);this.gpuFullReallocationEvents++;}
    const selected=resized ? [...this.resources.values()] : [...this.pendingUploadIds].map(id=>this.resources.get(id));
    // Never count an updated resource as 'reuploaded because of growth'. It
    // needs upload even if the GPU buffer could be reused. Track those apart.
    if(resized)this.gpuCarryReuploadBytes+=selected.filter(r=>r?.allocation&&!this.pendingUploadIds.has(r.id)).reduce((n,r)=>n+r.payload.byteLength,0);
    this.gpuChangedUploadBytes+=selected.filter(r=>r?.allocation&&this.pendingUploadIds.has(r.id)).reduce((n,r)=>n+r.payload.byteLength,0);
    // After reallocation the old GPU buffer is gone: every live resource must
    // be written, not just resources added in this batch.
    this._uploadRanges(selected);
    this.pendingUploadIds.clear();
  }
  upsert(id,data,{assumeOwnedData=false}={}){
    // Ownership handoff is OPT-IN. Callers must relinquish mutation rights to
    // data and its backing buffer for the lifetime of the stream resource.
    // Default callers remain isolated by a defensive copy.
    const bytes=data instanceof Uint8Array?data:new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
    let r=this.resources.get(id);
    if(r&&r.payload.byteLength===bytes.byteLength){
      let same=true;for(let i=0;i<bytes.byteLength;i++)if(r.payload[i]!==bytes[i]){same=false;break;}
      if(same){this.unchangedUpserts++;this.uploadsSkippedBytes+=bytes.byteLength;return {...r.allocation};}
    }
    const payload=assumeOwnedData?bytes:bytes.slice();
    if(assumeOwnedData)this.ownedAdoptions++;else this.payloadCopyBytes+=bytes.byteLength;
    if(!r){r={id,payload,allocation:this.allocator.allocate(id,payload.byteLength)};this.resources.set(id,r);this.layoutVersion++;}
    else {
      r.payload=payload;
      if(payload.byteLength!==r.allocation.requestedSize){const z=this.allocator.resize(id,payload.byteLength);r.allocation=z.allocation;this.layoutVersion++;}
    }
    if(this.uploadBatchDepth>0){
      this.pendingUploadIds.add(id);
    } else {
      this._ensureCapacity();
      if(this.owner.backend){this.owner.backend.uploadBufferResource(this.target,this.gpuBuffer,r.allocation.offset,r.payload);this.gpuUploadBytes+=r.payload.byteLength;}
    }
    return {...r.allocation};
  }
  remove(id){const r=this.resources.get(id);if(!r)return false;this.allocator.free(id);this.resources.delete(id);this.pendingUploadIds.delete(id);this.layoutVersion++;return true;}
  retainOnly(ids){const keep=ids instanceof Set?ids:new Set(ids);for(const id of [...this.resources.keys()])if(!keep.has(id))this.remove(id);}
  get(id){const r=this.resources.get(id);return r?{...r.allocation}:null;}
  compact({force=false,threshold=.45}={}){
    const before=this.allocator.stats();if(!force&&before.fragmentationRatio<threshold)return {compacted:false,moves:[],movedBytes:0,gpuUploadedBytes:0};
    const result=this.allocator.compact();if(result.moves.length)this.layoutVersion++;let gpuUploadedBytes=0;
    if(this.owner.backend&&result.moves.length){this._createBuffer(this._gpuDesiredCapacity(),false);for(const r of this.resources.values()){r.allocation=this.allocator.get(r.id);this.owner.backend.uploadBufferResource(this.target,this.gpuBuffer,r.allocation.offset,r.payload);gpuUploadedBytes+=r.payload.byteLength;}this.gpuUploadBytes+=gpuUploadedBytes;this.gpuCompactionUploadBytes+=gpuUploadedBytes;this.gpuRelocationCount++;}
    else for(const r of this.resources.values())r.allocation=this.allocator.get(r.id);
    return {compacted:true,...result,gpuUploadedBytes};
  }
  createIncrementalCompactionPlan(){ return this.allocator.createCompactionPlan(); }
  applyIncrementalCompactionMoves(moves,{final=false,totalMovedBytes=0}={}){
    if(!moves?.length){ if(final)this.allocator.finishIncrementalCompaction(totalMovedBytes); return {movedBytes:0,gpuUploadedBytes:0}; }
    const applied=this.allocator.applyCompactionMoves(moves); this.layoutVersion++; let gpuUploadedBytes=0;
    for(const move of moves){
      const r=this.resources.get(move.id); if(!r)continue; r.allocation=this.allocator.get(r.id);
      if(this.owner.backend&&r.payload){this.owner.backend.uploadBufferResource(this.target,this.gpuBuffer,r.allocation.offset,r.payload);gpuUploadedBytes+=r.payload.byteLength;}
    }
    this.gpuUploadBytes+=gpuUploadedBytes; this.gpuCompactionUploadBytes+=gpuUploadedBytes;
    if(final){this.allocator.finishIncrementalCompaction(totalMovedBytes); if(this.owner.backend&&totalMovedBytes>0)this.gpuRelocationCount++;}
    return {movedBytes:applied.movedBytes,gpuUploadedBytes};
  }
  stats(){return {...this.allocator.stats(),target:this.target,layoutVersion:this.layoutVersion,gpuBufferCapacity:this.gpuBufferCapacity,gpuUploadBytes:this.gpuUploadBytes,gpuCompactionUploadBytes:this.gpuCompactionUploadBytes,gpuRelocationCount:this.gpuRelocationCount,gpuBufferReallocations:this.gpuBufferReallocations,gpuCarryReuploadBytes:this.gpuCarryReuploadBytes,gpuChangedUploadBytes:this.gpuChangedUploadBytes,gpuFullReallocationEvents:this.gpuFullReallocationEvents,gpuCapacityHeadroomFactor:this.gpuCapacityHeadroomFactor,unchangedUpserts:this.unchangedUpserts,uploadsSkippedBytes:this.uploadsSkippedBytes,ownedAdoptions:this.ownedAdoptions,payloadCopyBytes:this.payloadCopyBytes,uploadBatchCalls:this.uploadBatchCalls,uploadBatchResources:this.uploadBatchResources};}
}

export class ResourceManager {
  constructor({ allocator = null, initialCapacity, alignment, compactionThreshold = 0.45, autoCompaction = null, memoryBudget = null, textureBudget = null, gpuMemoryBudget = null, maintenance = null, backend = null } = {}) {
    this.allocator = allocator || new GeometryAllocator({ initialCapacity, alignment });
    this.compactionThreshold = compactionThreshold;
    this.autoCompaction = { enabled: true, fragmentationThreshold: compactionThreshold, minWasteBytes: 1024, cooldownFrames: 60, incremental: true, moveBudgetBytesPerFrame: 16 * 1024, minStableFrames: 2, ...(autoCompaction||{}) };
    this.memoryBudget = { enabled: false, softBytes: 48 * 1024 * 1024, hardBytes: 64 * 1024 * 1024, retainReleased: true, trimHeadroomBytes: 4096, ...(memoryBudget||{}) };
    { const g=gpuMemoryBudget||{}; const hard=g.hardBytes??128*1024*1024; this.gpuMemoryBudget={enabled:g.enabled??false,hardBytes:hard,softBytes:g.softBytes==null?Math.floor(hard*0.8):Math.min(g.softBytes,hard)}; }
    this.gpuBudgetController = new GpuBudgetController(this, this.gpuMemoryBudget);
    this.maintenanceScheduler = new MaintenanceScheduler(maintenance||{});
    this.textureCache = new TextureCache(this, {enabled:true,...(textureBudget||{})});
    if (this.memoryBudget.hardBytes < this.memoryBudget.softBytes) this.memoryBudget.hardBytes = this.memoryBudget.softBytes;
    this.frameIndex = 0; this.lastAutoCompactionFrame = -Infinity; this.autoCompactionCount = 0;
    this.arenaStability = new Map();
    this.incrementalCompaction = null; this.incrementalCompactionStarted = 0; this.incrementalCompactionCompleted = 0; this.incrementalCompactionCancelled = 0; this.incrementalCompactionSteps = 0; this.incrementalCompactionMovedBytes = 0; this.incrementalCompactionUploadedBytes = 0; this.incrementalCompactionMaxStepBytes = 0;
    this.evictionCount = 0; this.evictedBytes = 0; this.cacheHits = 0; this.cacheMisses = 0; this.budgetEnforcementCount = 0; this.budgetPreflightCount = 0; this.budgetPreflightCompactions = 0; this.budgetTrimmedBytes = 0;
    this.resources = new Map();
    this.tiles = new Map();
    this.refcountErrors = 0;
    this.gpuMovedBytes = 0;
    this.backend = null;
    this.gpuBuffer = null;
    this.gpuBufferCapacity = 0;
    this.gpuUploadBytes = 0;
    this.gpuCompactionUploadBytes = 0;
    this.gpuRelocationCount = 0;
    this.gpuBufferReallocations = 0;
    this.geometryBatchDepth = 0;
    this.geometryBatchPending = new Set();
    this.geometryBatchUploadCalls = 0;
    this.geometryBatchResources = 0;
    // Activated only for LineRenderer implementations that use dedicated GPU
    // instance streams. Other ResourceManager callers retain legacy semantics.
    this.lineGeometryStreamOnly = false;
    this.skippedLineGeometryRegistrations = 0;
    this.reusedRegisteredGeometryAcquisitions = 0;
    this.layoutVersion = 0;
    this.streams = new Map();
    if (backend) this.attachBackend(backend);
  }

  attachBackend(backend) {
    this.backend = backend || null;
    if (this.backend) { this._ensureGpuCapacity(); for (const stream of this.streams.values()) stream._ensureCapacity(); }
    this.textureCache.attachBackend(this.backend);
    return this;
  }

  handleContextLost() {
    this.backend=null; this.gpuBuffer=null; this.gpuBufferCapacity=0;this.geometryBatchPending.clear();
    for(const stream of this.streams.values()){stream.gpuBuffer=null;stream.gpuBufferCapacity=0;stream.pendingUploadIds.clear();}
    this.textureCache.handleContextLost();
  }

  restoreBackend(backend) {
    this.backend=backend; this._ensureGpuCapacity();
    for(const stream of this.streams.values()) stream._ensureCapacity();
    this.textureCache.restoreBackend(backend); return this;
  }

  _createGpuBuffer(capacity, countReallocation = true) {
    if (!this.backend) return null;
    const old = this.gpuBuffer;
    const next = this.backend.createBufferResource('ARRAY_BUFFER', capacity, 'DYNAMIC_DRAW');
    this.gpuBuffer = next;
    this.gpuBufferCapacity = capacity;
    if (countReallocation) this.gpuBufferReallocations++;
    if (old) this.backend.deleteBufferResource(old);
    return next;
  }

  _ensureGpuCapacity() {
    if (!this.backend) return;
    // A line-only scene has no users of the generic vertex buffer. Avoid
    // allocating even the empty default arena until a Polygon/Point needs it.
    if (this.allocator.stats().allocatedBytes === 0) return;
    const capacity = this.allocator.capacity;
    if (this.gpuBuffer && this.gpuBufferCapacity === capacity) return;
    this._createGpuBuffer(capacity, true);
    for (const resource of this.resources.values()) {
      if (!resource.allocation || !resource.payload) continue;
      this.backend.uploadBufferResource('ARRAY_BUFFER', this.gpuBuffer, resource.allocation.offset, resource.payload);
      this.gpuUploadBytes += resource.payload.byteLength;
    }
  }

  _flushGeometryUploadBatch() {
    if(this.geometryBatchDepth>0)return;
    const backend=this.backend;
    if(!backend){this.geometryBatchPending.clear();return;}
    if(this.allocator.stats().allocatedBytes===0){this.geometryBatchPending.clear();return;}
    const resized=!this.gpuBuffer||this.gpuBufferCapacity!==this.allocator.capacity;
    if(resized)this._createGpuBuffer(this.allocator.capacity,true);
    const all=resized ? [...this.resources.values()] : [...this.geometryBatchPending].map(id=>this.resources.get(id));
    const ordered=all.filter(r=>r?.allocation&&r.payload?.byteLength).sort((a,b)=>a.allocation.offset-b.allocation.offset);
    const maxBatchBytes=2*1024*1024;
    let uploaded=0;
    for(let i=0;i<ordered.length;){
      const first=ordered[i],start=first.allocation.offset;
      let end=start+first.payload.byteLength,allocatedEnd=start+first.allocation.size,j=i+1;
      while(j<ordered.length){
        const r=ordered[j],candidateEnd=r.allocation.offset+r.payload.byteLength;
        if(r.allocation.offset!==allocatedEnd||candidateEnd-start>maxBatchBytes)break;
        end=candidateEnd;allocatedEnd=r.allocation.offset+r.allocation.size;j++;
      }
      let bytes;
      if(j===i+1)bytes=first.payload;
      else{
        bytes=new Uint8Array(end-start);
        for(let k=i;k<j;k++){
          const r=ordered[k];bytes.set(r.payload,r.allocation.offset-start);
        }
      }
      backend.uploadBufferResource('ARRAY_BUFFER',this.gpuBuffer,start,bytes);
      uploaded+=bytes.byteLength;this.geometryBatchUploadCalls++;
      i=j;
    }
    this.gpuUploadBytes+=uploaded;this.geometryBatchResources+=ordered.length;
    this.geometryBatchPending.clear();
  }
  _uploadResource(resource) {
    if (this.geometryBatchDepth>0) {
      if(resource?.allocation && resource.payload)this.geometryBatchPending.add(resource.geometryId);
      return resource?.payload?.byteLength||0;
    }
    if (!this.backend || !resource?.allocation || !resource.payload) return 0;
    this._ensureGpuCapacity();
    this.backend.uploadBufferResource('ARRAY_BUFFER', this.gpuBuffer, resource.allocation.offset, resource.payload);
    this.gpuUploadBytes += resource.payload.byteLength;
    return resource.payload.byteLength;
  }

  ensureGeometry(geometryId, geometry, { registeredUpsert = false } = {}) {
    const resource = this.resources.get(geometryId);
    const usesGenericGpu = !(this.lineGeometryStreamOnly && geometry?.type === 'line');
    // LineRenderer's shader reads line.instances / line.drawInstances, never
    // ResourceManager.gpuBuffer. Keep the same ID, refcount and tile lifetime,
    // but do not serialize, allocate or upload an unused second vertex copy.
    if (!usesGenericGpu) {
      this.skippedLineGeometryRegistrations++;
      if (!resource) {
        const record = { geometryId, bytes: 0, payload: null, refCount: 0,
          allocation: null, cached: false, gpuManaged: false,
          lastUsedFrame: this.frameIndex,
          registeredGeometry: registeredUpsert ? geometry : null };
        this.resources.set(geometryId, record);
        return record;
      }
      if (resource.gpuManaged !== false && resource.allocation) {
        this.allocator.free(geometryId);
        this.layoutVersion++;
      }
      resource.bytes = 0;
      resource.payload = null;
      resource.allocation = null;
      resource.cached = false;
      resource.gpuManaged = false;
      resource.registeredGeometry = registeredUpsert ? geometry : null;
      return resource;
    }
    // Registration is the authoritative content-validation boundary. The
    // subsequent reference acquisition can reuse this record without packing
    // the exact same geometry a second time.
    const payload = paddedPayload(geometryPayload(geometry));
    const bytes = payload.byteLength;
    if (!resource) {
      const record = { geometryId, bytes, payload, refCount: 0,
        allocation: null, cached: false, gpuManaged: true,
        lastUsedFrame: this.frameIndex,
        registeredGeometry: registeredUpsert ? geometry : null };
      this.resources.set(geometryId, record);
      return record;
    }
    const wasGpuManaged = resource.gpuManaged !== false;
    resource.gpuManaged = true;
    resource.registeredGeometry = registeredUpsert ? geometry : null;
    let unchanged = wasGpuManaged && resource.bytes === bytes;
    if (unchanged) {
      for (let i = 0; i < bytes; i++) {
        if (resource.payload[i] !== payload[i]) { unchanged = false; break; }
      }
    }
    if (unchanged) return resource;
    resource.bytes = bytes;
    resource.payload = payload;
    if (resource.allocation && bytes !== resource.allocation.requestedSize) {
      const r = this.allocator.resize(geometryId, bytes);
      resource.allocation = r.allocation;
      this.layoutVersion++;
      this.gpuMovedBytes += r.movedBytes;
      if (this.geometryBatchDepth === 0) this._ensureGpuCapacity();
    }
    if (resource.allocation && resource.refCount > 0) this._uploadResource(resource);
    // An ID changing geometry type while still referenced is unusual but must
    // restore the generic allocation rather than leave a missing vertex range.
    if (!wasGpuManaged && resource.refCount > 0 && !resource.allocation) {
      this._prepareBudgetForAllocation(bytes);
      resource.allocation = this.allocator.allocate(geometryId, bytes);
      this.layoutVersion++;
      if (this.geometryBatchDepth === 0) this._ensureGpuCapacity();
      this._uploadResource(resource);
    }
    return resource;
  }

  _prepareBudgetForAllocation(requestedBytes) {
    const cfg = this.memoryBudget;
    if (!cfg.enabled) return { prepared: false, evicted: [] };
    const aligned = Math.ceil(Math.max(1, requestedBytes) / this.allocator.alignment) * this.allocator.alignment;
    let stats = this.allocator.stats();
    let evicted = [];
    let prepared = false;
    if (stats.allocatedBytes + aligned > cfg.hardBytes) {
      this.budgetPreflightCount++;
      prepared = true;
      const target = Math.max(0, cfg.softBytes - aligned);
      evicted.push(...this._evictCachedGeometryUntil(target));
      stats = this.allocator.stats();
    }
    if (stats.largestFreeBlock < aligned && stats.freeBytes >= aligned) {
      if (!prepared) this.budgetPreflightCount++;
      prepared = true;
      evicted.push(...this._evictCachedUntilContiguous(aligned));
      stats = this.allocator.stats();
    }
    let moves = [], movedBytes = 0, gpuUploadedBytes = 0;
    if (stats.largestFreeBlock < aligned && stats.freeBytes >= aligned) {
      const c = this.allocator.compact();
      this.budgetPreflightCompactions++;
      moves = c.moves; movedBytes = c.movedBytes;
      for (const move of moves) {
        const resource = this.resources.get(move.id);
        if (resource) resource.allocation = this.allocator.get(move.id);
      }
      if (moves.length) { this.layoutVersion++; this.gpuMovedBytes += movedBytes; }
      if (this.backend && moves.length) gpuUploadedBytes = this._rebuildGeometryGpuBufferAfterLayoutChange();
    }
    return { prepared, evicted, moves, movedBytes, gpuUploadedBytes };
  }

  acquireGeometry(geometryId, geometry) {
    const known = this.resources.get(geometryId);
    // The Kernel just validated this immutable GeometryStore version in
    // upsertGeometry(). Direct ResourceManager users still take the ordinary
    // validation path, including in-place data edits.
    const cached = known && known.registeredGeometry === geometry;
    const resource = cached ? known : this.ensureGeometry(geometryId, geometry);
    if (cached) this.reusedRegisteredGeometryAcquisitions++;
    if (resource.refCount === 0 && resource.gpuManaged !== false) {
      if (resource.allocation) {
        this.cacheHits++;
      } else {
        this._prepareBudgetForAllocation(resource.bytes);
        resource.allocation = this.allocator.allocate(geometryId, resource.bytes);
        this.cacheMisses++;
        this.layoutVersion++;
        if(this.geometryBatchDepth===0)this._ensureGpuCapacity();
        this._uploadResource(resource);
      }
      resource.cached = false;
    }
    resource.refCount++;
    resource.lastUsedFrame = this.frameIndex;
    this.gpuBudgetController.enforce();
    return { ...resource, payload: undefined, allocation: resource.allocation ? { ...resource.allocation } : null };
  }

  releaseGeometry(geometryId) {
    const resource = this.resources.get(geometryId);
    if (!resource || resource.refCount <= 0) {
      this.refcountErrors++;
      throw new Error(`release of unreferenced geometry: ${geometryId}`);
    }
    resource.refCount--;
    resource.lastUsedFrame = this.frameIndex;
    if (resource.refCount === 0) {
      if (this.memoryBudget.enabled && this.memoryBudget.retainReleased) {
        resource.cached = !!resource.allocation;
      } else {
        if (resource.allocation) { this.allocator.free(geometryId); this.layoutVersion++; }
        resource.allocation = null;
        resource.cached = false;
      }
    }
    return resource.refCount;
  }

  setTile(tileId, geometryIds, geometryStore) {
    const next = new Set(geometryIds);
    const prev = this.tiles.get(tileId) || new Set();
    for (const id of prev) if (!next.has(id)) this.releaseGeometry(id);
    for (const id of next) if (!prev.has(id)) this.acquireGeometry(id, geometryStore.get(id));
    if (next.size) this.tiles.set(tileId, next); else this.tiles.delete(tileId);
  }

  removeTile(tileId) {
    const prev = this.tiles.get(tileId);
    if (!prev) return;
    for (const id of prev) this.releaseGeometry(id);
    this.tiles.delete(tileId);
  }

  syncReferences(references, geometryStore) {
    // Only batch when the normal budget preflight/eviction paths are disabled.
    // In constrained modes, preserve their existing eager GPU-write ordering.
    const batchGpuUploads=!this.memoryBudget.enabled&&!this.gpuMemoryBudget.enabled;
    if(batchGpuUploads)this.geometryBatchDepth++;
    try {
    const nextTiles = new Map();
    const global = new Set();
    for (const r of references) {
      // OL snapshot references expose tileKey, while some direct kernel callers
      // supply tileId. Accept both without mutating draw references.
      const key = r.tileId == null && r.tileKey == null ? '__global__' : String(r.tileId ?? r.tileKey);
      let ids = nextTiles.get(key); if (!ids) nextTiles.set(key, ids = new Set());
      ids.add(r.geometryId); global.add(key);
    }
    for (const tileId of [...this.tiles.keys()]) if (!global.has(tileId)) this.removeTile(tileId);
    for (const [tileId, ids] of nextTiles) this.setTile(tileId, ids, geometryStore);
    } finally {
      if(batchGpuUploads && --this.geometryBatchDepth===0)this._flushGeometryUploadBatch();
    }
  }

  compact({ force = false } = {}) {
    const before = this.allocator.stats();
    if (!force && before.fragmentationRatio < this.compactionThreshold) return { compacted: false, moves: [], movedBytes: 0, gpuUploadedBytes: 0 };
    const result = this.allocator.compact();
    for (const move of result.moves) {
      const resource = this.resources.get(move.id);
      if (resource) resource.allocation = this.allocator.get(move.id);
    }
    this.gpuMovedBytes += result.movedBytes;
    if (result.moves.length) this.layoutVersion++;

    let gpuUploadedBytes = 0;
    if (this.backend && result.moves.length) {
      // WebGL1 has no buffer-to-buffer copy. Rebuild a same-size packed buffer
      // from the CPU shadow so overlapping moves are always safe.
      this._createGpuBuffer(this.allocator.capacity, false);
      for (const resource of this.resources.values()) {
        if (!resource.allocation || !resource.payload) continue;
        this.backend.uploadBufferResource('ARRAY_BUFFER', this.gpuBuffer, resource.allocation.offset, resource.payload);
        gpuUploadedBytes += resource.payload.byteLength;
      }
      this.gpuUploadBytes += gpuUploadedBytes;
      this.gpuCompactionUploadBytes += gpuUploadedBytes;
      this.gpuRelocationCount++;
    }
    const streams={};
    for(const [name,stream] of this.streams) streams[name]=stream.compact({force,threshold:this.compactionThreshold});
    return { compacted: true, ...result, gpuUploadedBytes, streams };
  }

  _evictCachedGeometryUntil(targetAllocatedBytes) {
    const candidates = [...this.resources.values()]
      .filter(r => r.refCount === 0 && r.allocation)
      .sort((a, b) => (a.lastUsedFrame - b.lastUsedFrame) || String(a.geometryId).localeCompare(String(b.geometryId)));
    let stats = this.allocator.stats();
    const evicted = [];
    for (const resource of candidates) {
      if (stats.allocatedBytes <= targetAllocatedBytes) break;
      const freed = this.allocator.free(resource.geometryId);
      resource.allocation = null;
      resource.cached = false;
      this.layoutVersion++;
      this.evictionCount++;
      this.evictedBytes += freed.requestedSize;
      evicted.push({ geometryId: resource.geometryId, bytes: freed.requestedSize });
      stats = this.allocator.stats();
    }
    return evicted;
  }

  _evictCachedUntilContiguous(requiredBytes) {
    let stats = this.allocator.stats();
    if (stats.largestFreeBlock >= requiredBytes) return [];
    const candidates = [...this.resources.values()]
      .filter(r => r.refCount === 0 && r.allocation)
      .sort((a, b) => (a.lastUsedFrame - b.lastUsedFrame) || (b.allocation.size - a.allocation.size));
    const evicted = [];
    for (const resource of candidates) {
      const freed = this.allocator.free(resource.geometryId);
      resource.allocation = null;
      resource.cached = false;
      this.layoutVersion++;
      this.evictionCount++;
      this.evictedBytes += freed.requestedSize;
      evicted.push({ geometryId: resource.geometryId, bytes: freed.requestedSize });
      stats = this.allocator.stats();
      if (stats.largestFreeBlock >= requiredBytes) break;
    }
    return evicted;
  }

  _rebuildGeometryGpuBufferAfterLayoutChange({ countRelocation = true } = {}) {
    if (!this.backend) return 0;
    this._createGpuBuffer(this.allocator.capacity, false);
    let uploaded = 0;
    for (const resource of this.resources.values()) {
      if (!resource.allocation || !resource.payload) continue;
      this.backend.uploadBufferResource('ARRAY_BUFFER', this.gpuBuffer, resource.allocation.offset, resource.payload);
      uploaded += resource.payload.byteLength;
    }
    this.gpuUploadBytes += uploaded;
    if (countRelocation) {
      this.gpuCompactionUploadBytes += uploaded;
      this.gpuRelocationCount++;
    }
    return uploaded;
  }

  enforceMemoryBudget() {
    const cfg = this.memoryBudget;
    if (!cfg.enabled) return { enforced: false, reason: 'disabled', evicted: [], trimmedBytes: 0 };
    let before = this.allocator.stats();
    if (before.allocatedBytes <= cfg.hardBytes && before.capacity <= cfg.hardBytes) {
      return { enforced: false, reason: 'within-budget', evicted: [], trimmedBytes: 0 };
    }
    this.budgetEnforcementCount++;
    const evicted = this._evictCachedGeometryUntil(cfg.softBytes);
    let compactResult = { moves: [], movedBytes: 0 };
    if (evicted.length || this.allocator.stats().fragmentationRatio > 0) {
      compactResult = this.allocator.compact();
      for (const move of compactResult.moves) {
        const resource = this.resources.get(move.id);
        if (resource) resource.allocation = this.allocator.get(move.id);
      }
      if (compactResult.moves.length) {
        this.layoutVersion++;
        this.gpuMovedBytes += compactResult.movedBytes;
      }
    }
    const minCapacity = Math.min(this.allocator.initialCapacity, cfg.hardBytes);
    const packed = this.allocator.stats();
    const desiredHeadroom = before.capacity > cfg.hardBytes ? Math.max(cfg.trimHeadroomBytes, cfg.hardBytes - packed.allocatedBytes) : cfg.trimHeadroomBytes;
    const trim = this.allocator.trim({ minCapacity, headroomBytes: desiredHeadroom });
    if (trim.trimmed) {
      this.layoutVersion++;
      this.budgetTrimmedBytes += trim.freedBytes;
    }
    let gpuUploadedBytes = 0;
    if ((compactResult.moves.length || trim.trimmed) && this.backend) gpuUploadedBytes = this._rebuildGeometryGpuBufferAfterLayoutChange();
    const after = this.allocator.stats();
    return { enforced: true, evicted, trimmedBytes: trim.freedBytes, compacted: compactResult.moves.length > 0, movedBytes: compactResult.movedBytes, gpuUploadedBytes, before, after, overHardBudget: after.capacity > cfg.hardBytes || after.allocatedBytes > cfg.hardBytes };
  }

  _arenaNeedsCompaction(stats) {
    if (!stats || stats.allocationCount < 2 || stats.freeBytes <= 0) return false;
    const wasteBytes = stats.freeBytes - stats.largestFreeBlock;
    return stats.fragmentationRatio >= this.autoCompaction.fragmentationThreshold && wasteBytes >= this.autoCompaction.minWasteBytes;
  }

  _arenaStableFrames(name,stats){
    const version=stats?.topologyVersion ?? 0, prev=this.arenaStability.get(name);
    const stable=prev&&prev.version===version ? prev.stable+1 : 0;
    this.arenaStability.set(name,{version,stable}); return stable;
  }

  _incrementalArena(name){
    if(name==='geometry') return { allocator:this.allocator, plan:()=>this.allocator.createCompactionPlan() };
    const stream=this.streams.get(name); return stream?{allocator:stream.allocator,plan:()=>stream.createIncrementalCompactionPlan(),stream}:null;
  }

  _startIncrementalCompaction(name){
    const arena=this._incrementalArena(name); if(!arena)return null; const plan=arena.plan();
    if(!plan.moves.length)return null;
    this.incrementalCompaction={name,topologyVersion:plan.topologyVersion,moves:plan.moves,cursor:0,plannedMovedBytes:plan.movedBytes,movedBytes:0,uploadedBytes:0,startedFrame:this.frameIndex,steps:0,replans:0};
    this.incrementalCompactionStarted++; this.lastAutoCompactionFrame=this.frameIndex;
    return this.incrementalCompaction;
  }

  _cancelIncrementalCompaction(reason='stale'){
    const prior=this.incrementalCompaction; if(prior)this.incrementalCompactionCancelled++; this.incrementalCompaction=null; return {cancelled:!!prior,reason,prior};
  }

  _stepIncrementalCompaction(){
    const session=this.incrementalCompaction; if(!session)return {compacted:false,reason:'no-session'};
    const arena=this._incrementalArena(session.name); if(!arena)return this._cancelIncrementalCompaction('missing-arena');
    if(arena.allocator.topologyVersion!==session.topologyVersion)return this._cancelIncrementalCompaction('topology-changed');
    const budget=Math.max(1,this.autoCompaction.moveBudgetBytesPerFrame|0), chunk=[]; let bytes=0;
    while(session.cursor<session.moves.length){const move=session.moves[session.cursor];if(chunk.length&&bytes+move.size>budget)break;chunk.push(move);bytes+=move.size;session.cursor++;if(bytes>=budget)break;}
    const final=session.cursor>=session.moves.length; let applied;
    if(session.name==='geometry'){
      const a=this.allocator.applyCompactionMoves(chunk); let gpuUploadedBytes=0;
      for(const move of chunk){const r=this.resources.get(move.id);if(!r)continue;r.allocation=this.allocator.get(move.id);if(this.backend&&r.payload){this.backend.uploadBufferResource('ARRAY_BUFFER',this.gpuBuffer,r.allocation.offset,r.payload);gpuUploadedBytes+=r.payload.byteLength;}}
      if(chunk.length){this.layoutVersion++;this.gpuMovedBytes+=a.movedBytes;} this.gpuUploadBytes+=gpuUploadedBytes;this.gpuCompactionUploadBytes+=gpuUploadedBytes;
      if(final){const total=session.movedBytes+a.movedBytes;this.allocator.finishIncrementalCompaction(total);if(this.backend&&total>0)this.gpuRelocationCount++;}
      applied={movedBytes:a.movedBytes,gpuUploadedBytes};
    }else applied=arena.stream.applyIncrementalCompactionMoves(chunk,{final,totalMovedBytes:session.movedBytes+chunk.reduce((n,m)=>n+m.size,0)});
    session.steps++;session.movedBytes+=applied.movedBytes;session.uploadedBytes+=applied.gpuUploadedBytes;this.incrementalCompactionSteps++;this.incrementalCompactionMovedBytes+=applied.movedBytes;this.incrementalCompactionUploadedBytes+=applied.gpuUploadedBytes;this.incrementalCompactionMaxStepBytes=Math.max(this.incrementalCompactionMaxStepBytes,applied.movedBytes);
    const snapshot={...session,remainingMoves:session.moves.length-session.cursor,stepMovedBytes:applied.movedBytes,stepUploadedBytes:applied.gpuUploadedBytes,done:final}; delete snapshot.moves;
    if(final){this.incrementalCompactionCompleted++;this.autoCompactionCount++;this.incrementalCompaction=null;}
    return {compacted:true,incremental:true,trigger:session.name,...snapshot};
  }

  maybeCompact() {
    this.frameIndex++;
    this.maintenanceScheduler.beginFrame(this.frameIndex);
    const budgetTimed=this.maintenanceScheduler.measure('budget',()=>this.enforceMemoryBudget());
    const textureTimed=this.maintenanceScheduler.measure('textureBudget',()=>this.textureCache.enforceBudget());
    const gpuTimed=this.maintenanceScheduler.measure('gpuBudget',()=>this.gpuBudgetController.enforce());
    const budget=budgetTimed.result, textureBudget=textureTimed.result, gpuBudget=gpuTimed.result;
    const telemetry=()=>this.maintenanceScheduler.stats();
    if (!this.autoCompaction.enabled) return { compacted:false, reason:'disabled', budget, textureBudget, gpuBudget, maintenance:telemetry() };

    if(this.incrementalCompaction){
      const permit=this.maintenanceScheduler.canContinueCompaction();
      if(!permit.allowed)return {compacted:false,incremental:true,pending:true,reason:`maintenance-${permit.reason}`,trigger:this.incrementalCompaction.name,budget,textureBudget,gpuBudget,maintenance:telemetry()};
      const timed=this.maintenanceScheduler.measure('compactionStep',()=>this._stepIncrementalCompaction(),{trigger:this.incrementalCompaction.name,continuation:true});
      return {...timed.result,automatic:true,frameIndex:this.frameIndex,compactionMs:timed.ms,budget,textureBudget,gpuBudget,maintenance:telemetry()};
    }

    if (this.frameIndex - this.lastAutoCompactionFrame < this.autoCompaction.cooldownFrames) return { compacted:false, reason:'cooldown', budget, textureBudget, gpuBudget, maintenance:telemetry() };
    const arenas = [{name:'geometry',stats:this.allocator.stats()}];
    for (const [name,stream] of this.streams) arenas.push({name,stats:stream.allocator.stats()});
    for(const a of arenas)a.stableFrames=this._arenaStableFrames(a.name,a.stats);
    const trigger = arenas.find(a => this._arenaNeedsCompaction(a.stats) && (!this.autoCompaction.incremental || a.stableFrames>=this.autoCompaction.minStableFrames));
    if (!trigger) return { compacted:false, reason:'below-threshold', budget, textureBudget, gpuBudget, maintenance:telemetry() };
    const permit=this.maintenanceScheduler.canCompact();
    if(!permit.allowed) return {compacted:false,reason:`maintenance-${permit.reason}`,trigger:trigger.name,budget,textureBudget,gpuBudget,maintenance:telemetry()};

    if(this.autoCompaction.incremental){
      const session=this._startIncrementalCompaction(trigger.name);
      if(!session)return {compacted:false,reason:'already-packed',trigger:trigger.name,budget,textureBudget,gpuBudget,maintenance:telemetry()};
      // Record the session start once for rate limiting; continuation steps use compactionStep.
      this.maintenanceScheduler.record('compaction',0,{trigger:trigger.name,incremental:true,sessionStart:true});
      const timed=this.maintenanceScheduler.measure('compactionStep',()=>this._stepIncrementalCompaction(),{trigger:trigger.name,continuation:false});
      return {...timed.result,automatic:true,frameIndex:this.frameIndex,compactionMs:timed.ms,budget,textureBudget,gpuBudget,maintenance:telemetry()};
    }

    const compactTimed=this.maintenanceScheduler.measure('compaction',()=>this.compact({force:true}),{trigger:trigger.name});
    const result=compactTimed.result; this.lastAutoCompactionFrame=this.frameIndex; this.autoCompactionCount++;
    return { ...result, automatic:true, trigger:trigger.name, frameIndex:this.frameIndex, compactionMs:compactTimed.ms, budget, textureBudget, gpuBudget, maintenance:telemetry() };
  }


  bufferGpuCapacityBytes() {
    let total=this.gpuBufferCapacity||0;
    for(const stream of this.streams.values()) total+=stream.gpuBufferCapacity||0;
    return total;
  }

  availableTextureBudgetBytes() {
    if(!this.gpuMemoryBudget.enabled) return this.textureCache?.config?.hardBytes ?? Infinity;
    return Math.max(0,this.gpuMemoryBudget.hardBytes-this.bufferGpuCapacityBytes());
  }

  acquireTexture(key,descriptor){ const t=this.textureCache.acquire(key,descriptor); this.gpuBudgetController.enforce(); return t; }
  releaseTexture(key){ return this.textureCache.release(key); }
  getTexture(key){ return this.textureCache.get(key); }

  getStream(name, options={}) {
    let stream=this.streams.get(name);
    if(!stream){stream=new PackedGpuStream(this,name,options);this.streams.set(name,stream);if(this.backend)stream._ensureCapacity();}
    return stream;
  }

  beginStreamUploadBatch(name,options={}) { this.getStream(name,options).beginUploadBatch(); }
  endStreamUploadBatch(name) { const s=this.streams.get(name); if(!s)throw new Error(`unknown stream batch: ${name}`); s.endUploadBatch(); }
  upsertStreamResource(name,id,data,options={}) { return this.getStream(name,options).upsert(id,data,options); }
  removeStreamResource(name,id) { return this.streams.get(name)?.remove(id) || false; }
  retainStreamResources(name,ids) { const s=this.streams.get(name); if(s)s.retainOnly(ids); }
  getStreamRange(name,id) { return this.streams.get(name)?.get(id) || null; }
  getStreamBuffer(name) { return this.streams.get(name)?.gpuBuffer || null; }
  getStreamLayoutVersion(name) { return this.streams.get(name)?.layoutVersion ?? 0; }

  getPhysicalRange(geometryId) { return this.resources.get(geometryId)?.allocation ? { ...this.resources.get(geometryId).allocation } : null; }

  stats() {
    const allocator = this.allocator.stats();
    let residentGeometry = 0, cachedGeometry = 0;
    for (const r of this.resources.values()) { if (r.refCount > 0) residentGeometry++; else if (r.allocation) cachedGeometry++; }
    const streamStats={}; for(const [name,stream] of this.streams) streamStats[name]=stream.stats();
    return {
      activeTiles: this.tiles.size,
      residentGeometry,
      cachedGeometry,
      ...allocator,
      geometryRefcountErrors: this.refcountErrors,
      gpuMovedBytes: this.gpuMovedBytes,
      gpuBufferCapacity: this.gpuBufferCapacity,
      gpuUploadBytes: this.gpuUploadBytes,
      gpuCompactionUploadBytes: this.gpuCompactionUploadBytes,
      gpuRelocationCount: this.gpuRelocationCount,
      gpuBufferReallocations: this.gpuBufferReallocations,
      geometryBatchUploadCalls: this.geometryBatchUploadCalls,
      geometryBatchResources: this.geometryBatchResources,
      lineGeometryStreamOnly: this.lineGeometryStreamOnly,
      skippedLineGeometryRegistrations: this.skippedLineGeometryRegistrations,
      reusedRegisteredGeometryAcquisitions: this.reusedRegisteredGeometryAcquisitions,
      layoutVersion: this.layoutVersion,
      frameIndex: this.frameIndex,
      autoCompactionCount: this.autoCompactionCount,
      lastAutoCompactionFrame: Number.isFinite(this.lastAutoCompactionFrame) ? this.lastAutoCompactionFrame : null,
      autoCompaction: {...this.autoCompaction},
      incrementalCompaction: this.incrementalCompaction ? {name:this.incrementalCompaction.name,cursor:this.incrementalCompaction.cursor,totalMoves:this.incrementalCompaction.moves.length,plannedMovedBytes:this.incrementalCompaction.plannedMovedBytes,movedBytes:this.incrementalCompaction.movedBytes,uploadedBytes:this.incrementalCompaction.uploadedBytes,startedFrame:this.incrementalCompaction.startedFrame,steps:this.incrementalCompaction.steps} : null,
      incrementalCompactionStarted: this.incrementalCompactionStarted,
      incrementalCompactionCompleted: this.incrementalCompactionCompleted,
      incrementalCompactionCancelled: this.incrementalCompactionCancelled,
      incrementalCompactionSteps: this.incrementalCompactionSteps,
      incrementalCompactionMovedBytes: this.incrementalCompactionMovedBytes,
      incrementalCompactionUploadedBytes: this.incrementalCompactionUploadedBytes,
      incrementalCompactionMaxStepBytes: this.incrementalCompactionMaxStepBytes,
      memoryBudget: {...this.memoryBudget},
      evictionCount: this.evictionCount,
      evictedBytes: this.evictedBytes,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      budgetEnforcementCount: this.budgetEnforcementCount,
      budgetPreflightCount: this.budgetPreflightCount,
      budgetPreflightCompactions: this.budgetPreflightCompactions,
      budgetTrimmedBytes: this.budgetTrimmedBytes,
      streams: streamStats,
      textures: this.textureCache.stats(),
      bufferGpuCapacityBytes: this.bufferGpuCapacityBytes(),
      totalTrackedGpuBytes: this.bufferGpuCapacityBytes()+this.textureCache.stats().gpuBytes,
      gpuMemoryBudget: {...this.gpuMemoryBudget},
      gpuBudgetController: this.gpuBudgetController.stats(),
      maintenance: this.maintenanceScheduler.stats(),
    };
  }
}
