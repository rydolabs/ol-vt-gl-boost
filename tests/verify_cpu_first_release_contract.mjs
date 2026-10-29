import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DirectM5SceneBinding,OLVectorTileBoost} from '../src/index.js';
const bytes=p=>readFileSync(p),text=p=>bytes(p).toString('utf8');
const p=text('src/gl/pipeline.js'),b=text('src/ol/scene.js');
assert.match(p,/const gpu=null; \/\/ R48 strict-OL candidate: use existing CPU line-join encoder/);
assert.match(b,/deferredWorker=null/);
assert.match(b,/deferredWorker\?\.enabled===true/);
assert.equal(typeof DirectM5SceneBinding,'function');
assert.equal(typeof OLVectorTileBoost,'function');
const legacy=JSON.parse(text('docs/REFACTOR_PROVENANCE.json'));
const original=JSON.parse(text('docs/SOURCE_PROVENANCE.json'));
const r67=JSON.parse(text('docs/R67_PROVENANCE.json'));
const r68=JSON.parse(text('docs/R68_PROVENANCE.json'));
const r73=JSON.parse(text('docs/R73_PROVENANCE.json'));
const r75=JSON.parse(text('docs/R75_PROVENANCE.json'));
const r73Fixture=path=>'tests/fixtures/r73-pinned/'+path.replaceAll('/','__')+'.snapshot';
assert.equal(r73.workerDefault,'off');assert.equal(r73.optIn,true);
const blobSha=path=>{const content=bytes(path);return createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex');};
// R73 historical blobs are frozen in test fixtures, while R75 pins its own
// current sources. Do not overwrite the R73 evidence with new source hashes.
for(const pin of [r73.changedFacade,r73.newHost,r73.changedScene])
 assert.equal(blobSha(r73Fixture(pin.path)),pin.gitBlobSha1,pin.path+' R73 snapshot');
for(const pin of r75.changedBlobs)assert.equal(blobSha(pin.path),pin.gitBlobSha1,pin.path+' R75 current');
assert.equal(legacy.workerDefault,'off');
assert.equal(r67.workerDefault,'off');assert.equal(r68.workerDefault,'off');
assert.equal(legacy.fileMapping.length,62);
assert.equal(r67.originalR64ExecutableCount,56);assert.equal(r67.newExecutableCount,53);
assert.equal(r68.priorSourceExecutableCount,53);assert.equal(r68.newSourceExecutableCount,49);
const previous=new Map(r67.changedBlobs.map(x=>[x.path,x.gitBlobSha1]));
const changed=new Map(r68.changedBlobs.map(x=>[x.path,x.gitBlobSha1]));
const hashedGitBlob=(path)=>{
 if(path===r73.changedFacade.path)return previous.get(path); // Pin current R73 bytes above; retain prior historical R67 provenance.
 // R73 only appends an opt-in public export. Validate the exact historical
 // R68 bytes after removing that one explicitly allowed additive line.
 if(path==='src/index.js'){
   const current=text(path);
   const marker="\nexport {OlExclusiveVectorTileRenderHost} from './ol/OlExclusiveVectorTileRenderHost.js';\n";
   assert(current.endsWith(marker),'Unexpected src/index.js modifications beyond R73 opt-in export');
   const original=Buffer.from(current.slice(0,-marker.length),'utf8');
   return createHash('sha1').update('blob '+original.length+'\0').update(original).digest('hex');
 }

 // R73 permits exactly one batching-only GL error validation relocation.
 // Reconstruct the R68 bytes and verify their historical Git blob SHA;
 // any unrelated change to the original renderer still fails this contract.
 if(path==='src/ol/scene.js'){
   const current=text(r73Fixture(path));
   const oldDraw='      b.drawArrays(gl.TRIANGLE_STRIP,0,4);\\n      const err=gl.getError();if(err!==gl.NO_ERROR)throw Error("RGBA8 layer composition GL error "+err);\\n'.replaceAll('\\n','\n');
   const newDraw='      b.drawArrays(gl.TRIANGLE_STRIP,0,4);\\n'.replaceAll('\\n','\n');
   const oldEnd='    flush(group);\\n    gl.bindFramebuffer(gl.FRAMEBUFFER,null);\\n    b.invalidateStateCache();'.replaceAll('\\n','\n');
   const newEnd='    flush(group);\\n    // Check errors after all layer passes rather than synchronizing the driver\\n    // once per layer. The same GL error gate remains mandatory.\\n    const err=gl.getError();if(err!==gl.NO_ERROR)throw Error("RGBA8 layer composition GL error "+err);\\n    gl.bindFramebuffer(gl.FRAMEBUFFER,null);\\n    b.invalidateStateCache();'.replaceAll('\\n','\n');
   // The endFrame optimization eliminates the extra gl.getError sync and
   // reuses the backend's mandatory end-of-frame error gate instead.
   const endFrameOld="    this.lastFrameStats=this.backend.endFrame();this.frames++;\\n".replaceAll('\\n','\n');
   const endFrameNew="    this.lastFrameStats=this.backend.endFrame();this.frames++;\\n    if(this.lastFrameStats?.glError)throw Error('RGBA8 layer composition GL error '+this.lastFrameStats.glError);\\n".replaceAll('\\n','\n');
   const compositorNew="    flush(group);\\n    // Backend.endFrame performs the single required GL error query after\\n    // all compositor passes and GPU completion, without a duplicate sync.\\n    gl.bindFramebuffer(gl.FRAMEBUFFER,null);\\n    b.invalidateStateCache();".replaceAll('\\n','\n');
   assert(current.includes(newDraw)&&current.includes(compositorNew),'Unexpected R73 GL compositor patch');
   // Restore only the R73 opt-in disjoint-tile FBO shortcut before verifying
   // the precise prior compositor's historical Git blob SHA.
   const fastStart=current.indexOf('  /**\\n   * Opt-in R73 shortcut'.replaceAll('\\n','\n'));
   const fastEnd=current.indexOf('  renderFrame(frameState){',fastStart);
   assert(fastStart>0&&fastEnd>fastStart,'R73 safe FBO helper missing');
   let withoutFast=current.slice(0,fastStart)+current.slice(fastEnd);
   const newPath="    const needsLayerFbo=this.vectorTileOptions.olLayerFboComposition===true&&this.layers.size>1;\\n    const bypassLayerFbo=needsLayerFbo&&this.canSkipDisjointLayerFbo(schedule,frameState);\\n    if(needsLayerFbo&&!bypassLayerFbo){".replaceAll('\\n','\n');
   const oldPath="    if(this.vectorTileOptions.olLayerFboComposition===true&&this.layers.size>1){";
   assert(withoutFast.includes(newPath),'R73 guarded compositor selection missing');
   withoutFast=withoutFast.replace(newPath,oldPath);
   const newFinish="this.lastFrameStats=this.backend.endFrame();this.lastFrameStats.layerFboBypassed=bypassLayerFbo;this.frames++;";
   const oldFinish="this.lastFrameStats=this.backend.endFrame();this.frames++;";
   assert(withoutFast.includes(newFinish),'R73 guarded completion marker missing');
   withoutFast=withoutFast.replace(newFinish,oldFinish);
   assert(withoutFast.includes(endFrameNew),'Unexpected R73 GPU completion gate');
   const optimizedReverted=withoutFast.replace(compositorNew,newEnd).replace(endFrameNew,endFrameOld);
   assert(optimizedReverted.includes(newEnd),'R73 compositor reconstruction failed');
   const restored=optimizedReverted.replace(newDraw,oldDraw).replace(newEnd,oldEnd);
   const content=Buffer.from(restored,'utf8');
   return createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex');
 }
 const content=bytes(path);
 return createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex');
};
for(const row of legacy.fileMapping){
 assert.equal(original.files.find(f=>f.path===row.original)?.sha256,row.oldSha256,row.original);
 const mapped67=r67.legacyPathRedirects[row.new]??row.new;
 const mapped68=r68.redirects[mapped67]??mapped67;
 assert(existsSync(mapped68),mapped68+' missing from R68 layout');
 if(changed.has(mapped68))assert.equal(hashedGitBlob(mapped68),changed.get(mapped68),mapped68);
 else if(previous.has(mapped68))assert.equal(hashedGitBlob(mapped68),previous.get(mapped68),mapped68);
 else assert.equal(createHash('sha256').update(bytes(mapped68)).digest('hex'),row.newSha256,row.new);
}
for(const [path,sha] of previous){
 const dst=r68.redirects[path]??path;
 if(changed.has(dst))continue;
 assert.equal(hashedGitBlob(dst),sha,path);
}
for(const [path,sha] of changed)assert.equal(hashedGitBlob(path),sha,path);
for(const old of [...Object.keys(r67.legacyPathRedirects),...Object.keys(r68.redirects)])
 assert(!existsSync(old),'old module should be deleted: '+old);
console.log('R68_SOURCE_CONTRACT_PASS',legacy.fileMapping.length,previous.size,changed.size);
