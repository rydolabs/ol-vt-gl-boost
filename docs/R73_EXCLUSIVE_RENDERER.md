# R73 — Exclusive stock OpenLayers GPU drawing (experimental)
## Why this exists
R72 physical RTX established that the earlier Boost integration still executed OL WebGL vector tile drawing under CSS `opacity:0`. R73 keeps the stock OL Map/View/VectorTileSource/Layer objects intact for rollback, while intercepting **only per-instance layer.render()** during Boost activity. Source tiles are demanded independently using the OpenLayers 10.10.0 tile source APIs. The Workers remain OFF by default.

## Recommended host API
```js
import {OLVectorTileBoost} from './src/index.js';
const boost=new OLVectorTileBoost({
  map,canvas,
  stockOlRenderMode:'exclusive',
  layerStyleResolver:layer=>styles.get(layer),
  vectorTileOptions:{
    drawMode:'style-pass',stableStyleIdentityCache:true,
    olLayerFboComposition:true,closedLineJoins:true
  },
  onError:({error,phase})=>console.error('Stock OpenLayers restored',phase,error)
});
boost.start({renderSync:false});
// Once the host has sized and attached its OL map target:
map.render();
```

The host owns the overlay canvas stacking, visibility, map target, disposal and application-level rollback. `boost.stop()` restores original stock OL layer methods **before** the next stock render; if the exclusive renderer fails, the façade stops it, hides the overlay and requests stock OL redraw. An unexpected layer tree change is treated as an error requiring stock fallback. The default `stockOlRenderMode:'normal'` is backward compatible.

## Guarded isolated-tile compositor shortcut

The public exclusive façade enables tile scissor by default (override with `vectorTileOptions:{tileScissorEnabled:false}`); this does not affect ordinary/legacy rendering. Exclusive mode opts into `isolatedTileFboFastPath:true`, which bypasses the per-layer RGBA8 FBO **only** when the scene has scissor clipping enabled, all rendered source tile domains are distinct across different OL layers, every tile uses the same zoom, world-offset wrapping is zero, and view rotation is zero. In every other case it retains OL-style per-layer FBO composition. Callers can explicitly disable this optimization with `vectorTileOptions:{isolatedTileFboFastPath:false}`. GL errors remain mandatory. R71 physical RTX screenshots confirmed zero changed pixels for the disjoint 8/16/32-source DPR1 fixtures; R73 must independently validate DPR1/2 across 12 cases before release.

## Boundaries and release gates
- **Experimental, opt-in only.** The per-instance `layer.render` interception is not an OpenLayers guaranteed stable public extension point. Pin `ol@10.10.0`. Do not change OL prototypes, vendored files, geometry encoding, shaders or the Worker-OFF default to improve benchmark scores.
- **Measured first complete frame, not FPS.** The R72 synthetic test-only interception achieved 50.54%, 57.51%, 67.21% less first-complete-frame latency versus OL10.10.0 at 8/16/32 genuinely distinct PBF sources. The R73 real host must independently meet the same >=50% per scene.
- **Correctness** requires exact 512×512 RGBA8 and tile IDs for all 12 RTX cases (source count 8/16/32, DPR 1/2, two seeds), plus actual stock OL fallback and mouse/scroll interactions.
- **CI** must pass on Ubuntu and Windows, including `npm run test:r73`, the source provenance contract, locked npm restore and all CPU/Worker regressions.
- **Production remains NO-GO** unless the exact merged candidate is shown to satisfy all gates. Historical R48 Worker-enabled measurements cannot substitute for the current Worker-OFF comparison.

Evidence: [R72 isolation](https://github.com/nssang00/chatgpt-write-test/actions/runs/40617766065), [R73 performance raw run](https://github.com/nssang00/chatgpt-write-test/actions/runs/40653389348), [R73 opt-in PR #8](https://github.com/rydolabs/ol-vt-gl-boost/pull/8).

## Source/code simplification policy
Keep one opt-in `OlExclusiveVectorTileRenderHost` and one public façade `OLVectorTileBoost`; do not add another wrapper or maintain parallel experimental renderer forks. Remove dead paths only when source behavior and exact RTX regression evidence remain unchanged.
