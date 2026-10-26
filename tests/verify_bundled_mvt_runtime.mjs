/**
 * Offline preflight for the zip-distributed Round5 project.
 * The Playwright-free runner requires the vendored OL MVT decoder and Earcut.
 */
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const required=[
  'vendor/openlayers-10.10.0-runtime/node_modules/earcut/src/earcut.js',
  'vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js',
  'vendor/openlayers-10.10.0-runtime/node_modules/pbf/index.js',
];
const missing=required.filter(p=>!existsSync(resolve(root,p)));
if(missing.length){
  console.error('M5 packaging error: bundled runtime files are missing:');
  for(const name of missing)console.error('  - '+name);
  console.error('Download the corrected FULL_SOURCE zip or apply the VENDOR_REPAIR patch to the project folder.');
  process.exit(2);
}
try{
  const [{default:earcut},{default:MVT}]=await Promise.all([
    import('../vendor/openlayers-10.10.0-runtime/node_modules/earcut/src/earcut.js'),
    import('../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js'),
  ]);
  const indices=earcut([0,0,10,0,0,10],null,2);
  if(typeof MVT!=='function'||indices.length!==3)throw Error('MVT or Earcut failed basic function check');
  console.log(JSON.stringify({pass:true,bundledRuntime:true,earcutTriangles:indices.length/3,openLayersMVT:true,playwrightRequired:false}));
}catch(e){
  console.error('M5 vendor runtime import failed: '+(e.stack||e));
  process.exit(2);
}
