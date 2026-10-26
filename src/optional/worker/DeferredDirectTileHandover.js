/**
 * Experimental R45 app-level CPU-first / Worker-next tile handover.
 * The foreground OL source adapter always owns first paint. The caller must
 * supply a trustworthy resolveTask(tile,entries) for raw MVT bytes, a stable
 * source-layer/style pair in each scene layer, and matching encoder options.
 * No Worker results are installed after a layer, tile or style revision changes.
 * Failure is fail-closed: CPU tiles remain installed, and workers stay disabled.
 */
import {createBrowserDirectTileWorkerPool} from './DirectTileWorkerPool.js';
import {exactEncodedTile} from './EncodedTileExactGate.js';

const afterBrowserPaint=()=>new Promise(resolve=>{
  if(typeof requestAnimationFrame!=='function'){
    // Browser-specific feature: callers testing in Node inject afterPaint.
    resolve();return;
  }
  requestAnimationFrame(()=>requestAnimationFrame(resolve));
});
const keyOf=tile=>{
  const c=tile?.getTileCoord?.()??tile?.tileCoord;
  return c?`${c[0]}/${c[1]}/${c[2]}`:null;
};

export class DeferredDirectTileHandover{
  constructor({enabled=false,resolveTask,createPool=null,workerSize=2,afterPaint=afterBrowserPaint,
    maxPending=128,onError=null,getCpuEncoded=null,verifyRow=null}={}){
    if(enabled!==true)throw Error('R45 handover must be explicitly enabled');
    if(typeof resolveTask!=='function')throw Error('R45 needs a raw MVT resolveTask callback');
    if(!Number.isInteger(workerSize)||workerSize<1||workerSize>4)throw Error('Invalid R45 workerSize');
    this.resolveTask=resolveTask;this.createPool=createPool??(()=>createBrowserDirectTileWorkerPool({size:workerSize,maxCacheBytes:0}));
    this.afterPaint=afterPaint;this.maxPending=maxPending;this.onError=onError;this.getCpuEncoded=getCpuEncoded;
    this.pending=new Map();this.versions=new WeakMap();this.pool=null;
    this.closed=false;this.failed=false;this.paintSeen=false;this.flushing=false;this.paintSerial=0;
    this.metrics={cpuTiles:0,groups:0,decodeCalls:0,workerRows:0,staleDrops:0,parityRejects:0,skipped:0,failures:0};
    this.active=new Set();
  }
  enqueue({state,tile,tileKey=keyOf(tile),clipExtent=null}){
    if(this.closed||this.failed||!state||!tileKey||!tile||!state.adapter)return;
    const revisions=this.versions.get(state)??new Map();
    const version=(revisions.get(tileKey)??0)+1;revisions.set(tileKey,version);
    this.versions.set(state,revisions);this.metrics.cpuTiles++;
    let byKey=this.pending.get(state.source);
    if(!byKey){byKey=new Map();this.pending.set(state.source,byKey);}
    let record=byKey.get(tileKey);
    if(!record||record.tile!==tile){record={source:state.source,tile,tileKey,entries:new Map()};byKey.set(tileKey,record);}
    record.entries.set(state.key,{state,version,clipExtent});
    if(this.pendingCount>this.maxPending){
      // Never let unbounded scroll traffic exhaust retained PBF/tile references.
      const oldest=this.pending.keys().next().value;
      const entries=this.pending.get(oldest),first=entries.keys().next().value;
      entries.delete(first);if(entries.size===0)this.pending.delete(oldest);
      this.metrics.skipped++;
    }
  }
  get pendingCount(){let n=0;for(const m of this.pending.values())n+=m.size;return n;}
  invalidateTile(state,tileKey){
    const rev=this.versions.get(state);if(rev)rev.set(tileKey,(rev.get(tileKey)??0)+1);
    const group=this.pending.get(state.source),record=group?.get(tileKey);
    record?.entries.delete(state.key);if(record&&!record.entries.size)group.delete(tileKey);
    if(group&&!group.size)this.pending.delete(state.source);
  }
  invalidateState(state){
    const rev=this.versions.get(state);
    if(rev)for(const key of rev.keys())rev.set(key,rev.get(key)+1);
    for(const [source,byKey] of this.pending){for(const [key,record] of byKey){record.entries.delete(state.key);
      if(record.entries.size===0)byKey.delete(key);}if(!byKey.size)this.pending.delete(source);}
  }
  /** Called only once WebGL draw + endFrame completed; startup follows presentation. */
  afterDraw(){
    if(this.closed||this.failed)return;
    this.paintSerial++;
    if(!this.pendingCount)return;
    this.paintSeen=true;
    if(this.flushing)return;
    this.flushing=true;
    const startedAtPaint=this.paintSerial;
    const operation=(async()=>{
      await this.afterPaint();
      if(this.closed||this.failed)return;
      const batch=[...this.pending.values()].flatMap(m=>[...m.values()]);
      this.pending.clear();
      if(!batch.length)return;
      if(!this.pool){this.pool=this.createPool();}
      await this.pool.ready;
      for(const record of batch){
        if(this.closed||this.failed)break;
        await this._encode(record);
      }
    })().catch(error=>this._fail(error)).finally(()=>{
      this.flushing=false;this.active.delete(operation);
      // Drain CPU tiles which were painted during the previous Worker flight.
      if(this.pendingCount&&this.paintSerial>startedAtPaint&&!this.closed&&!this.failed)
        this.afterDraw();
    });
    this.active.add(operation);
  }
  _valid(entry,record){
    const {state,version}=entry;
    return !this.closed&&!this.failed&&state.source===record.source&&
      this.versions.get(state)?.get(record.tileKey)===version&&state.adapter?.tiles.get(record.tileKey)===record.tile;
  }
  async _encode(record){
    const entries=[...record.entries.values()].filter(e=>this._valid(e,record));
    if(!entries.length){this.metrics.staleDrops++;return;}
    // Layer opacity is applied during foreground ingestion but not by the
    // worker encoder. Fail safe until opacity parity is implemented.
    if(entries.some(e=>e.state.state?.opacity!==1)){this.metrics.skipped++;return;}
    const task=await this.resolveTask({source:record.source,tile:record.tile,tileKey:record.tileKey,
      entries:entries.map(e=>({key:e.state.key,layer:e.state.layer,clipExtent:e.clipExtent}))});
    if(!task){this.metrics.skipped++;return;}
    if(!Array.isArray(task.layers)||task.layers.length!==entries.length||
      !(task.bytes instanceof ArrayBuffer||ArrayBuffer.isView(task.bytes))||
      !Array.isArray(task.extent)||task.extent.length!==4)throw Error('R45 invalid PBF group task');
    for(const e of entries)if(JSON.stringify(e.clipExtent)!==JSON.stringify(task.extent)){
      this.metrics.skipped++;return;
    }
    if(entries.some(e=>!this._valid(e,record))){this.metrics.staleDrops++;return;}
    // Reject caller-provided identity mismatches, not just uncloneable styles.
    for(const layer of task.layers)if(typeof layer.layer!=='string'||!layer.layer||
      !layer.style||typeof layer.style!=='object'||Array.isArray(layer.style))
      throw Error('R45 requires constant structured-cloneable layer styles');
    const names=task.layers.map(x=>x.layer);
    const allowDuplicateLayers=new Set(names).size!==names.length;
    const result=await this.pool.submit({tileKey:record.tileKey,layers:task.layers,
      allowDuplicateLayers,bytes:task.bytes,extent:task.extent,options:task.options??{}});
    if(!Array.isArray(result.rows)||result.rows.length!==entries.length)
      throw Error('R45 Worker rows mismatch');
    if(entries.some(e=>!this._valid(e,record))){this.metrics.staleDrops++;return;}
    for(let i=0;i<entries.length;i++){
      const row=result.rows[i];
      if(row.layer!==task.layers[i].layer||!row.encoded||
        JSON.stringify(row.encoded.clipExtent)!==JSON.stringify(task.extent))
        throw Error('R45 Worker row identity/clip mismatch');
    }
    // A GPU byte-for-byte gate includes packet order/alpha and geometric buffers.
    // It rejects unexpected styles, projections and decoding differences.
    if(typeof this.getCpuEncoded!=='function'||entries.some((entry,i)=>
      !exactEncodedTile(this.getCpuEncoded(entry.state,record.tileKey),result.rows[i].encoded))){
      this.metrics.parityRejects++;return;
    }
    const committed=[];
    try{
      for(let i=0;i<entries.length;i++){
        const {state}=entries[i],row=result.rows[i];
        state.sink.replaceEncodedTile(record.tileKey,row.encoded,{featureCount:row.featureCount});
        committed.push(state);
      }
    }catch(error){
      // Synchronously restore any partially-installed worker groups on CPU.
      for(const state of committed){
        try{state.adapter.ingestTile(record.tile);}catch(e){this.onError?.(e);}
      }
      throw error;
    }
    this.metrics.groups++;this.metrics.decodeCalls+=result.decodeCalls??0;
    this.metrics.workerRows+=result.rows.length;
  }
  _fail(error){
    if(this.closed||this.failed)return;
    this.failed=true;this.metrics.failures++;
    this.pending.clear();
    try{this.onError?.(error);}catch{}
    void this.pool?.close?.().catch(()=>{});
  }
  async whenIdle(){while(this.active.size)await Promise.allSettled([...this.active]);}
  async close(){if(this.closed)return;this.closed=true;this.pending.clear();
    await this.pool?.close?.();await this.whenIdle();}
  snapshot(){return {...this.metrics,enabled:!this.closed&&!this.failed,pending:this.pendingCount};}
}