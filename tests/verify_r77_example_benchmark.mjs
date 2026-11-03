/** R77 source contract: the comparison uses the same PBF and literal style for both engines. */
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const page=readFileSync(resolve(root,'examples/webgl-vector-tiles-benchmark/index.html'),'utf8');
const runner=readFileSync(resolve(root,'tests/browser/run_r77_webgl_vector_tiles.mjs'),'utf8');
const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
assert.equal(pkg.dependencies.ol,'10.10.0');
assert.equal(pkg.scripts['test:r77:contract'],'node tests/verify_r77_example_benchmark.mjs');
assert(page.includes("MapClass=renderer==='boost'?BoostMap:OLMap"),'paired map classes');
assert(page.includes("LayerClass=renderer==='boost'?BoostWebGLVectorTileLayer:WebGLVectorTileLayer"),'paired layer classes');
assert(page.includes("const styleFor=kind=>"),'shared literal style source');
assert(page.includes("const selected=manifest.sources.slice(0,count)"),'32 independent source subset');
assert(page.includes("new Set(manifest.sources.map(s=>s.sha256)).size!==32"),'PBF identity guard');
assert(page.includes("state.initializationStart=performance.now()"),'timed after PBF preparation');
assert(page.includes("map.setTarget(document.getElementById('map'))"),'identical map attach boundary');
assert(page.includes("if(!state.ready)throw Error('Wait for first complete frame')"),'no early pan measurement');
assert(page.includes("firstCompleteFrameMs"),'benchmark metric expected');
assert(!page.includes('mapbox.com/v4/'),'do not send requests requiring Mapbox key');
assert(runner.includes("['stock','boost','boost','stock']"),'ABBA cycle required');
assert(runner.includes("['boost','stock','stock','boost']"),'BAAB cycle required');
assert(runner.includes("for(const count of [1,8,16,32])"),'load tiers');
assert(runner.includes("summary.measurements.length===32"),'complete 32 isolated runs');
assert(runner.includes("!initial.workerEnabled"),'worker must be off');
assert(runner.includes("if(!software)check(/NVIDIA.*RTX 5060 Ti/"),'physical GPU must not be faked');
for(const p of ['examples/webgl-vector-tiles-benchmark/index.html',
 'tests/browser/run_r77_webgl_vector_tiles.mjs'])assert(existsSync(resolve(root,p)));
console.log('R77_EXAMPLE_PERF_CONTRACT_PASS: isolated ABBA, real 32 MVT sources, shared OL10.10/styling, exact measurement boundaries');
