# R69 — npm-managed OpenLayers 10.10.0 vendor runtime

## Objective
Avoid version-drifting 703 tracked npm distribution files. On Node.js 22, run `npm ci` after clone. It uses the committed `package-lock.json`, then `postinstall` executes `scripts/restore-vendor-runtime.mjs`, reconstructing the same compatibility import location `vendor/openlayers-10.10.0-runtime/node_modules`.

## Pinned packages
`ol@10.10.0`, `earcut@3.2.3`, `pbf@5.1.2`, `rbush@4.0.1`, `quickselect@3.0.0`, with exact transitive resolution in `package-lock.json`. Other transitive npm packages and their license files are copied as-installed; root `package.json` stays `private:true`. The two historical metadata files (`VERSION.txt`, `GIT_SHA.txt`) remain.

## Original source differences — preserved verbatim
A full byte comparison against npm-installed files found only:
- `vendor/overrides/earcut/src/earcut.js`: original customized Earcut, original Git blob `cfecdeb4460149508c88ac0571a23a8544755008` (ISC).
- `vendor/overrides/ol/format/MVT.worker.js`: original custom MVT Worker module absent from published npm OL; Git blob `5d5f66f0550b395b3cd5f7a1dbf44f08a8a6ebb3` (the project's provenance/license status is not changed).

`scripts/restore-vendor-runtime.mjs` overlays exactly those two saved original blobs onto the newly restored npm files. For a checkout still containing the old vendor directory, it audits original vs npm before replacement and fails closed if it finds any additional difference. After deletion, both saved patches are required to be present.

## Validation and limitations
- No Javascript render algorithm / shader / resource pipeline is changed.
- CI must run `npm ci` **before** `npm test`, `npm run test:contract`, `npm run test:examples`, `npm run test:facade`, `npm run test:compat`, and `npm run test:vendor`.
- Physical RTX 12/12 RGBA8 plus tile oracle and actual stock OpenLayers fallback must be rerun after this change; installing identical versions is not a substitute for GPU evidence.
- This runtime is source-compatible only within the supported ESM / browser test harness. It is **not an npm-published library** and does not offer a bundler-ready production distribution.
- Network access to the npm registry is required for first installation. Vendor licenses are provided as part of npm dependency packages.
