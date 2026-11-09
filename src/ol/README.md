# OpenLayers Adapter Boundary

OpenLayers-specific integration lives here and nowhere else.

## Dependency rule

The adapter currently uses **no runtime `ol/*` imports**. It consumes the stable/public OL object shape (`getType()`, `getCoordinates()`, `getId()`, `getGeometry()`, `getStyle()`, `frameState.viewState`, etc.). This deliberately keeps the renderer core and memory system independent of the installed OpenLayers version.

If a future feature genuinely requires a concrete OL helper, that import must remain inside this directory and must never be re-exported into `core/`, `renderers/`, or `backend/`.

## Modules

- `OlGeometryAdapter.js` — OL geometry -> neutral geometry descriptors. Supports Point/MultiPoint, LineString/MultiLineString, Polygon/MultiPolygon, Circle, GeometryCollection.
- `OlStyleAdapter.js` — classic `Style` and literal FlatStyle -> neutral style descriptors; exposes a renderer-subset conversion separately.
- `OlFrameAdapter.js` — `frameState`/`viewState` -> neutral frame descriptor.
- `OlFeatureAdapter.js` — stable feature identity + properties + neutral geometry/style snapshot.
- `OpenLayersAdapter.js` — thin orchestration boundary with an optional injected sink port.

## Allowed responsibilities

- convert `ol/Feature` geometry into neutral geometry payloads
- translate OL style objects/expressions into renderer style descriptors
- translate OL frame/view state into neutral render-frame inputs
- map source/layer/feature lifecycle into RenderReference/resource lifecycle
- bridge hit detection / interaction without exposing allocator offsets

## Forbidden

- importing OL from `core/`, `renderers/`, or `backend/`
- exposing physical GPU offsets to OL objects
- letting allocator/resource-manager code depend on OL classes/events
- storing WebGL handles on OL features/layers
- making core behavior conditional on `instanceof` an OL class

## Current milestone boundary

This is **adapter milestone 1**: neutral conversion contracts only. It intentionally does not yet perform polygon triangulation, expression evaluation, OL source event subscription, renderer attachment, or hit detection. Those are subsequent modules so that each concern remains independently testable.

## Milestone 2 additions

- `OlSourceLifecycleAdapter.js` converts `VectorSource`-style `addfeature`, `removefeature`, `clear`, and feature `change` events into neutral sink operations.
- The adapter still has no runtime `ol/*` imports and does not know renderer IDs, allocator offsets, or WebGL handles.
- Renderer attachment is performed by an external sink/composition layer. `integration/RendererFeatureSink.js` is one such host-neutral bridge.
- Polygon compilation is outside the OL adapter (`integration/NeutralGeometryCompiler.js`). M2 supports simple/concave outer rings and deliberately rejects holes rather than rendering them incorrectly.

### Extended actual-runtime coverage

The adapter now also exposes neutral layer state (`visible`, `opacity`, `zIndex`) and the integration sink can split one polygon Style into fill and stroke render parts. Point styles support circle/square plus generic sprite descriptors used for already-loaded OL Icons and rasterized Text labels. These remain generic renderer/resource descriptors; no OL class is imported by core/renderers.

## Ordering / LayerGroup milestone

- `OlLayerTreeAdapter.js` observes a public OL `LayerGroup`/`Collection` tree without importing OL classes.
- It flattens leaf layers into neutral `{sequence, visible, opacity, zIndex}` state.
- Nested group `visible` and `opacity` are inherited; a group's defined `zIndex` becomes the default only for descendants whose own zIndex is undefined, matching OL 10.10.0 group state behavior.
- Collection `add/remove` changes recompute leaf sequence, so equal-zIndex layers follow the current OL collection order.
- Style zIndex is carried separately as `sceneStyleZIndex`; it never gets folded into the layer zIndex. Layer order therefore dominates feature/style zIndex, while style zIndex orders render buckets inside one layer.
