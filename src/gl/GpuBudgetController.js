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
