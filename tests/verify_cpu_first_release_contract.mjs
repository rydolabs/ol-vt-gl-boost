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
const current=JSON.parse(text('docs/R67_PROVENANCE.json'));
assert.equal(legacy.workerDefault,'off');assert.equal(current.workerDefault,'off');
assert.equal(legacy.fileMapping.length,62);
assert.equal(current.originalR64ExecutableCount,56);
assert.equal(current.newExecutableCount,53);
const changed=new Map(current.changedBlobs.map(x=>[x.path,x.gitBlobSha1]));
const hashedGitBlob=(path)=>{
  const content=bytes(path);
  return createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex');
};
for(const row of legacy.fileMapping){
  assert.equal(original.files.find(f=>f.path===row.original)?.sha256,row.oldSha256,row.original);
  const newPath=current.legacyPathRedirects[row.new]??row.new;
  assert(existsSync(newPath),newPath+' must be tracked at new layout');
  if(changed.has(newPath))assert.equal(hashedGitBlob(newPath),changed.get(newPath),newPath);
  else assert.equal(createHash('sha256').update(bytes(newPath)).digest('hex'),row.newSha256,row.new);
}
for(const [path,sha] of changed)assert.equal(hashedGitBlob(path),sha,path);
for(const old of Object.keys(current.legacyPathRedirects))assert(!existsSync(old),'old module should be deleted: '+old);
console.log('R67_SOURCE_CONTRACT_PASS',legacy.fileMapping.length,changed.size);
