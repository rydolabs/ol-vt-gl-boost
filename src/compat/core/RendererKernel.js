import {expandPackedPathOrder} from './PackedPathOrder.js';
/**
 * Platform-neutral renderer orchestration kernel.
 *
 * This module intentionally imports nothing. Concrete stores, compiler,
 * renderers, resource manager and backend are injected by the composition root.
 * That keeps OpenLayers/WebGL implementation details outside the orchestration
 * layer and makes alternate adapters/backends possible without editing core flow.
 */
export class RendererKernel {
  constructor({
    backend,
    geometryStore,
    styleStore,
    compiler,
    dirtyTracker,
    referenceStore,
    resourceManager,
    renderers,
    renderSchedule = null,
  }) {
    if (!backend) throw new Error('RendererKernel requires backend');
    if (!geometryStore || !styleStore || !compiler || !dirtyTracker || !referenceStore || !resourceManager) {
      throw new Error('RendererKernel requires injected stores/compiler/resourceManager');
    }
    if (!renderers?.polygon || !renderers?.line || !renderers?.point) {
      throw new Error('RendererKernel requires polygon/line/point renderers');
    }
    this.backend = backend;
    this.geometryStore = geometryStore;
    this.styleStore = styleStore;
    this.compiler = compiler;
    this.dirtyTracker = dirtyTracker;
    this.referenceStore = referenceStore;
    this.resourceManager = resourceManager;
    this.resourceManager.attachBackend?.(backend);
    this.referenceDirtyTypes = new Set();
    this.renderers = renderers;
    // Opt in only when the injected line renderer actually owns dedicated
    // instance streams; custom renderers preserve the generic-buffer behavior.
    this.resourceManager.lineGeometryStreamOnly = renderers.line.usesStandaloneGeometryStream === true;
    this.renderSchedule = renderSchedule;
    this.prepared = false;
    this.lastUpdateStats = this._zeroUpdateStats();
    this.frame = null;
    this._expandedCacheVersion = -1; this._expandedCache = null;
    this._orderedCacheVersion = -1; this._orderedCache = null;
    this._scheduleCacheVersion = -1; this._scheduleCache = null;
  }

  _zeroUpdateStats(){ return {geometryCompiles:0,rebuilds:0,patchedBytes:0,referenceRebuilds:0,referenceUploadBytes:0}; }
  setFrame(frame){ this.frame=frame||null; return this.frame; }
  get references(){ return this.referenceStore.getAll(); }
  upsertGeometry(key, geometry) {
    const {id,created}=this.geometryStore.upsert(key, geometry);
    this.resourceManager.ensureGeometry(id, this.geometryStore.get(id), { registeredUpsert: true });
    if(this.prepared) this.dirtyTracker.mark(id);
    return id;
  }
  invalidateGeometry(id){ if(this.geometryStore.get(id)) this.dirtyTracker.mark(id); }
  internStyle(style) { return this.styleStore.intern(style); }
  setReferences(references){
    const __t=performance.now();
    const changed=this.referenceStore.set(references);
    if(changed.size){ this._expandedCacheVersion=-1; this._expandedCache=null; this._orderedCacheVersion=-1; this._orderedCache=null; this._scheduleCacheVersion=-1; this._scheduleCache=null; }
    // If the reference signatures did not change, the resource tile sets
    // cannot have changed either. Avoid walking all geometries again.
    if(changed.size)this.resourceManager.syncReferences(this.referenceStore.getAll(), this.geometryStore);
    if(this.prepared) for(const t of changed) this.referenceDirtyTypes.add(t);
    const __s=((globalThis.__m5Stage||={}).kernelSetReferences||={calls:0,totalMs:0,changedCalls:0});__s.calls++;__s.totalMs+=performance.now()-__t;if(changed.size)__s.changedCalls++;
    return changed;
  }
  // Expansion is a view of immutable published reference metadata. Both the
  // compiler and the draw scheduler consume the SAME ordered virtual paths.
  // Previously, a cold frame allocated the virtual views twice (e.g. 12,880
  // objects * 2 for four Seoul road tiles). Preserve order and contents.
  _expanded(references=this.references){
    if(references===this.references && this._expandedCacheVersion===this.referenceStore.version && this._expandedCache) return this._expandedCache;
    const expanded=expandPackedPathOrder(references);
    if(references===this.references){this._expandedCacheVersion=this.referenceStore.version;this._expandedCache=expanded;}
    return expanded;
  }
  _ordered(references=this.references){
    if(references===this.references && this._orderedCacheVersion===this.referenceStore.version && this._orderedCache) return this._orderedCache;
    const expanded=this._expanded(references);
    const ordered=this.compiler.order
      ? this.compiler.order(expanded,this.geometryStore,this.styleStore)
      : this.compiler.compile(expanded,this.geometryStore,this.styleStore).ordered;
    if(references===this.references){ this._orderedCacheVersion=this.referenceStore.version; this._orderedCache=ordered; }
    return ordered;
  }
  _byType(references=this.references){ const ordered=this._ordered(references), byType={polygon:[],line:[],point:[]}; for(const r of ordered) byType[r.geometryType].push(r); return {ordered,byType}; }
  prepare(references=this.references){
    if(references!==this.references) this.setReferences(references);
    const {byType}=this._byType();
    for(const type of ['polygon','line','point']){
      const seen=new Set(), entries=[];
      // All references, including invisible ones, may keep resident geometry.
      // Visibility/filter changes therefore rebuild only reference streams.
      for(const r of this.references) if(r.geometryType===type && !seen.has(r.geometryId)){ seen.add(r.geometryId); entries.push(this.geometryStore.get(r.geometryId)); }
      this.renderers[type].prepare(this.backend,entries,byType[type],this.styleStore,this.resourceManager);
    }
    this.dirtyTracker.clear(); this.referenceDirtyTypes.clear(); this.prepared=true; this.lastUpdateStats=this._zeroUpdateStats();
    return this;
  }
  _applyDirty(){
    const ids=this.dirtyTracker.consume(); if(!ids.length)return {geometryCompiles:0,rebuilds:0,patchedBytes:0};
    const rebuildTypes=new Set(); let geometryCompiles=0,patchedBytes=0;
    // In draw-stream mode, updates are incremental and the line.instances
    // arena can safely batch multiple dirty geometry uploads into one commit.
    const batchLine=!!this.renderers.line?.resource?.drawStream;
    if(batchLine)this.resourceManager.beginStreamUploadBatch('line.instances',{alignment:32});
    try {
      for(const id of ids){
        const g=this.geometryStore.get(id); if(!g)continue;
        const rr=this.renderers[g.type]; if(!rr)continue;
        const r=rr.updateGeometry(this.backend,g);
        geometryCompiles+=r.compiled||0; patchedBytes+=r.uploadedBytes||0;
        if(r.rebuild)rebuildTypes.add(g.type);
        if(r.referenceDirty)this.referenceDirtyTypes.add(g.type);
      }
    } finally {if(batchLine)this.resourceManager.endStreamUploadBatch('line.instances');}
    if(rebuildTypes.size){
      const {byType}=this._byType();
      for(const type of rebuildTypes){const seen=new Set(),entries=[];for(const r of this.references)if(r.geometryType===type&&!seen.has(r.geometryId)){seen.add(r.geometryId);entries.push(this.geometryStore.get(r.geometryId));}this.renderers[type].prepare(this.backend,entries,byType[type],this.styleStore,this.resourceManager);}
    }
    return {geometryCompiles,rebuilds:rebuildTypes.size,patchedBytes};
  }
  _applyReferenceDirty(){
    if(!this.referenceDirtyTypes.size) return {referenceRebuilds:0,referenceUploadBytes:0};
    const {byType}=this._byType(); let referenceRebuilds=0,referenceUploadBytes=0;
    for(const type of this.referenceDirtyTypes){
      const rr=this.renderers[type]; if(!rr?.updateReferences) continue;
      const r=rr.updateReferences(this.backend,byType[type],this.styleStore,this.resourceManager)||{};
      referenceRebuilds+=r.referenceRebuilds||0; referenceUploadBytes+=r.referenceUploadBytes||0;
    }
    this.referenceDirtyTypes.clear();
    return {referenceRebuilds,referenceUploadBytes};
  }
  _schedule(references=this.references){
    if(references===this.references && this._scheduleCacheVersion===this.referenceStore.version && this._scheduleCache) return this._scheduleCache;
    let schedule;
    if(this.renderSchedule?.build) schedule=this.renderSchedule.build(this._expanded(references));
    else { const {byType}=this._byType(references); schedule=[{key:'__default',passes:byType,references:[...byType.polygon,...byType.line,...byType.point]}]; }
    if(references===this.references){ this._scheduleCacheVersion=this.referenceStore.version; this._scheduleCache=schedule; }
    return schedule;
  }
  _drawPrepared(){
    const schedule=this._schedule();
    for(const layer of schedule){
      const p=layer.passes||{};
      if(p.polygon?.length){this.backend.resetAttribDivisor(1);this.renderers.polygon.draw(this.backend,p.polygon,{frame:this.frame,sceneLayerKey:layer.key});}
      if(p.line?.length)this.renderers.line.draw(this.backend,p.line,{frame:this.frame,sceneLayerKey:layer.key});
      if(p.point?.length){this.backend.resetAttribDivisor(1);this.renderers.point.draw(this.backend,p.point,{frame:this.frame,sceneLayerKey:layer.key});}
    }
    return schedule;
  }
  render(references=this.references){
    if(references!==this.references) this.setReferences(references);
    const needsPrepare=!this.prepared;
    if(needsPrepare) this.prepare();
    this.backend.beginFrame();
    let geom={geometryCompiles:0,rebuilds:0,patchedBytes:0}, refs={referenceRebuilds:0,referenceUploadBytes:0};
    if(!needsPrepare){ geom=this._applyDirty(); refs=this._applyReferenceDirty(); }
    const autoCompaction=this.resourceManager.maybeCompact?.() || {compacted:false};
    this.lastUpdateStats={...geom,...refs,autoCompaction}; const schedule=this._drawPrepared();
    return { plan:{policy:this.compiler.policy,ordered:this._ordered(),schedule:schedule.map(x=>({key:x.key,zIndex:x.zIndex,sequence:x.sequence,styleZIndex:x.styleZIndex,counts:Object.fromEntries(Object.entries(x.passes||{}).map(([k,v])=>[k,v.length]))}))}, stats:{...this.backend.endFrame(),...this.lastUpdateStats} };
  }
  restoreAfterContextLoss(){ this.backend.restoreContext?.(); this.resourceManager.restoreBackend?.(this.backend); this.prepared=false; this.prepare(); return this; }
  renderFullRebuild(references=this.references){
    if(references!==this.references) this.setReferences(references);
    this.backend.beginFrame(); const t0=performance.now(); this.prepare(); const rebuildMs=performance.now()-t0; const schedule=this._drawPrepared();
    return { plan:{policy:this.compiler.policy,ordered:this._ordered(),schedule:schedule.map(x=>({key:x.key,zIndex:x.zIndex,sequence:x.sequence,styleZIndex:x.styleZIndex,counts:Object.fromEntries(Object.entries(x.passes||{}).map(([k,v])=>[k,v.length]))}))}, stats:{...this.backend.endFrame(),geometryCompiles:this.geometryStore.size,rebuilds:new Set(this.references.map(r=>r.geometryType)).size,patchedBytes:0,referenceRebuilds:3,referenceUploadBytes:0,rebuildMs} };
  }
}
