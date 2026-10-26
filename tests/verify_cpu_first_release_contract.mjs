import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DirectM5SceneBinding} from '../src/index.js';
const t=p=>readFileSync(p,'utf8');
const p=t('src/gl/pipeline.js'),b=t('src/ol/scene.js');
assert.match(p,/const gpu=null; \/\/ R48 strict-OL candidate: use existing CPU line-join encoder/);
assert.match(b,/deferredWorker=null/);
assert.match(b,/deferredWorker\?\.enabled===true/);
assert.equal(typeof DirectM5SceneBinding,'function');
const a=JSON.parse(t('docs/REFACTOR_PROVENANCE.json'));
const o=JSON.parse(t('docs/SOURCE_PROVENANCE.json'));
assert.equal(a.workerDefault,'off');
assert.equal(a.fileMapping.length,62);
for(const row of a.fileMapping){
 const h=createHash('sha256').update(readFileSync(row.new)).digest('hex');
 assert.equal(h,row.newSha256,row.new);
 assert.equal(o.files.find(f=>f.path===row.original)?.sha256,row.oldSha256,row.original);
}
console.log('R64_CONTRACT_PASS',a.newSourceModuleCount);
