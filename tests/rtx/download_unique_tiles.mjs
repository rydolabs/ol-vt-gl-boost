/** R46 independent source fixtures: 32 different real MVT URLs, coordinates and SHA-256.
 * MapLibre OpenMapTiles demo source, documented for development and CI.
 * Do not quietly substitute 4 Seoul tiles or count duplicate styles as independent.
 */
import {createHash} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import MVT from '../../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
const root=resolve(process.argv[2]||'R46-DATA'),tileRoot=join(root,'tiles');
await mkdir(tileRoot,{recursive:true});
const sources=[],hashes=new Set(),seenUrls=new Set();
const z=12,startX=2174,startY=1434,columns=8,rows=4;
const layersPriority=['transportation','landcover','landuse','water','park','boundary'];
for(let i=0;i<columns*rows;i++){
 const x=startX+i%columns,y=startY+Math.floor(i/columns);
 const url='https://demotiles.maplibre.org/tiles-omt/'+z+'/'+x+'/'+y+'.pbf';
 if(seenUrls.has(url))throw Error('Duplicate data URL '+url);
 seenUrls.add(url);
 let bytes;
 for(let attempt=0;attempt<3;attempt++){
  try{const r=await fetch(url,{signal:AbortSignal.timeout(18000),headers:{'User-Agent':'M5-R46-RTX-Verification/1.0 (MapLibre public test data)'}});
   if(!r.ok)throw Error('HTTP '+r.status);bytes=Buffer.from(await r.arrayBuffer());break;
  }catch(e){if(attempt===2)throw Error('Cannot fetch unique MVT '+url+': '+e);await new Promise(r=>setTimeout(r,800*(attempt+1)));}
 }
 if(bytes.length<64||bytes.length>2_000_000)throw Error('Unexpected MVT size '+url+': '+bytes.length);
 const sha256=createHash('sha256').update(bytes).digest('hex');
 if(hashes.has(sha256))throw Error('Duplicate PBF bytes: '+url+' '+sha256);
 hashes.add(sha256);
 const fs=new MVT().readFeatures(bytes,{extent:[0,0,4096,4096]}),counts={};
 for(const f of fs){const name=f.getProperties()?.layer??'unknown';counts[name]=(counts[name]||0)+1;}
 const layer=layersPriority.find(name=>(counts[name]??0)>0);
 if(!layer)throw Error('Empty or unsupported source '+url+' '+JSON.stringify(counts));
 const source={index:i,z,x,y,url,sha256,byteLength:bytes.length,layer,featuresInSourceLayer:counts[layer],totalFeatures:fs.length,layerCounts:counts};
 const path=join(tileRoot,z+'',x+'');await mkdir(path,{recursive:true});await writeFile(join(path,y+'.pbf'),bytes);
 sources.push(source);console.log('R46_SOURCE',JSON.stringify({i,x,y,sha256,length:bytes.length,layer,features:counts[layer]}));
}
const manifest={kind:'genuine-independent-MVT-sources',provider:'MapLibre OpenMapTiles public demo (Innsbruck)',licenseReference:'https://github.com/maplibre/demotiles',retrievedAt:new Date().toISOString(),
 columns,rows,coordinateSystem:'XYZ z12; 8 columns x 4 rows; no duplicated source tiles',sources};
await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('R46_SOURCE_IDENTITY_PASS',JSON.stringify({sources:sources.length,uniqueHashes:hashes.size,
 totalPbfBytes:sources.reduce((n,x)=>n+x.byteLength,0),minFeatures:Math.min(...sources.map(x=>x.featuresInSourceLayer)),maxFeatures:Math.max(...sources.map(x=>x.featuresInSourceLayer))}));
