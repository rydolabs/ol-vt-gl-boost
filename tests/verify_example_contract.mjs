/** Validate the runnable side-by-side example without downloading external MVT data. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,access,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const html=await readFile(join(root,'examples/compare/index.html'),'utf8');
const readme=await readFile(join(root,'README.md'),'utf8');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
assert.equal(pkg.scripts['example:compare'],'node examples/compare/serve.mjs');
assert.equal(pkg.scripts['test:examples'],'node tests/verify_example_contract.mjs');
const imports=[...html.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m=>m[1]);
assert(imports.length>=8,'OpenLayers and Boost imports expected');
for(const specifier of imports){
  assert(specifier.startsWith('../../'),'Unexpected browser import '+specifier);
  await access(resolve(root,'examples/compare',specifier));
}
const importmap=JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]||'');
for(const alias of ['pbf','earcut','rbush','quickselect']){
  const path=importmap.imports[alias];assert(path?.startsWith('/vendor/'));
  await access(resolve(root,'.'+path));
}
const scripts=[...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length,1,'Exactly one browser module expected');
const tmp=await mkdtemp(join(tmpdir(),'olvt-example-check-'));
try{
  const filename=join(tmp,'example.mjs');
  await writeFile(filename,scripts[0][1]);
  const syntax=spawnSync(process.execPath,['--check',filename],{encoding:'utf8',timeout:30000});
  assert.equal(syntax.status,0,syntax.stderr||syntax.stdout);
}finally{await rm(tmp,{recursive:true,force:true})}
assert(html.includes('new DirectM5SceneBinding('),'Boost uses exported Direct scene API');
assert(html.includes('new WebGL1Backend('),'Boost uses exported GPU backend');
assert(html.includes('new WebGLVectorTileLayer('),'Demo uses real OL 10.10.0 WebGL vector tile layers');
assert(html.includes('const view=new View('),'Demo has explicit shared OL View');
assert(html.includes('layers:original.layers,view')&&html.includes('layers:optimized.layers,view'),
  'Both maps must use the SAME OpenLayers View instance');
assert(html.includes('tileBuffers.get(url)')&&html.includes('tileBuffers.set(key,await tile.arrayBuffer())'),
  'Both modes must use one local PBF cache');
assert(html.includes('report.workerDefaultOff=binding.deferredWorker===null'),
  'Worker OFF must be checked at runtime');
assert(html.includes('binding.stop();')&&html.includes("classList.remove('boost-active')"),
  'Fallback must stop M5 and reveal stock OL');
assert(readme.includes('npm run example:compare')&&readme.includes('examples/compare/'),
  'README must link to runnable side-by-side example');
assert(readme.includes('historical R48')&&readme.includes('Worker OFF'),
  'README must retain historical benchmark configuration caveat');
console.log('OLVT_COMPARISON_EXAMPLE_CONTRACT_PASS: module syntax, import targets, shared View, PBF cache, Worker OFF, stock fallback, README');
