# R83 release-safety gates — experimental branch (2026-11-09)

This is a **candidate change**, not a production release or approval to merge.

## Scope and behavior

- `BoostMap` defaults to **strict per-frame WebGL error checks**. Unlike the former nonblocking default, this detects `INVALID_OPERATION` and other non-context-loss GL errors and triggers the existing fail-closed restoration of native OpenLayers layer renderers.
- Callers may explicitly set `boostOptions.backendOptions.glErrorCheckMode: 'nonblocking'` for controlled performance tests. This bypasses all per-frame `getError()` calls; arbitrary GL errors not involving context loss **can remain undetected**, so it is **not the production-safe default**.
- The BoostMap adapter observes nested OL layer collections (synchronous `add`/`remove` listeners), root replacement and `postrender` safety checks. Any change to the vector tile layer membership while Boost is active, or any mixed/unsupported layers or style variables, tears down Boost and restores Stock OpenLayers. After returning to an eligible scene, callers must explicitly call `enableBoost()`.
- Style eligibility is checked on every layer `change`, even if `style_` and source object identities did not change. The `postrender` fallback also detects in-place changes without an emitted event, after the frame callback. This does **not** guarantee no intermediate unsafe pixels before that detection; the synchronous collection event covers the normal public layer-add/remove APIs.
- The adapter still accesses OpenLayers 10.10.0 private properties and overrides a per-instance renderer method. Future OL versions require revalidation.

## Performance comparability

R79–R82 GPU/CPU benchmark claims were collected with **nonblocking** error handling. These figures must not be represented as measurements of the new **strict default**. Record a new same-SHA Stock-vs-strict Boost benchmark (first-complete frame, CPU submission, GPU timing and visual gate) before publishing production speed claims.

## Existing blockers not addressed by this code change

1. Physical 32-layer screenshot differences remain **4.06%** of pixels; owner approval of tolerance and richer style/geometry regression are outstanding.
2. Physical-monitor displayed FPS has not been measured; Windows PresentMon ETW capture on the RDP runner yielded zero attributable Chrome rows. Displayed FPS must not be inferred from GPU timer query results or rAF.
3. At least 30-minute per-process GPU memory leak/stability testing is not yet validated.
4. Source distribution licensing is missing (`private: true`, no top-level `LICENSE`). Publication must await a deliberate license and rights decision.
5. Human PR review, final integrated SHA CI/RTX retest, and explicit merge/release authorization are required.

## New verification

- `npm run test:r83`: deterministic strict-default, nested layer-tree, variables, same-reference style, and OL renderer restoration cases.
- `node tests/browser/run_r83_release_safety.mjs . artifacts/r83-release-safety`: real OL 10.10.0 browser tests on controlled local MVT using actual scene, injected non-context-loss GL error and dynamic map modifications.
- `.github/workflows/r83-release-safety.yml`: Ubuntu/Windows unit regressions plus Windows SwiftShader real browser/PNG evidence.

This release-safety branch is stacked on the unchanged Draft PR #14 head, not merged into main.
