# R73 — opt-in source-only stock OpenLayers rendering gate

## Proven cause and scope

OpenLayers 10.10.0's WebGLVectorTileLayer can continue GPU rendering even when its canvas is hidden with CSS `opacity: 0`. Combining a live hidden stock renderer with a second Boost canvas consumes duplicated CPU/WebGL work. A physical NVIDIA RTX 5060 Ti R72 experiment using 8, 16, and 32 distinct MVT sources eliminated this duplication and recovered 50–67% less cold first-complete-frame latency versus stock OL. The R73 change implements this as a reversible **opt-in** host boundary, not a new geometry/shader algorithm.

## Usage (host owns map, overlay and fallback target)

```js
import {OLVectorTileBoost} from './src/index.js';

const boost = new OLVectorTileBoost({
  map, canvas, layerStyleResolver: layer => styleMap.get(layer),
  stockOlRenderMode: 'source-only',
  vectorTileOptions: {
    drawMode: 'style-pass',
    stableStyleIdentityCache: true,
    olLayerFboComposition: true,
    closedLineJoins: true,
  },
  onError: ({error, phase}) => console.error('Boost failed; stock OL restored', phase, error)
});
boost.start({renderSync: false});
// Host attaches the already-configured OL Map target and shows the overlay.
// A controlled rollback must call boost.stop(), hide the overlay, then map.renderSync().
```

The mode keeps the **same** Map, View, WebGLVectorTileLayer, and VectorTileSource objects for fallback. During Boost execution, `OlStockRenderGate` suppresses stock layer `render()` at the **instance level** and independently demands tiles from the source's `getTile/getSourceTiles` methods using the scene's active tile-grid calculation. It caches requested tile identities by OL source revision and viewport, and revisits on pan/zoom/source refresh. On stop, every original `render` property descriptor is restored (or the temporary own property is deleted). If a scene or tile-demand error occurs while using the public facade, the gate is stopped, scene is stopped and the overlay is hidden before the host error callback runs; the OL map is asked to repaint.

**Compatibility caveat:** OpenLayers 10.10.0 does not guarantee the `layer.render` instance interception as a stable public extension point. Even though the change does not patch OL prototypes or vendored files, this remains an experimental, version-pinned integration. Hosts must still handle Map disposal, canvas mounting and application-specific fallback. The default `stockOlRenderMode: 'normal'` is unchanged and is unaffected by this gate.

## Non-negotiable validation before merging

- `npm ci`, 17 Node tests, facade/compat/vendor/example/provenance + R73 lifecycle/auto-error tests, Ubuntu and Windows CI.
- Physical RTX 5060 Ti actual OpenLayers UI, 8/16/32 genuine distinct MVT sources × DPR1/2 × two race seeds: exact raced-vs-clean 512×512 RGBA8, tile identity sets, no WebGL errors (**12/12**).
- Injected failure: exact stock OL `render` restoration, same View center/resolution/rotation, stock WebGL visible, real drag/wheel response, source errors 0 (**11 checks**).
- Repeat matched isolated OL 10.10.0 vs R73 source-only Worker OFF ABBA at 8, 16, 32 independent MVT inputs with original raw timing data and screenshots. Performance target: **at least 50% lower first-complete-frame latency** in each scene. This metric is *not* steady-state FPS or universal interactive responsiveness.
- Original third-party license and npm version-pinned vendor source patch contracts remain unchanged.

## Historical caveat

R48's 50–80% figures used a different harness and a deferred Worker enabled path. R70's apparent slowdown was because the refactored example rendered stock OL and Boost **simultaneously**. R72's no-stock-render trial was a diagnostic monkeypatch, not a safely integrated product feature. R73 must prove its own matched performance and robust rollback and retains **production NO-GO** pending deployment acceptance.
