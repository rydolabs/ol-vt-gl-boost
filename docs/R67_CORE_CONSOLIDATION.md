# R67 Core Consolidation

## Scope

R67 is a **behavior-preserving module consolidation**, not a performance optimization or release authorization. Starting from `main` at `d60cb69d98e7f44202c9a179d3369c683c930c2e`, the 56 executable JS/MJS modules become **53**. A new `src/OLVectorTileBoost.js` public facade composes the existing validated Direct scene and WebGL1 backend. It does not replace the existing `DirectM5SceneBinding` API.

| Former independent modules | Unified module | Purpose |
|---|---|---|
| `gl/GpuBudgetController.js` + `gl/MaintenanceScheduler.js` | `gl/resource-policies.js` | GPU budget and maintenance policies |
| `ol/layer-state.js` + `ol/OlLayerTreeAdapter.js` | `ol/layer.js` | Layer state and OL tree observation |
| `ol/OlGeometryAdapter.js` + `ol/OlFeatureAdapter.js` | `ol/feature.js` | Geometry and feature conversion |
| `tile/DirectFeatureFlatTriangulation.js` + `tile/DirectFeaturePolygonBuffers.js` | `tile/polygon.js` | Flat polygon triangulation and indexed-buffer emission |

8 existing files consolidated into 4, plus 1 new facade; reduction: 3 executable files. All relative imports in consumers were updated; original encoding and GPU resource algorithms were copied without arithmetic reordering.

## Stable public API

`OLVectorTileBoost` constructor options: `{map, canvas?, backend?, backendOptions?, resourceManager?, canvasMode?, canvasFactory?, vectorTileOptions?, layerStyleResolver?, onError?, strictVectorTiles?, deferredWorker?}`. If no backend is supplied, WebGL1 is created from the canvas. Methods: `start(options)`, `stop()`, `destroy()`, `sync()`, `snapshot()`, `restoreAfterContextLoss(backend?)`. Properties: `started`, `workerEnabled`. Defaults retain Worker OFF; the facade does not silently enable deferred Worker, switch WebGL versions, or auto-restore stock OL.

## Regression contract

- `npm test`: original 17 Node regressions.
- `npm run test:contract`: original pinned R64 per-file SHA256 for unchanged files, original-source SHA256 provenance for all 62 original mappings, Git blob SHA1 for consolidated/modified runtime modules recorded in `docs/R67_PROVENANCE.json`; original Worker OFF and R48 line-join CPU fallback assertions.
- `npm run test:examples`: existing stock OL 10.10.0 vs Boost side-by-side static example checks.
- `npm run test:facade`: new single-class lifecycle and Worker default test.
- Ubuntu and Windows GitHub Actions run these checks for PRs targeting `main`.

The R67 physical RTX 8/16/32 × DPR1/2 × 2-seed byte-exact matrix and real OL rollback **must be rerun** before concluding full GPU parity after consolidation. Old R65 evidence remains historical and must not be mislabeled R67. The current performance table is R48 historical, not a new Worker OFF benchmark.

## Next scoped simplification

After hardware parity, consolidate the OL VectorTile source/feature/pruner logic and draw-packet construction only with separate precise tests. Avoid merging `src/gl/pipeline.js` and `src/gl/ResourceManager.js` into a massive untestable class merely to reduce file count. Production remains NO-GO.
