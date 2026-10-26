/** Physical RTX / Chrome only. Fail-closed 8/16/32 x DPR1/2 x two-seed matrix. */
import {spawnSync} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve('.'),out=resolve(process.env.OLVT_RTX_OUT||'artifacts/rtx-r61');
await mkdir(out,{recursive:true});
const results=[],errors=[];
for(const sources of [8,16,32])for(const dpr of [1,2])for(const seed of [1,2]){
 const id='s'+sources+'-dpr'+dpr+'-seed'+seed,folder=join(out,id);
 await mkdir(folder,{recursive:true});
 const test=spawnSync(process.execPath,['tests/rtx/run_strict_physical_dpr_oracle.mjs',root,folder],{
   cwd:root,encoding:'utf8',timeout:105000,maxBuffer:6*1024*1024,
   env:{...process.env,M5_R57_SOURCES:String(sources),M5_R57_DPR:String(dpr),M5_R57_SEED:String(seed)}});
 let result={};try{result=JSON.parse(await readFile(join(folder,'result.json'),'utf8'))}catch(e){errors.push(id+': result missing '+e.message)}
 const p=result.pixelAudit||{},t=result.tileAudit||{};
 const good=test.status===0&&!test.error&&result.pass===true&&
   result.errors?.length===0&&result.snapshots?.final?.glError===0&&
   p.sources===sources&&p.dpr===dpr&&p.seed===seed&&
   p.diffPixels===0&&p.changedChannels===0&&t.exact===true&&
   result.checks?.length>=4;
 results.push({id,pass:good,exit:test.status,pixel:p,tileExact:t.exact,
   renderer:result.snapshots?.final?.renderer,error:result.error||String(test.error||'')});
 console.log(good?'R64_GPU_EXACT_PASS':'R64_GPU_EXACT_FAIL',id);
 if(!good)errors.push(id+': exact GPU oracle failed');
 await writeFile(join(out,'summary.json'),JSON.stringify({pass:false,results,errors},null,2));
}
const summary={schema:'ol-vt-gl-boost-rtx-r64-v1',pass:results.length===12&&errors.length===0,
 checked:results.length,results,errors};
await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));
console.log(summary.pass?'R64_12_CASE_GPU_PASS':'R64_GPU_FAIL',JSON.stringify({pass:summary.pass,checked:summary.checked,errors}));
if(!summary.pass)process.exitCode=1;
