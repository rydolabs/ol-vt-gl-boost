import assert from 'node:assert/strict';
import {ResourceManager} from '../src/gl/ResourceManager.js';
import {LineRenderer} from '../src/gl/LineRenderer.js';

function makeBackend(){
  const state={calls:0,bytes:0,deleted:0};
  const backend={
    state,
    createBufferResource(_target,capacity){return {bytes:new Uint8Array(capacity)};},
    deleteBufferResource(buf){buf.deleted=true;state.deleted++;},
    uploadBufferResource(_target,buf,offset,payload){
      assert.ok(!buf.deleted,'writes cannot target deleted buffers');
      const bytes=new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength);
      assert.ok(offset>=0 && offset+bytes.length<=buf.bytes.length,'out-of-bounds upload');
      buf.bytes.set(bytes,offset);state.calls++;state.bytes+=bytes.length;
    }
  };
  return backend;
}
const b0=makeBackend(),b1=makeBackend();
const eager=new ResourceManager({backend:b0});
const batched=new ResourceManager({backend:b1});
const name='line.instances', options={alignment:32};
const payload=(seed,len=8)=>new Float32Array(Array.from({length:len},(_,i)=>seed+i*0.25));
const action=(rm,op)=>{
  if(op[0]==='upsert')rm.upsertStreamResource(name,op[1],op[2],options);
  else if(op[0]==='remove')rm.removeStreamResource(name,op[1]);
  else if(op[0]==='retain')rm.retainStreamResources(name,new Set(op[1]));
};
function check(label){
  const e=eager.getStream(name),a=batched.getStream(name);
  assert.deepEqual([...e.resources.keys()].sort(),[...a.resources.keys()].sort(),`${label}: IDs`);
  for(const id of e.resources.keys()){
    const ea=e.get(id),aa=a.get(id);
    assert.deepEqual(aa,ea,`${label}: allocation for ${id}`);
    const r=e.resources.get(id), p=a.resources.get(id);
    assert.deepEqual(p.payload,r.payload,`${label}: shadow payload ${id}`);
    assert.deepEqual([...a.gpuBuffer.bytes.subarray(aa.offset,aa.offset+p.payload.byteLength)],
      [...e.gpuBuffer.bytes.subarray(ea.offset,ea.offset+r.payload.byteLength)],`${label}: GPU byte content ${id}`);
  }
  assert.equal(e.gpuBufferCapacity,a.gpuBufferCapacity,`${label}: buffer size`);
}
function replay(label,ops){
  for(const op of ops)action(eager,op);
  batched.beginStreamUploadBatch(name,options);
  try{for(const op of ops)action(batched,op);}finally{batched.endStreamUploadBatch(name);}
  check(label);
}
replay('cold upload / multiple capacity growths',Array.from({length:1500},(_,i)=>['upsert',`g${i}`,payload(i,8+(i%5)*8)]));
const initCalls={eager:b0.state.calls,batched:b1.state.calls};
assert.ok(initCalls.batched<initCalls.eager/20,JSON.stringify(initCalls));
// Dirty ranges must not overwrite the unchanged allocations between them.
const before=b1.state.calls;
replay('sparse partial updates',[['upsert','g1',payload(-1,16)],['upsert','g800',payload(-10,8)],['upsert','g1400',payload(-20,8)]]);
assert.ok(b1.state.calls>before);
replay('no-op publication',Array.from({length:200},(_,i)=>['upsert',`g${i}`,payload(i,8+(i%5)*8)]));
replay('resize, free and reallocate',[['remove','g2'],['remove','g3'],['upsert','g4',payload(4,128)],['upsert','g7',payload(7,2)],['upsert','g1501',payload(20,180)]]);
replay('retain subset',[['retain',Array.from({length:1502},(_,i)=>`g${i}`).filter((_,i)=>i%3===0)]]);
replay('recycle and rebuild',[...Array.from({length:300},(_,i)=>['upsert',`tail-${i}`,payload(i,10)])]);
// A restored GL context must recreate the full buffer from CPU shadows.
const freshA=makeBackend(),freshB=makeBackend();
eager.handleContextLost();batched.handleContextLost();
eager.restoreBackend(freshA);batched.restoreBackend(freshB);check('context restoration');
// Batches nest without flushing early.
const stream=batched.getStream(name);
const start=freshB.state.calls;
stream.beginUploadBatch();stream.beginUploadBatch();
stream.upsert('tail-10',new Uint8Array(new Float32Array([1,4,7,11,15,22,33,44,55,66]).buffer));
stream.endUploadBatch();assert.equal(freshB.state.calls,start,'inner batch cannot flush');
stream.endUploadBatch();assert.equal(freshB.state.calls,start+1,'outer batch flushes');
assert.throws(()=>stream.endUploadBatch(),/unbalanced/);

// LineRenderer is the real caller. Ensure prepare() uploads the same instances
// as an eager stream, while cutting the number of GPU writes.
const backend=makeBackend();backend.gl={ARRAY_BUFFER:1,ELEMENT_ARRAY_BUFFER:2,STATIC_DRAW:3,
  createBuffer(){return {};}};
backend.bindBuffer=()=>{};backend.bufferData=()=>{};
const rm=new ResourceManager({backend});
const line=new LineRenderer();
const geometries=Array.from({length:2048},(_,i)=>({id:i,version:1,coords:[[i,0],[i+1,1],[i+2,2],[i+3,3]]}));
line.prepare(backend,geometries,[],{get:()=>null},rm);
const ls=rm.getStream('line.instances');
assert.equal(ls.resources.size,2048);
assert.ok(ls.uploadBatchCalls<20,`line prepare should coalesce consecutive instance payloads (${ls.uploadBatchCalls} calls)`);
for(let i=0;i<geometries.length;i++){
  const r=ls.resources.get(i),a=ls.get(i);
  assert.deepEqual(ls.gpuBuffer.bytes.subarray(a.offset,a.offset+r.payload.length),r.payload,`line GPU geometry ${i}`);
}
console.log('PASS: stream GPU shadow equivalence, capacity growth, sparse writes, resize, removal, context recovery, nesting and LineRenderer prepare');
console.log(JSON.stringify({initialWrites:initCalls,initialReduction:Math.round(initCalls.eager/initCalls.batched),lineInstances:ls.resources.size,lineBatchWrites:ls.uploadBatchCalls}));
