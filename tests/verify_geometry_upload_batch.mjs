import assert from 'node:assert/strict';
import {ResourceManager} from '../src/gl/ResourceManager.js';

function gpu(){
  const stats={calls:0,bytes:0};
  const backend={stats,createBufferResource(_target,cap){return {bytes:new Uint8Array(cap)};},
    deleteBufferResource(b){b.deleted=true;},uploadBufferResource(_target,b,offset,source){
      assert.ok(!b.deleted);const v=new Uint8Array(source.buffer,source.byteOffset,source.byteLength);
      assert.ok(offset>=0&&offset+v.byteLength<=b.bytes.length);b.bytes.set(v,offset);
      stats.calls++;stats.bytes+=v.byteLength;
    }};
  return backend;
}
const ea=gpu(),ba=gpu();
const e=new ResourceManager({backend:ea}), b=new ResourceManager({backend:ba});
const store=new Map();
for(let i=0;i<2500;i++)store.set(i,{data:new Float32Array(Array.from({length:8+2*(i%5)},(_,j)=>i+j/7))});
// Baseline: identical CPU tile transitions with eager per-geometry upload.
function syncEager(refs){
  const next=new Map();
  for(const r of refs){const key=String(r.tileKey??'__global__');let ids=next.get(key);if(!ids)next.set(key,ids=new Set());ids.add(r.geometryId);}
  for(const key of [...e.tiles.keys()])if(!next.has(key))e.removeTile(key);
  for(const [key,ids] of next)e.setTile(key,ids,store);
}
function compare(label){
  assert.deepEqual([...b.tiles.keys()].sort(),[...e.tiles.keys()].sort(),label+': tiles');
  for(const [id,r] of e.resources){
    const t=b.resources.get(id);
    assert.ok(t,`${label}: missing resource ${id}`);
    assert.equal(t.refCount,r.refCount,`${label}: refcount ${id}`);
    assert.deepEqual(t.allocation,r.allocation,`${label}: allocation ${id}`);
    if(r.allocation){const a=r.allocation.offset,end=a+r.payload.byteLength;
      assert.deepEqual(b.gpuBuffer.bytes.subarray(a,end),e.gpuBuffer.bytes.subarray(a,end),`${label}: GPU bytes ${id}`);
    }
  }
  assert.equal(b.gpuBufferCapacity,e.gpuBufferCapacity,label+': capacity');
}
function replay(label,refs){syncEager(refs);b.syncReferences(refs,store);compare(label);}
const refs=Array.from({length:2500},(_,i)=>({geometryId:i,tileKey:`t${i%8}`}));
replay('cold reference commit',refs);
const cold={eager:ea.stats.calls,batched:ba.stats.calls};
assert.ok(cold.batched<cold.eager/20,JSON.stringify(cold));
replay('same references',refs);
replay('remove half tile references',refs.filter(r=>r.geometryId%2===0));
replay('restore tile references',refs);
const revised=store.get(61);
revised.data=new Float32Array([100,101,102,103,104,105]);
e.ensureGeometry(61,revised);b.ensureGeometry(61,revised);
compare('live payload update outside batch');
// Unallocated geometry mutation is stored on the CPU and uploaded when acquired.
const extended=[...refs,{geometryId:2500,tileKey:'t0'}];
store.set(2500,{data:new Float32Array([33,44,55,66,77,88,99,111])});
replay('new geometry added',extended);
const be2=gpu(),ba2=gpu();e.handleContextLost();b.handleContextLost();e.restoreBackend(be2);b.restoreBackend(ba2);compare('context recovery');
// Budget mode must use eager semantics by design; it must not leave pending work.
const budgetBackend=gpu();const conservative=new ResourceManager({backend:budgetBackend,memoryBudget:{enabled:true,softBytes:10*1024*1024,hardBytes:20*1024*1024}});
conservative.syncReferences(refs.slice(0,64),store);
assert.equal(conservative.geometryBatchUploadCalls,0,'memory-budgeted arena uses original eager ordering');
assert.ok(budgetBackend.stats.calls>0);
console.log('PASS: geometry GPU contents equivalent to eager path across cold/growth, reference changes, live update, context loss and budget fallback');
console.log(JSON.stringify({coldGpuUploadCalls:cold,callReduction:Math.round(cold.eager/cold.batched),batchUploadResources:b.stats().geometryBatchResources}));
