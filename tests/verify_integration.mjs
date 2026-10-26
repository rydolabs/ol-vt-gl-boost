// Self-contained M5 adapter smoke test with real MapTiler v4 PBF fixtures.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import MVT from '../vendor/openlayers-10.10.0-runtime/node_modules/ol/format/MVT.js';
import {OlVectorTileFeatureAdapter} from '../src/ol/OlVectorTileFeatureAdapter.js';
import {NeutralGeometryCompiler} from '../src/tile/NeutralGeometryCompiler.js';
import {EarcutPolygonTriangulator} from '../src/tile/EarcutPolygonTriangulator.js';
import {toRendererStyle} from '../src/ol/OlStyleAdapter.js';

const dir = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(resolve(dir, 'fixtures/seoul/12/3492/1586.pbf'));
const triangulator = new EarcutPolygonTriangulator();
const compiler = new NeutralGeometryCompiler({polygonTriangulator: triangulator});
const adapter = new OlVectorTileFeatureAdapter();
const styles = {
  polygon: {'fill-color':'rgba(210,194,169,0.52)','stroke-color':'rgba(157,139,112,0.82)','stroke-width':0.7},
  line: {'stroke-color':'rgba(190,91,72,0.9)','stroke-width':1.8},
  point: {'circle-radius':2.7,'circle-fill-color':'rgba(73,139,189,0.9)'}
};
let total = 0;
const summary = {};
for (const layer of ['road','water','building']) {
  const features = new MVT({layers:[layer]}).readFeatures(bytes, {extent:[0,0,4096,4096]});
  assert(features.length > 0, `Missing real ${layer} features`);
  summary[layer] = features.length;
  for (const feature of features.slice(0,50)) {
    const type = feature.getType();
    const kind = type.includes('Line') ? 'line' : type.includes('Polygon') ? 'polygon' : 'point';
    const snapshot = adapter.adapt(feature, {tileKey:'12/3492/1586',styleLike:styles[kind]});
    assert(snapshot.styles.length > 0, 'Missing flat style');
    for (const geometry of snapshot.geometries) {
      const compiled = compiler.compile(geometry);
      assert.equal(compiled.type, geometry.kind);
      assert(compiled.data?.length > 0 || compiled.coords?.length > 0, 'Empty geometry');
      const renderStyle = toRendererStyle(snapshot.styles[0], geometry.kind);
      assert(renderStyle, 'Empty renderer style');
      total++;
    }
  }
}
const holed = triangulator.triangulate([
  [[0,0],[4,0],[4,4],[0,4],[0,0]],
  [[1,1],[1,2],[2,2],[2,1],[1,1]]
]);
assert(holed.length > 0 && holed.length % 6 === 0, 'Earcut polygon holes failed');
console.log('PASS: real PBF MVT decode + OL vector tile adapter + neutral geometry + styles + Earcut');
console.log(JSON.stringify({featuresBySource:summary,compiledGeometries:total,holeTriangles:holed.length/6}));
