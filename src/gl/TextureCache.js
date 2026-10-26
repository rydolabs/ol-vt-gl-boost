export class TextureCache {
  constructor(owner, { enabled=true, softBytes=32*1024*1024, hardBytes=48*1024*1024, retainReleased=true }={}) {
    this.owner=owner; this.config={enabled,softBytes,hardBytes:Math.max(hardBytes,softBytes),retainReleased};
    this.backend=null; this.entries=new Map(); this.frameIndex=0;
    this.gpuBytes=0; this.peakGpuBytes=0; this.uploadBytes=0; this.texImageCount=0;
    this.cacheHits=0; this.cacheMisses=0; this.evictionCount=0; this.evictedBytes=0; this.refcountErrors=0;
  }
  attachBackend(backend){ this.backend=backend||null; return this; }
  handleContextLost(){ for(const e of this.entries.values())e.texture=null; this.gpuBytes=0; this.backend=null; }
  restoreBackend(backend){ this.backend=backend; for(const e of this.entries.values()) if(e.refCount>0||e.cached) this._createTexture(e); return this; }
  _estimateBytes(width,height,bytesPerPixel=4){ return Math.max(1,width|0)*Math.max(1,height|0)*Math.max(1,bytesPerPixel|0); }
  _createTexture(entry){
    const backend=this.backend;if(!backend) return null;
    const source=entry.sourceFactory();
    const tex=backend.createTextureResource(source,{minFilter:entry.minFilter,magFilter:entry.magFilter,wrapS:entry.wrapS,wrapT:entry.wrapT});
    entry.texture=tex; this.gpuBytes+=entry.bytes; this.peakGpuBytes=Math.max(this.peakGpuBytes,this.gpuBytes);
    this.uploadBytes+=entry.bytes; this.texImageCount++; return tex;
  }
  _deleteTexture(entry){ if(!entry?.texture)return false; if(this.backend)this.backend.deleteTextureResource(entry.texture); entry.texture=null; this.gpuBytes-=entry.bytes; return true; }
  _evictUntil(targetBytes, protectedKey=null){
    const candidates=[...this.entries.values()].filter(e=>e.refCount===0&&e.texture&&e.key!==protectedKey).sort((a,b)=>(a.lastUsedFrame-b.lastUsedFrame)||String(a.key).localeCompare(String(b.key)));
    const evicted=[];for(const e of candidates){if(this.gpuBytes<=targetBytes)break;if(this._deleteTexture(e)){e.cached=false;this.evictionCount++;this.evictedBytes+=e.bytes;evicted.push(e.key);}}
    return evicted;
  }
  _prepare(bytes,key){
    if(!this.config.enabled)return [];
    const hard=this.config.hardBytes;
    if(this.gpuBytes+bytes<=hard)return [];
    const soft=Math.min(this.config.softBytes,Math.max(0,hard-bytes));
    return this._evictUntil(soft,key);
  }
  acquire(key, descriptor){
    this.frameIndex++;
    let e=this.entries.get(key);
    if(!e){
      const bytes=descriptor.bytes??this._estimateBytes(descriptor.width,descriptor.height,descriptor.bytesPerPixel??4);
      e={key,width:descriptor.width,height:descriptor.height,bytes,sourceFactory:descriptor.sourceFactory,minFilter:descriptor.minFilter,magFilter:descriptor.magFilter,wrapS:descriptor.wrapS,wrapT:descriptor.wrapT,texture:null,refCount:0,cached:false,lastUsedFrame:this.frameIndex};
      this.entries.set(key,e);
    }
    if(!e.texture){this._prepare(e.bytes,key);this._createTexture(e);this.cacheMisses++;}else this.cacheHits++;
    e.refCount++;e.cached=false;e.lastUsedFrame=this.frameIndex;return e.texture;
  }
  release(key){
    this.frameIndex++;const e=this.entries.get(key);if(!e||e.refCount<=0){this.refcountErrors++;throw new Error(`release of unreferenced texture: ${key}`)}
    e.refCount--;e.lastUsedFrame=this.frameIndex;
    if(e.refCount===0){if(this.config.retainReleased)e.cached=!!e.texture;else this._deleteTexture(e)}
    return e.refCount;
  }
  get(key){const e=this.entries.get(key);if(!e)return null;e.lastUsedFrame=this.frameIndex;return e.texture;}
  enforceBudget(){
    if(!this.config.enabled)return {enforced:false,evicted:[]};
    const hard=this.config.hardBytes;
    if(this.gpuBytes<=hard)return {enforced:false,evicted:[]};
    return {enforced:true,evicted:this._evictUntil(Math.min(this.config.softBytes,hard))};
  }
  stats(){let resident=0,cached=0;for(const e of this.entries.values()){if(e.refCount>0&&e.texture)resident++;else if(e.texture)cached++;}return {residentTextures:resident,cachedTextures:cached,entryCount:this.entries.size,gpuBytes:this.gpuBytes,peakGpuBytes:this.peakGpuBytes,uploadBytes:this.uploadBytes,texImageCount:this.texImageCount,cacheHits:this.cacheHits,cacheMisses:this.cacheMisses,evictionCount:this.evictionCount,evictedBytes:this.evictedBytes,refcountErrors:this.refcountErrors,config:{...this.config}};}
}
