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
const override=new Map([...r73.priorChangedBlobOverrides,...r73.newFiles].map(x=>[x.path,x.gitBlobSha1]));
assert.equal(r73.workerDefault,'off');assert.equal(r73.newSourceExecutableCount,50);
assert.equal(legacy.workerDefault,'off');
assert.equal(r67.workerDefault,'off');assert.equal(r68.workerDefault,'off');
assert.equal(legacy.fileMapping.length,62);
assert.equal(r67.originalR64ExecutableCount,56);assert.equal(r67.newExecutableCount,53);
assert.equal(r68.priorSourceExecutableCount,53);assert.equal(r68.newSourceExecutableCount,49);
const previous=new Map(r67.changedBlobs.map(x=>[x.path,x.gitBlobSha1]));
const changed=new Map(r68.changedBlobs.map(x=>[x.path,x.gitBlobSha1]));
const hashedGitBlob=(path)=>{
 const content=bytes(path);
 return createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex');
};
for(const row of legacy.fileMapping){
 assert.equal(original.files.find(f=>f.path===row.original)?.sha256,row.oldSha256,row.original);
 const mapped67=r67.legacyPathRedirects[row.new]??row.new;
 const mapped68=r68.redirects[mapped67]??mapped67;
 assert(existsSync(mapped68),mapped68+' missing from R68 layout');
 if(override.has(mapped68))assert.equal(hashedGitBlob(mapped68),override.get(mapped68),mapped68);
 else if(changed.has(mapped68))assert.equal(hashedGitBlob(mapped68),changed.get(mapped68),mapped68);
 else if(previous.has(mapped68))assert.equal(hashedGitBlob(mapped68),previous.get(mapped68),mapped68);
 else assert.equal(createHash('sha256').update(bytes(mapped68)).digest('hex'),row.newSha256,row.new);
}
for(const [path,sha] of previous){
 const dst=r68.redirects[path]??path;
 if(changed.has(dst)||override.has(dst))continue;
 assert.equal(hashedGitBlob(dst),sha,path);
}
for(const [path,sha] of changed)if(!override.has(path))assert.equal(hashedGitBlob(path),sha,path);
for(const [path,sha] of override)assert.equal(hashedGitBlob(path),sha,path);
for(const old of [...Object.keys(r67.legacyPathRedirects),...Object.keys(r68.redirects)])
 assert(!existsSync(old),'old module should be deleted: '+old);
console.log('R73_SOURCE_CONTRACT_PASS',legacy.fileMapping.length,previous.size,changed.size,override.size);
