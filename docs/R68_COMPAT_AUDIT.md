# R68 compatibility consolidation gate

Base: `main` at `2df183b7df8c7b54813328431d88913690dbe0d3`.

## Goal
Isolate the legacy `src/compat/` renderer (16 JS modules) from the CPU-first direct MVT route without deleting reachable exports or changing pixel results. R67 has already merged (53 `src/` JS/MJS modules). This branch begins with an audit gate, not unverified deletions.

## Required evidence before deletion
1. Enumerate every `src/compat/` import/export reference from `src/index.js`, `src/ol/`, `src/gl/`, `src/tile/`, `tests/`, and `examples/`; classify direct-path use, public API, or legacy-only.
2. Preserve `OpenLayersRendererBinding` and any other public exports unless a documented compatibility transition exists.
3. For candidate unused modules, demonstrate no static or dynamic import consumers and add an import-surface regression check before removal.
4. Run Ubuntu and Windows Node regression, source contract, example contract and facade contract on every code change.
5. Rerun the physical RTX 12/12 RGBA8/tile-ID matrix and 9/9 stock OL rollback on the **new candidate commit** before merge. R67 RTX results cannot certify R68 changes.

## Later vendor dependency cleanup
The `vendor/` tree still has 705 files. Do not remove it merely to reduce counts: first map the exact OpenLayers 10.10.0/earcut dependency imports, pin an npm lockfile, verify license notices, and rerun cross-platform + physical RTX gates. Keep this as a separate PR after compat cleanup.

**Current R68 status:** audit scaffold only; no compatibility source removed or changed.
