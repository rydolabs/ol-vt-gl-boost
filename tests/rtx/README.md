# Physical RTX E2E

Run these only on a real Windows RTX 5060 Ti (or extend the hardware gate intentionally), with Google Chrome and Node.js 22.

```bash
npm install --no-save --package-lock=false --ignore-scripts playwright@1.55.0
npm run test:rtx:prepare
npm run test:rtx
npm run test:rtx:rollback
```

`test:rtx` runs 8/16/32 distinct sources × DPR1/2 × two delay seeds, comparing 512×512 raw RGBA8 bytes and complete tile IDs against independent fresh-load OpenLayers B. The test additionally requires real stale callbacks and retry observations. `test:rtx:rollback` injects an app-level M5 error, stops binding and checks stock OL drag/wheel responsiveness. **It does not simulate every spontaneous GPU context failure.**

Original hardware oracle code is derived from the SHA-pinned R61/R63 harness in `nssang00/chatgpt-write-test`; imports and HTTP fixture routes were updated for this repository. Any subsequent renderer changes must be checked on both Node and the physical GPU.

Headless WebGL on a software renderer is insufficient: the original RTX oracle requires NVIDIA hardware in the ANGLE renderer string.
