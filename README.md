# OL VT GL Boost

**CPU-first optimized WebGL vector-tile rendering path for OpenLayers.**

The repository keeps OpenLayers Map / View / VectorTileSource integration while providing a direct geometry-to-GPU pipeline, a strict CPU line-join fallback for pixel correctness, and an optional deferred Worker (default **OFF**). **Experimental: not production-approved.**

## Performance vs stock OpenLayers 10.10.0

The following is an **historical R48 controlled RTX benchmark (2026-10-24)**, not a newly measured result for the merged R64 `main` branch.

| Different MVT sources | Stock OL 10.10.0 (A / B) | Optimized R48 CPU-first (A / B) | Captured-frame latency reduction (A / B) |
|---:|---:|---:|---:|
| **8** | 123.0 / 104.7 ms | 45.5 / 37.9 ms | **63.0% / 63.8%** |
| **16** | 177.0 / 159.0 ms | 39.4 / 39.0 ms | **77.7% / 75.5%** |
| **32** | 282.6 / 283.5 ms | 62.0 / 72.0 ms | **78.1% / 74.6%** |

**Test conditions:** NVIDIA GeForce RTX 5060 Ti, Windows Chrome / ANGLE D3D11, 512×512 RGBA8, DPR1; 8/16/32 distinct Innsbruck MapLibre/OpenMapTiles XYZ12 PBF fixtures; preloaded inputs (network/texture fetch excluded); A/B are paired ABBA order positions, with **3 samples per scene per arm**. Table values are per-arm medians of `coldToCapturedFrameMs` — the test harness's cold-to-GPU-completed **captured frame**, including `gl.finish`, two RAFs, and pixel readback. Lower is better. Reduction is `(OL time − R48 time) / OL time × 100`. **This is not sustained FPS, pure user-visible first paint, interactive latency, or a universal performance claim.**

**Important configuration caveat:** the R48 CPU-first experimental arm used the R45 **deferred Worker enabled** path (`r45.enabled=true`, although an older `workerPoolMode=off` field appears in the artifact); the CPU first frame did not wait for Worker completion. The current repository defaults to **Worker OFF**, so these percentages **do not establish its current default-mode advantage over OL 10.10.0**. Separate real-UI R59/R60 comparisons found no dependable advantage from enabling deferred Worker. R64/R65 validated post-refactor correctness, **not a fresh OL performance benchmark**.

**Evidence:** [R48 physical RTX workflow](https://github.com/nssang00/chatgpt-write-test/actions/runs/40092410654) · [original benchmark artifact #12560052843](https://github.com/nssang00/chatgpt-write-test/actions/runs/40092410654/artifacts/12560052843) · [full methodology and limitations](docs/benchmarks/ol-10.10.0-r48.md) · [source median/sample CSV](docs/benchmarks/ol-10.10.0-r48-abba.csv). Original artifact SHA-256: `cf509e46261802c560d9cd6d09f97cbd61069f16ad2b0303b4209114ae8a00c1`.

## Architecture

| Path | Responsibility |
|---|---|
| `src/ol/` | OpenLayers maps, layers, frames, tiles and lifecycle |
| `src/tile/` | Vector-tile geometry, clipping and encoding |
| `src/gl/` | WebGL1 backend, GPU resources, drawing |
| `src/optional/worker/` | Optional deferred Worker path (**OFF** by default) |
| `src/compat/` | Legacy renderer and compatibility entrypoints |
| `src/index.js` | Public module entrypoints |

## Accuracy and validation

- Historical **R48**: 12/12 exact 512×512 RGBA8 comparisons against stock OpenLayers 10.10.0 for 8/16/32 sources in its controlled test; CPU line-join fallback remains necessary.
- **R65 post-refactor physical RTX**: 12/12 strict raced-vs-fresh clean-view RGBA8 and complete tile-ID matches across DPR1/2 × 8/16/32 MVT sources × 2 seeds; injected M5 fault correctly fell back to stock OL and accepted real mouse/zoom input. This **is not** an additional stock-OL pixel benchmark or general proof of spontaneous GPU fault recovery.
- **Ubuntu and Windows GitHub Actions**: 17 Node regressions + release-contract checks pass on `main`: [CI evidence](https://github.com/rydolabs/ol-vt-gl-boost/actions/runs/40311343548).
- Run `npm test` and `npm run test:contract`; `npm run test:rtx` requires an appropriately configured Windows RTX/Chrome environment.

R65 evidence: [self-hosted RTX run](https://github.com/nssang00/chatgpt-write-test/actions/runs/40296090427) (testing the reorganized repository's code at `c483edba13265e332bb65f76b1aaef15bbde243c`).

## Release status

**Production: NO-GO.** No npm release, no demonstrated across-hardware speed guarantee, and no production host kill-switch / deployment contract. Worker ON is not a performance default. The source originated from [M5 experimental validation PR #23](https://github.com/nssang00/chatgpt-write-test/pull/23). See [R64 structure and provenance](docs/STRUCTURE_R64.md). Original third-party license files are retained in the pinned vendor runtime; a license for independently redistributing this project's own source has **not yet been granted or selected**.
