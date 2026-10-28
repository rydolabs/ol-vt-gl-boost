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

The public exclusive façade enables tile scissor by default (override with `vectorTileOptions:{tileScissorEnabled:false}`); this does not affect ordinary/legacy rendering. Exclusive mode opts into `isolatedTileFboFastPath:true`, which bypasses the per-layer RGBA8 FBO **only** when the scene has scissor clipping enabled, all rendered source tile domains are distinct across different OL layers, every tile uses the same zoom, world-offset wrapping is zero, and view rotation is zero. In every other case it retains OL-style per-layer FBO composition. Callers can explicitly disable this optimization with `vectorTileOptions:{isolatedTileFboFastPath:false}`. GL errors remain mandatory. R71 physical RTX screenshots confirmed zero changed pixels for the disjoint 8/16/32-source DPR1 fixtures. The exact merged R73 commit was independently validated on the physical RTX at DPR1/2 across 12 RGBA8 cases, with 9 stock OL fallback checks: [post-merge RTX integration](https://github.com/nssang00/chatgpt-write-test/actions/runs/40665623411).

## Boundaries and release gates
- **Experimental, opt-in only.** The per-instance `layer.render` interception is not an OpenLayers guaranteed stable public extension point. Pin `ol@10.10.0`. Do not change OL prototypes, vendored files, geometry encoding, shaders or the Worker-OFF default to improve benchmark scores.
- **Measured first complete frame, not FPS.** The R72 synthetic test-only interception achieved 50.54%, 57.51%, 67.21% less first-complete-frame latency versus OL10.10.0 at 8/16/32 genuinely distinct PBF sources. The merged R73 real host independently passed >=50% per scene: 50.77%, 59.79%, 69.55% less first-frame latency for 8/16/32 sources (60 raw ABBA samples, [post-merge RTX benchmark](https://github.com/nssang00/chatgpt-write-test/actions/runs/40665633602)).
- **Correctness** requires exact 512×512 RGBA8 and tile IDs for all 12 RTX cases (source count 8/16/32, DPR 1/2, two seeds), plus actual stock OL fallback and mouse/scroll interactions.
- **CI** must pass on Ubuntu and Windows, including `npm run test:r73`, the source provenance contract, locked npm restore and all CPU/Worker regressions.
- **Production remains NO-GO** even though the exact merged candidate passed the listed first-frame and fallback gates: the OpenLayers 10.10.0 per-instance `layer.render` interception is an unsupported extension seam, and broad production traffic, pan/zoom tail latency, sustained FPS, memory and context-loss recovery require additional validation. Historical R48 Worker-enabled measurements cannot substitute for the current Worker-OFF comparison.

Evidence: [R72 isolation](https://github.com/nssang00/chatgpt-write-test/actions/runs/40617766065), [R73 performance raw run](https://github.com/nssang00/chatgpt-write-test/actions/runs/40653389348), [R73 opt-in PR #8](https://github.com/rydolabs/ol-vt-gl-boost/pull/8).

## Source/code simplification policy
Keep one opt-in `OlExclusiveVectorTileRenderHost` and one public façade `OLVectorTileBoost`; do not add another wrapper or maintain parallel experimental renderer forks. Remove dead paths only when source behavior and exact RTX regression evidence remain unchanged.

## Post-merge R74 code hygiene assessment

- The `main` tree at `77e54acc7ab41e44db25d3380d1996e1a7caa0ea` contains 115 tracked files, including 49 JS/MJS files under `src/` and 4 files under `vendor/`. The R68/R69 structural reduction and locked npm restoration remain intact.
- **Do not delete** the legacy compatibility path, OL layer/source instances, per-layer FBO fallback or optional Worker code just to reduce file count: they preserve rollback, mixed-layer composition, and opt-in compatibility contracts. They are not proven dead code.
- No duplicate experimental R72 `manual-tiles` monkeypatch is included in production source; R73 exposes one `OlExclusiveVectorTileRenderHost` through `OLVectorTileBoost`.
- Remaining performance work must be measured separately: host/map startup allocation, source-tile priming across viewport changes, pan/zoom tail latency, sustained FPS, GPU memory/texture reuse, and context-loss recovery. The measured R73 first-frame target is already met; avoid changing the runtime without new exact-SHA RTX performance and 12+9 correctness evidence.
