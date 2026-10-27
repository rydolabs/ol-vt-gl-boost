/** Reconstruct the historical vendor import layout from the npm lockfile.
 * No minification, rewriting, or logic changes; compatible with Windows and Unix.
 * Vendor package licenses are copied together with original package source files.
 */
import {cp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const project=resolve(import.meta.dirname,'..');
const installed=join(project,'node_modules');
const target=join(project,'vendor/openlayers-10.10.0-runtime/node_modules');
const required={ol:'10.10.0',pbf:'5.1.2',earcut:'3.2.3',rbush:'4.0.1',quickselect:'3.0.0'};
for(const [name,version] of Object.entries(required)){
  let content;
  try{content=JSON.parse(await readFile(join(installed,name,'package.json'),'utf8'));}
  catch(error){throw Error('R69 missing npm package '+name+': '+error.message);}
  if(content.version!==version)throw Error('R69 package '+name+' is '+content.version+', expected '+version);
}
// Audit every legacy package byte before overwriting it. R69 must keep custom OL files.
const legacyDelta=[],overrides=[];
async function scan(directory,prefix=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const rel=prefix?prefix+'/'+entry.name:entry.name;
    const full=join(directory,entry.name);
    if(entry.isDirectory()){await scan(full,rel);continue;}
    if(!entry.isFile())continue;
    const prior=await readFile(full);
    let next=null;try{next=await readFile(join(installed,...rel.split('/')));}catch{}
    if(next&&!prior.equals(next))legacyDelta.push({path:rel,status:'changed',bytes:prior.length});
    if(!next)legacyDelta.push({path:rel,status:'missing-in-npm',bytes:prior.length});
    if(!next||!prior.equals(next))overrides.push({path:rel,bytes:prior});
  }
}
await scan(target);
await rm(target,{recursive:true,force:true});
await mkdir(target,{recursive:true});
let count=0;
for(const dir of await readdir(installed,{withFileTypes:true})){
  if(dir.name.startsWith('.')||dir.name==='playwright'||dir.name==='playwright-core')continue;
  if(!dir.isDirectory())continue;
  await cp(join(installed,dir.name),join(target,dir.name),{recursive:true,force:true,errorOnExist:false});
  count++;
}
// During transition, preserve differing vendored files instead of silently losing patches.
for(const patch of overrides){
  const dest=join(target,...patch.path.split('/'));
  await mkdir(resolve(dest,'..'),{recursive:true});
  await writeFile(dest,patch.bytes);
}
await mkdir(join(project,'artifacts'),{recursive:true});
await writeFile(join(project,'artifacts/r69-patch-audit.json'),
  JSON.stringify({schema:'r69-audit-v1',legacyDelta,overrideCount:overrides.length},null,2)+'\n');
console.log('R69_VENDOR_PATCH_AUDIT',JSON.stringify({overrides:overrides.length,files:legacyDelta.length}));
if(count<5)throw Error('R69 npm install is incomplete');
const report={schema:'olvt-r69-generated-vendor-v1',required,copiedRootDirs:count,
  reproduction:'npm ci -> postinstall (npm lockfile)',licenses:'original installed package licenses copied'};
await writeFile(join(project,'vendor/openlayers-10.10.0-runtime/GENERATED_MANIFEST.json'),JSON.stringify(report,null,2)+'\n');
console.log('R69_VENDOR_RUNTIME_RESTORED',JSON.stringify(report));
