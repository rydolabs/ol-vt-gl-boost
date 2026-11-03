# R76 drop-in Map compatibility (experimental)

## One-import migration

Replace only the OpenLayers **Map import**. Existing `WebGLVectorTileLayer`, `VectorTileSource`, `View`, layer styles, map options, sources and layer references remain unchanged.

```diff
- import Map from 'ol/Map.js';
+ import Map from 'ol-vt-gl-boost/src/ol/BoostMap.js';
  import WebGLVectorTileLayer from 'ol/layer/WebGLVectorTile.js';

  const map = new Map({
    target: 'map',
    layers: [new WebGLVectorTileLayer({
      source,
      style: {'stroke-color': '#dc4137','stroke-width': 3},
      disableHitDetection: true
    })],
    view
  });
```

This is a **source-import path example**; the package is still `private: true`, unpublished, and not production-approved. Development consumers must provide the local module path or an alias. This avoids shipping any unapproved npm artifact.

The new class subclasses the genuine OpenLayers 10.10.0 `Map` and preserves the ordinary map API. It owns **one** `OLVectorTileBoost` instance and one overlay for all compatible vector tile layers. It auto-mounts its canvas to the map viewport. The existing style object is obtained from OpenLayers' pinned private `WebGLVectorTileLayer.style_` field; application code need not create a style registry or write an explicit `layerStyleResolver`.

## Explicit safe fallback

`map.getBoostStatus()` returns `{enabled, reason}`. `map.disableBoost()` returns to stock OL and prevents reactivation on detach/reattach until `map.enableBoost()` is called.

For **any** of these conditions the map keeps genuine Stock OpenLayers rendering:
- Mixed raster/vector/non-`WebGLVectorTileLayer` layers, empty scene, or unsupported source
- Any layer with hit detection enabled (default OL setting is **enabled**)
- OL FlatStyles with expressions, style variables, filters, text, icons, patterns, multiple styles, or other unsupported keys
- GL initialization error or a Boost runtime/adapter error

This conservative behavior is intentional: a class-only switch must not silently degrade user-visible features. `disableHitDetection:true` is required per layer to activate Boost. There is currently no compatible Boost feature-picking implementation.

A literal subset is currently eligible: solid fill, solid stroke, simple circle markers, z-index, stroke cap/join/miter. Other style forms fall back to OL rather than partially rendering. Read-only OL 10.10.0 internals `style_` and `hitDetectionDisabled_` are used inside the adapter and must be revalidated after each OL upgrade.

## Dynamic behavior

- Existing `layer.setVisible()`, `setOpacity()`, `setZIndex()`, source/view changes remain standard OL interactions.
- Compatible `layer.setStyle(newLiteralStyle)` is detected through layer change events, then forwarded to the shared Boost scene. An unsupported new style triggers stock fallback.
- Layer-tree changes are still conservative: the original exclusive render host can fail closed rather than silently rendering mixed data.
- Host-led activation is opt-in via the Map class swap. The underlying `OLVectorTileBoost` defaults remain unchanged.

## Test evidence and remaining release requirements

`npm run test:r76` covers 50 layers sharing one renderer, no original object replacements, style update, hit detection/mixed/expressions fail-closed, manual disable/re-enable, error callback fallback, detach/reattach and disposal. Ubuntu and Windows CI run it.

This is **not yet** a complete OL API compatibility claim or production release. Still needed:
- Actual Chromium + RTX same-page migration test including pixel and view behavior, layer change, and startup fallback
- Integration behavior with mixed scenes, style expressions and Hit Detection (currently stock fallback)
- Sustained soak, cross-hardware tests, production kill-switch/telemetry and licensing/security/release gates

Source architecture: `src/ol/BoostMap.js`; underlying R75 façade: `src/OLVectorTileBoost.js`.
