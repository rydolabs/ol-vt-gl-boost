# R77 — WebGL Vector Tiles example: OL 10.10.0 vs BoostMap

Reference: https://openlayers.org/en/latest/examples/webgl-vector-tiles.html

## What is genuinely the same, and what is not

The official OpenLayers example currently uses **OL 10.11.0**, private Mapbox
Streets v6 MVT tile service (requires an access token), and many mutually
exclusive filters, conditional colors, zoom rules, text labels and other
symbolization. R76 Boost only handles a conservative literal-style subset.
**Running that full official style in BoostMap would trigger stock-OL fallback,
not a meaningful Boost performance comparison.** Do not compare a simplified
Boost rendering with the original official Mapbox style and claim a speedup.

Instead, this runnable example recreates the *kind* of map, using **the same
OL 10.10.0, identical local MapLibre OpenMapTiles PBF bytes, simple map-like
colors and stroke widths, identical render viewport, projection and view**.
The 32 PBFs are independent and SHA-256 checked. Each source has a separate
actual MVT file and is included in both engines. The page exposes
\`?renderer=stock|boost&count=1|8|16|32\`.

Only original classes differ:

\`\`\`js
// Original side
import OLMap from 'ol/Map.js';
import WebGLVectorTileLayer from 'ol/layer/WebGLVectorTile.js';

// Boost side
import {BoostMap, BoostWebGLVectorTileLayer} from './src/index.js';
\`\`\`

The original and Boost scenes are run **sequentially** for performance
measurements, to avoid simultaneous CPU/GPU contention.

## Run it

\`\`\`bash
npm ci
npm run test:rtx:prepare
npm run example:webgl-vector-tiles
# http://127.0.0.1:4173/examples/webgl-vector-tiles-benchmark/
\`\`\`

Select the renderer and source count. Clicking **Measure pan submission**
produces 24 individual synchronous map.renderSync() submission timings.

For a repeatable automated ABBA sample, install the test-only Playwright
driver separately and use the appropriate Chrome executable. On Windows,
where Chrome is available at the standard location:

\`\`\`bash
npm install --no-save --package-lock=false --ignore-scripts playwright@1.55.0
R77_ALLOW_SOFTWARE_GL=1 npm run test:r77:browser
\`\`\`

\`R77_ALLOW_SOFTWARE_GL=1\` is explicitly for *software-only* hosted runner
smoke tests. Omitting it enforces a real RTX 5060 Ti WebGL renderer,
for which the machine and Chrome must be prepared. The command is also
available as a Windows GitHub Actions workflow.

## Measurement contract

- First complete screen: begins **after fetching the PBF data**, before map
  target attachment; ends only after source load completion and an actual OL
  postrender event, with Boost exclusive mode checked.
- Each browser scene uses an independent page, same viewport/DPR, worker OFF,
  1, 8, 16 or 32 genuinely different source tile identities.
- Automated order: ABBA on cycle 1, BAAB on cycle 2 (4 samples per engine per
  source count), 32 cases total. Raw per-scene samples and aggregate medians
  are exported to \`samples.csv\` and \`summary.json\`.
- Pan performance: 24 individual CPU \`map.renderSync()\` submissions per
  scene after loading and while oscillating the map center. This measures
  **main-thread submission time**, not GPU completion, end-to-end throughput
  or frame rate.
- WebGL calls: counts of createProgram/createShader/useProgram/drawElements/
  drawArrays instrumented on WebGL1, per isolated page.
- Individual 512×512 map screenshots are captured; they are a visual aid,
  **not** a passed byte-exact OL-vs-Boost pixel oracle.
- Very small sample size and software GPU on hosted CI mean the resulting
  percentages are exploratory. Do not publish them as hardware-independent
  speed claims, sustained FPS, or evidence that R76 is Production-ready.

## Limitations

- Original Mapbox data and conditional/text styles are **not** reproduced:
  this example is comparable under a narrower, supported style subset.
- Full OpenLayers 10.11.0 vs 10.10.0 performance is **not** evaluated.
- OL hit detection is disabled for the Boost path; this is not a proof of
  click-picking parity.
- Background raster, mixing layers and unsupported styles still trigger OL
  fallback; this single-type scene does not validate them.
- A physical NVIDIA RTX proof, multi-minute continuous interaction/FPS and
  memory stability test remain separate release gates.
