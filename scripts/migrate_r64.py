#!/usr/bin/env python3
"""Reconstruct pinned R62 sources then mechanically group R64 modules.
This is an integration transition script, not a runtime package installer.
"""
import hashlib,json,pathlib,posixpath,re,sys,zipfile
root=pathlib.Path.cwd()
archive=pathlib.Path(sys.argv[1])
EXPECTED="5ce32662ad837297e565c3e8df6cddea80c62cb8f14ecf12bc6348f788fcb846"
if hashlib.sha256(archive.read_bytes()).hexdigest()!=EXPECTED:raise SystemExit("R62 source archive hash mismatch")
z=zipfile.ZipFile(archive)
names={x.replace("\\","/"):x for x in z.namelist()}
def put(p,data):
    f=root/p;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(data)
def get(p):return z.read(names[p])
origins={}
raw={}
for name in names:
    if name.startswith("our-renderer/") and name.endswith((".js",".mjs",".md")):
        rel=name.removeprefix("our-renderer/")
        if re.search(r"(?:\.preloop|\.audit(?:style|_R\d+)?|\.before_round\d+|\.round\d+_reference|\.legacy)\.js$",rel):continue
        old="src/renderer/"+rel
        raw[old]=get(name)
assert len(raw)==62, ("Unexpected R62 renderer file count",len(raw))
tests="""verify_r45_handover.mjs verify_r45_duplicate_cpu_equivalence.mjs verify_r34_shared_worker_pool.mjs verify_r33_worker_pool.mjs verify_direct_feature_edge_cases.mjs verify_bundled_mvt_runtime.mjs verify_direct_m5_scene_binding.mjs verify_direct_feature_shared_webgl_arena.mjs verify_tile_clipping.mjs verify_resource_tile_ids.mjs verify_integration.mjs verify_polygon_clip_precheck.mjs verify_polygon_ol_cpu_pipeline.mjs verify_stream_upload_batch.mjs verify_geometry_upload_batch.mjs verify_direct_renderfeature_buffers.mjs verify_real_mvt_parts_flat_parity.mjs""".split()
assert len(tests)==17
for name in tests:
    text=get("tests/"+name).decode().replace("../our-renderer/","../src/renderer/")
    put("tests/"+name,text.encode())
for name in names:
    if (name.startswith("vendor/") or name.startswith("tests/fixtures/seoul/")) and not name.endswith("/"):
        put(name,get(name))
origins.update({key:hashlib.sha256(value).hexdigest() for key,value in raw.items()})
vendor=[n for n in names if n.startswith("vendor/") and not n.endswith("/")]
assert len(vendor)>=703
provenance={"schema":"m5-stable-source-migration-v1","source_build":"R35 original + R45 CPU-first/deferred Worker opt-in + R48 CPU line-join fallback",
 "source_archive_sha256":EXPECTED,"origin_repository":"https://github.com/nssang00/chatgpt-write-test",
 "files":[{"path":name,"sha256":digest} for name,digest in sorted(origins.items())]}
put("docs/SOURCE_PROVENANCE.json",(json.dumps(provenance,indent=2)+"\n").encode())
groups={
"ol/layer-state.js":["adapters/openlayers/OlLayerAdapter.js","adapters/openlayers/OlLayerLifecycleAdapter.js"],
"ol/frame.js":["adapters/openlayers/OlFrameAdapter.js","adapters/openlayers/OlMapFrameBridge.js"],
"ol/host.js":["adapters/openlayers/OlCanvasHost.js","adapters/openlayers/OlTargetLifecycleAdapter.js"],
"tile/clip.js":["integration/TileGeometryClipper.js","integration/PolygonClipPrecheck.js"],
"compat/renderers.js":["renderers/SimpleRenderer.js","renderers/PointRenderer.js","renderers/PolygonRenderer.js"]}
reverse={name:"src/"+out for out,members in groups.items() for name in members}
glcore=set("ResourceManager GeometryAllocator TextureCache GpuBudgetController MaintenanceScheduler TileResourceStore ReferenceIndexStream".split())
legacy=set("RendererFeatureSink RendererLayerBindingPort RendererSceneCoordinator RendererVectorTileSink".split())
def dst(old):
    n=old.removeprefix("src/renderer/")
    if n in reverse:return reverse[n]
    if n=="OpenLayersRendererBinding.js":return "src/compat/OpenLayersRendererBinding.js"
    if n=="VectorRenderer.js":return "src/compat/VectorRenderer.js"
    if n.startswith("adapters/openlayers/"):return "src/ol/"+n.split("/",2)[2]
    if n.startswith("adapters/maptiler/"):return "src/compat/"+n.split("/",2)[2]
    if n.startswith("backend/"):return "src/gl/backend.js"
    if n.startswith("shaders/"):return "src/gl/shaders.js"
    if n.startswith("renderers/"):return "src/gl/"+n.removeprefix("renderers/")
    if n.startswith("core/"):return ("src/gl/" if pathlib.PurePosixPath(n).stem in glcore else "src/compat/core/")+n.removeprefix("core/")
    if n.startswith("integration/workers/"):return "src/optional/worker/"+n.removeprefix("integration/workers/")
    if n.startswith("integration/"):
        base=n.removeprefix("integration/")
        if base=="DirectM5SceneBinding.js":return "src/ol/scene.js"
        if base=="OLDisableWorkerM4Bridge.js":return "src/ol/bridge.js"
        if base=="DirectFeatureWebGLPipeline.js":return "src/gl/pipeline.js"
        return ("src/compat/" if pathlib.PurePosixPath(n).stem in legacy else "src/tile/")+base
    raise ValueError(n)
moves={k:dst(k) for k in raw}
assert len(set(moves.values()))==56, len(set(moves.values()))
refs=re.compile(r"""(['"])(\.{1,2}/[^'"\n]+)\1""")
def rewrite(old,new,text):
    def sub(m):
        target=posixpath.normpath(posixpath.join(posixpath.dirname(old),m.group(2)))
        if target in moves:
            target=moves[target]
        elif old!=new and (root/target).exists():
            pass
        else:return m.group(0)
        path=posixpath.relpath(target,posixpath.dirname(new) or ".")
        if not path.startswith("."):path="./"+path
        return m.group(1)+path+m.group(1)
    return refs.sub(sub,text)
outputs={}
for old,b in raw.items():
    new=moves[old]
    if list(moves.values()).count(new)==1:
        outputs[new]=rewrite(old,new,b.decode()) if not old.endswith(".md") else b.decode()
for target,parts in groups.items():
    new="src/"+target
    chunks=[]
    for rel in parts:
        old="src/renderer/"+rel
        text=rewrite(old,new,raw[old].decode())
        lines=[]
        for line in text.splitlines():
            mat=re.search(r"""^\s*import .* from ['"](\.{1,2}/[^'"]+)['"]""",line)
            if mat and posixpath.normpath(posixpath.join(posixpath.dirname(new),mat.group(1)))==new:continue
            lines.append(line)
        chunks.append("// Origin: "+old+"\n"+"\n".join(lines)+"\n")
    outputs[new]="\n".join(chunks)
for new,text in outputs.items():put(new,text.encode())
put("src/index.js",b"""export {DirectM5SceneBinding} from './ol/scene.js';
export {OpenLayersRendererBinding} from './compat/OpenLayersRendererBinding.js';
export {WebGL1Backend} from './gl/backend.js';
export {DirectFeatureWebGLPipeline,encodeDirectFeatureTile} from './gl/pipeline.js';
""")
for file in (root/"tests").glob("verify_*.mjs"):
    if file.name=="verify_cpu_first_release_contract.mjs":continue
    original=file.read_text()
    changed=rewrite(file.relative_to(root).as_posix(),file.relative_to(root).as_posix(),original)
    if changed!=original:file.write_text(changed)
contract="""import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DirectM5SceneBinding} from '../src/index.js';
const t=p=>readFileSync(p,'utf8');
const p=t('src/gl/pipeline.js'),b=t('src/ol/scene.js');
assert.match(p,/const gpu=null; \\/\\/ R48 strict-OL candidate: use existing CPU line-join encoder/);
assert.match(b,/deferredWorker=null/);
assert.match(b,/deferredWorker\\?\\.enabled===true/);
assert.equal(typeof DirectM5SceneBinding,'function');
const a=JSON.parse(t('docs/REFACTOR_PROVENANCE.json'));
const o=JSON.parse(t('docs/SOURCE_PROVENANCE.json'));
assert.equal(a.workerDefault,'off');
assert.equal(a.fileMapping.length,62);
for(const row of a.fileMapping){
 const h=createHash('sha256').update(readFileSync(row.new)).digest('hex');
 assert.equal(h,row.newSha256,row.new);
 assert.equal(o.files.find(f=>f.path===row.original)?.sha256,row.oldSha256,row.original);
}
console.log('R64_CONTRACT_PASS',a.newSourceModuleCount);
"""
put("tests/verify_cpu_first_release_contract.mjs",contract.encode())
unit="""import {spawnSync} from 'node:child_process';
const tests=TEST_NAMES;
for(const name of tests){
 const p=spawnSync(process.execPath,['tests/'+name],{encoding:'utf8',timeout:120000,maxBuffer:10485760});
 console.log(p.status===0?'PASS':'FAIL',name);
 if(p.status!==0||p.error){console.error(p.stdout,p.stderr,p.error);process.exit(1)}
}
console.log('UNIT_17_17_PASS');
""".replace("TEST_NAMES",json.dumps(tests))
put("scripts/run-unit-tests.mjs",unit.encode())
put("package.json",(json.dumps({"name":"ol-vt-gl-boost","version":"0.1.0-beta.0","private":True,
"type":"module","scripts":{"test":"node scripts/run-unit-tests.mjs",
"test:contract":"node tests/verify_cpu_first_release_contract.mjs"},
"engines":{"node":">=22 <24"}},indent=2)+"\n").encode())
manifest={"schema":"r64-functional-layout","sourceSha256":EXPECTED,"workerDefault":"off",
"newSourceModuleCount":len(outputs)+1,
"fileMapping":[{"original":old,"new":new,"oldSha256":origins[old],
"newSha256":hashlib.sha256(outputs[new].encode()).hexdigest()} for old,new in sorted(moves.items())]}
put("docs/REFACTOR_PROVENANCE.json",(json.dumps(manifest,indent=2)+"\n").encode())
print("R64_BOOTSTRAP_SUCCESS",json.dumps({"old":len(raw),"modules":len(outputs)+1,"unit":len(tests),"vendor":len(vendor)}))
