/** Reusable, bounded tile encoding Worker Pool; works with browser Worker and
 * Node worker_threads Worker via an injected createWorker factory.
 * `map` preserves input ordering; Workers may complete out-of-order.
 * Cache hits skip PBF decode AND Earcut. Cache key must encode source tile bytes
 * revision, layer, style, projection, clipping, join/fringe and tessellation mode.
 * No cache is used unless caller explicitly supplies cacheKey.
 */
const cloneEncoded=(value)=>({
  ...value,
  vertices:value.vertices.slice(),indices:value.indices.slice(),
  lineInstances:value.lineInstances.slice(),
  packets:value.packets.map(p=>({...p,style:structuredClone(p.style)})),
  counters:{...value.counters},bufferStats:{...value.bufferStats},
  clipExtent:value.clipExtent?.slice()??null,
});
const cloneAnswer=(answer)=>Array.isArray(answer.rows)?{
  ...answer,rows:answer.rows.map(row=>({...row,encoded:cloneEncoded(row.encoded),cpu:{...row.cpu}})),
  cpu:{...answer.cpu},
}: {...answer,encoded:cloneEncoded(answer.encoded),cpu:{...answer.cpu}};
const answerBytes=answer=>Array.isArray(answer.rows)
  ?answer.rows.reduce((sum,row)=>sum+row.encoded.byteLength,0)
  :answer.encoded.byteLength;

export class DirectTileWorkerPool{
  constructor({createWorker,size=2,maxCacheBytes=32*1024*1024,maxQueue=256}={}){
    if(typeof createWorker!=='function')throw Error('createWorker function is required');
    if(!Number.isInteger(size)||size<1||size>16)throw Error('size must be between 1 and 16');
    this.size=size;this.maxQueue=maxQueue;this.maxCacheBytes=maxCacheBytes;
    this.cache=new Map();this.cacheBytes=0;
    this.queue=[];this.inflight=new Map();this.slots=[];this.nextId=0;this.closed=false;
    this.stats={dispatched:0,cacheHits:0,workerErrors:0,completed:0};
    const promises=[];
    for(let i=0;i<size;i++){
      const worker=createWorker(i),slot={worker,busy:false,ready:false};this.slots.push(slot);
      const ready=new Promise((resolve,reject)=>{
        slot.resolveReady=resolve;slot.rejectReady=reject;
      });promises.push(ready);
      const onMessage=m=>{
        const message=m?.data??m;
        if(message?.type==='ready'){
          slot.ready=true;slot.resolveReady();this._pump();return;
        }
        if(message?.type!=='result')return;
        const job=this.inflight.get(message.id);
        if(!job)return;
        this.inflight.delete(message.id);slot.busy=false;
        if(message.ok){
          this.stats.completed++;
          const answer=message.answer;
          if(job.cacheKey)this._remember(job.cacheKey,answer);
          job.resolve(answer);
        }else{this.stats.workerErrors++;job.reject(Error(message.error||'Worker encoder failed'));}
        this._pump();
      };
      const onError=e=>this._failAll(Error('Tile Worker terminated: '+(e?.message||e)),slot);
      if(typeof worker.addEventListener==='function'){
        worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);
      }else{
        worker.on('message',onMessage);worker.on('error',onError);
        worker.on('exit',code=>{if(!this.closed&&code!==0)onError(Error('exit code '+code));});
      }
    }
    this.ready=Promise.all(promises).then(()=>this);
  }
  _failAll(reason,slot){
    if(this.closed)return;
    this.closed=true;
    for(const entry of this.slots){if(!entry.ready)entry.rejectReady(reason);}
    for(const job of this.queue.splice(0))job.reject(reason);
    for(const job of this.inflight.values())job.reject(reason);
    this.inflight.clear();this.stats.workerErrors++;
    for(const entry of this.slots)entry.worker.terminate?.();
  }
  _remember(key,value){
    if(this.maxCacheBytes<=0)return;
    const bytes=answerBytes(value);
    if(bytes>this.maxCacheBytes)return;
    if(this.cache.has(key)){
      const old=this.cache.get(key);this.cacheBytes-=old.byteLength;this.cache.delete(key);
    }
    const saved={answer:cloneAnswer(value),byteLength:bytes};this.cache.set(key,saved);this.cacheBytes+=saved.byteLength;
    while(this.cacheBytes>this.maxCacheBytes){
      const k=this.cache.keys().next().value,e=this.cache.get(k);
      this.cacheBytes-=e.byteLength;this.cache.delete(k);
    }
  }
  get(cacheKey){
    if(!cacheKey||!this.cache.has(cacheKey))return null;
    const entry=this.cache.get(cacheKey);this.cache.delete(cacheKey);this.cache.set(cacheKey,entry);
    this.stats.cacheHits++;
    return cloneAnswer(entry.answer);
  }
  _pump(){
    if(this.closed)return;
    for(const slot of this.slots){
      if(!slot.ready||slot.busy||!this.queue.length)continue;
      const job=this.queue.shift();slot.busy=true;this.inflight.set(job.id,job);
      this.stats.dispatched++;
      try{slot.worker.postMessage({id:job.id,task:job.task});}
      catch(error){slot.busy=false;this.inflight.delete(job.id);job.reject(error);}
    }
  }
  submit(task,{cacheKey=null}={}){
    if(this.closed)return Promise.reject(Error('Worker pool closed'));
    if(cacheKey){const cached=this.get(cacheKey);
      if(cached)return Promise.resolve({...cached,tileKey:task.tileKey,layer:task.layer,
        cpu:{decodeMs:0,encodeMs:0,bytes:answerBytes(cached)},cacheHit:true});}
    if(this.queue.length+this.inflight.size>=this.maxQueue)
      return Promise.reject(Error('Worker pool queue capacity exceeded'));
    return new Promise((resolve,reject)=>{this.queue.push({id:++this.nextId,task,resolve,reject,cacheKey});this._pump();});
  }
  map(tasks,{cacheKeys=null}={}){
    return Promise.all(tasks.map((task,index)=>this.submit(task,{cacheKey:cacheKeys?.[index]??null})));
  }
  clearCache(){this.cache.clear();this.cacheBytes=0;}
  async close(){
    if(this.closed)return;
    this.closed=true;const error=Error('Worker pool closed');
    for(const job of this.queue.splice(0))job.reject(error);
    for(const job of this.inflight.values())job.reject(error);
    this.inflight.clear();
    for(const slot of this.slots)if(!slot.ready)slot.rejectReady(error);
    await Promise.all(this.slots.map(s=>s.worker.terminate?.()));
    this.clearCache();
  }
}
export function createBrowserDirectTileWorkerPool({size=2,...options}={}){
  return new DirectTileWorkerPool({size,...options,
    createWorker:()=>new Worker(new URL('./DirectTileEncodeWorker.browser.js',import.meta.url),{type:'module'})});
}
