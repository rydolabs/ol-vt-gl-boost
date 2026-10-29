# R75 — CPU priming diagnostics and layer compositor GL resource lifecycle

Status: **development-only candidate** based on R74 `aa0278a77c21f804934733e4d08114b9752e66ae`. Production remains **NO-GO**. This change does not claim any additional first-frame speedup.

## CPU priming diagnostics (opt-in)

With `OLVectorTileBoost({stockOlRenderMode:'exclusive', vectorTileOptions:{profileCPU:true}})`, `boost.snapshot().exclusiveHost` adds `priming.calls`, `totalMs`, `visited`, `urlRejected`, `cacheHits`, `requested`, `tileUrlMs`, `getTileMs`, `getSourceTilesMs`, and the last invocation's `lastPrime` (including `elapsedMs`).

These are **synchronous host timings**. They exclude asynchronous PBF fetch/decode, GPU completion, and map/layer construction. `getSourceTilesMs` is not the time until a tile finishes loading. Existing per-tile `profileCPU` diagnostics remain in the scene snapshot. Profiling is disabled for baseline ABBA measurements.

## FBO lifecycle

The compositor now releases framebuffer/texture/quad resources on stop; reuses the quad on resize; drops stale GL references on context restoration without deleting on a lost context; and cleans up partial allocations when framebuffer initialization fails. GL resource ownership is tracked by the original context. Applications remain responsible for context loss/restored event handling and calling the existing restore API.

## Validation gates

`npm run test:r75` covers deterministic host sampling and mocked GL compositor lifecycle cases. Both run in Ubuntu/Windows Node22 CI. These tests do not substitute for the RTX 12 RGBA8 + 9 stock-OL fallback validations, 60 raw ABBA samples, physical browser context loss, sustained memory, FPS or pan/zoom tails. Do not merge as production GO without those gates.
