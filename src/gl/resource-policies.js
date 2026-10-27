/** R67: cohesive GPU memory enforcement and maintenance policies, algorithms unchanged. */
export class GpuBudgetController {
  constructor(owner,{enabled=false,softBytes=null,hardBytes=128*1024*1024}={}){
    this.owner=owner; const soft=softBytes==null?Math.floor(hardBytes*0.8):Math.min(softBytes,hardBytes); this.config={enabled,softBytes:soft,hardBytes};
    this.enforcementCount=0; this.textureEvictions=0; this.geometryEvictions=0; this.lastResult=null;
  }
  totalBytes(){return this.owner.bufferGpuCapacityBytes()+this.owner.textureCache.stats().gpuBytes;}
  enforce(){
    const before=this.totalBytes(); if(!this.config.enabled||before<=this.config.hardBytes){return this.lastResult={enforced:false,before,after:before};}
    this.enforcementCount++; const target=this.config.softBytes;
    const texTarget=Math.max(0,target-this.owner.bufferGpuCapacityBytes());
    const texEvicted=this.owner.textureCache._evictUntil(texTarget); this.textureEvictions+=texEvicted.length;
    let geomEvicted=[];
    if(this.totalBytes()>this.config.hardBytes){
      const need=Math.max(0,this.owner.bufferGpuCapacityBytes()-(target-this.owner.textureCache.stats().gpuBytes));
      const alloc=this.owner.allocator.stats(); const targetAllocated=Math.max(0,alloc.allocatedBytes-need);
      geomEvicted=this.owner._evictCachedGeometryUntil(targetAllocated); this.geometryEvictions+=geomEvicted.length;
      if(geomEvicted.length){this.owner.enforceMemoryBudget();}
    }
    const after=this.totalBytes();
    return this.lastResult={enforced:true,before,after,texEvicted,geomEvicted,overHard:after>this.config.hardBytes};
  }
  stats(){return {...this.config,enforcementCount:this.enforcementCount,textureEvictions:this.textureEvictions,geometryEvictions:this.geometryEvictions,lastResult:this.lastResult};}
}

function nowMs(){ return globalThis.performance?.now ? globalThis.performance.now() : Date.now(); }
function percentile(values,p){ if(!values.length)return 0; const a=[...values].sort((x,y)=>x-y); const i=Math.min(a.length-1,Math.max(0,Math.ceil(p*a.length)-1)); return a[i]; }

export class MaintenanceScheduler {
  constructor({enabled=true,frameBudgetMs=1.5,compactionMinIntervalFrames=90,compactionWindowFrames=600,maxCompactionsPerWindow=4,sampleLimit=4096}={}){
    this.config={enabled,frameBudgetMs,compactionMinIntervalFrames,compactionWindowFrames,maxCompactionsPerWindow,sampleLimit};
    this.frameIndex=0; this.frameSpentMs=0; this.frameEvents=[]; this.events=[]; this.compactionFrames=[];
    this.rateLimitedCompactions=0; this.budgetDeferredCompactions=0; this.totalMaintenanceMs=0; this.maxFrameMaintenanceMs=0;
    this.counts={budget:0,textureBudget:0,gpuBudget:0,compaction:0,compactionStep:0};
  }
  beginFrame(frameIndex){ this.frameIndex=frameIndex; this.frameSpentMs=0; this.frameEvents=[]; this._pruneCompactions(frameIndex); }
  _pruneCompactions(frameIndex){ const min=frameIndex-this.config.compactionWindowFrames; while(this.compactionFrames.length&&this.compactionFrames[0]<=min)this.compactionFrames.shift(); }
  measure(kind,fn,details=null){ const t0=nowMs(); const result=fn(); const ms=Math.max(0,nowMs()-t0); this.record(kind,ms,details); return {result,ms}; }
  record(kind,ms,details=null){
    const e={frame:this.frameIndex,kind,ms,details}; this.frameEvents.push(e); this.events.push(e);
    if(this.events.length>this.config.sampleLimit)this.events.splice(0,this.events.length-this.config.sampleLimit);
    this.frameSpentMs+=ms; this.totalMaintenanceMs+=ms; this.maxFrameMaintenanceMs=Math.max(this.maxFrameMaintenanceMs,this.frameSpentMs);
    if(this.counts[kind]!=null)this.counts[kind]++;
    if(kind==='compaction')this.compactionFrames.push(this.frameIndex);
  }
  canContinueCompaction(){
    if(!this.config.enabled)return {allowed:true,reason:'disabled'};
    if(this.frameSpentMs>=this.config.frameBudgetMs){this.budgetDeferredCompactions++;return {allowed:false,reason:'frame-budget'};}
    return {allowed:true,reason:'ok'};
  }
  canCompact(){
    if(!this.config.enabled)return {allowed:true,reason:'disabled'};
    this._pruneCompactions(this.frameIndex);
    const last=this.compactionFrames.length?this.compactionFrames[this.compactionFrames.length-1]:-Infinity;
    if(this.frameIndex-last<this.config.compactionMinIntervalFrames){this.rateLimitedCompactions++;return {allowed:false,reason:'min-interval'};}
    if(this.compactionFrames.length>=this.config.maxCompactionsPerWindow){this.rateLimitedCompactions++;return {allowed:false,reason:'window-limit'};}
    if(this.frameSpentMs>=this.config.frameBudgetMs){this.budgetDeferredCompactions++;return {allowed:false,reason:'frame-budget'};}
    return {allowed:true,reason:'ok'};
  }
  stats(){
    const durations=this.events.map(e=>e.ms), frameTotals=new Map(); for(const e of this.events)frameTotals.set(e.frame,(frameTotals.get(e.frame)||0)+e.ms);
    const ft=[...frameTotals.values()];
    return {config:{...this.config},counts:{...this.counts},eventCount:this.events.length,totalMaintenanceMs:this.totalMaintenanceMs,maxFrameMaintenanceMs:this.maxFrameMaintenanceMs,p50OperationMs:percentile(durations,.50),p95OperationMs:percentile(durations,.95),p99OperationMs:percentile(durations,.99),p50FrameMaintenanceMs:percentile(ft,.50),p95FrameMaintenanceMs:percentile(ft,.95),p99FrameMaintenanceMs:percentile(ft,.99),compactionsInWindow:this.compactionFrames.length,rateLimitedCompactions:this.rateLimitedCompactions,budgetDeferredCompactions:this.budgetDeferredCompactions,lastFrameEvents:this.frameEvents.map(e=>({...e}))};
  }
}
