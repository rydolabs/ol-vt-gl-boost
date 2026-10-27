import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),r=join(root,'vendor/openlayers-10.10.0-runtime'),nm=join(r,'node_modules');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
assert.equal(pkg.private,true);
assert.equal(lock.lockfileVersion,3);
const expected={ol:'10.10.0',earcut:'3.2.3',pbf:'5.1.2',rbush:'4.0.1',quickselect:'3.0.0'};
for(const [name,version] of Object.entries(expected)){
 assert.equal(pkg.dependencies[name],version);
 assert.equal(JSON.parse(await readFile(join(nm,name,'package.json'),'utf8')).version,version);
}
for(const relative of ['earcut/src/earcut.js','ol/format/MVT.worker.js']){
 const original=await readFile(join(root,'vendor/overrides',relative));
 const actual=await readFile(join(nm,relative));
 assert.equal(Buffer.compare(original,actual),0,'missing exact preserved vendor patch: '+relative);
}
const manifest=JSON.parse(await readFile(join(r,'GENERATED_MANIFEST.json'),'utf8'));
assert.equal(manifest.schema,'olvt-r69-generated-vendor-v1');
await access(join(nm,'ol','LICENSE.md'));
const {execFileSync}=await import('node:child_process');
const tracked=execFileSync('git',['ls-files','vendor/openlayers-10.10.0-runtime/node_modules/'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(tracked,'','no vendor node_modules should remain tracked by git');
console.log('R69_VENDOR_NPM_LOCK_AND_TWO_PATCHES_PASS');
