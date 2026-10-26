/** Guard experimental Worker handover: every GPU input byte and draw packet
 * must match the currently installed CPU tile, otherwise retain CPU.
 */
export function exactEncodedTile(cpu,worker){
  if(!cpu||!worker||cpu.byteLength!==worker.byteLength||
    cpu.indexType!==worker.indexType||cpu.indexBytes!==worker.indexBytes)return false;
  for(const field of ['vertices','indices','lineInstances']){
    const a=cpu[field],b=worker[field];
    if(!ArrayBuffer.isView(a)||!ArrayBuffer.isView(b)||
      a.constructor!==b.constructor||a.byteLength!==b.byteLength)return false;
    const left=new Uint8Array(a.buffer,a.byteOffset,a.byteLength);
    const right=new Uint8Array(b.buffer,b.byteOffset,b.byteLength);
    for(let i=0;i<left.length;i++)if(left[i]!==right[i])return false;
  }
  for(const field of ['packets','clipExtent','counters','bufferStats'])
    if(JSON.stringify(cpu[field])!==JSON.stringify(worker[field]))return false;
  return true;
}