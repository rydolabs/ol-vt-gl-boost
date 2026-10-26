import {spawnSync} from 'node:child_process';
const tests=["verify_r45_handover.mjs", "verify_r45_duplicate_cpu_equivalence.mjs", "verify_r34_shared_worker_pool.mjs", "verify_r33_worker_pool.mjs", "verify_direct_feature_edge_cases.mjs", "verify_bundled_mvt_runtime.mjs", "verify_direct_m5_scene_binding.mjs", "verify_direct_feature_shared_webgl_arena.mjs", "verify_tile_clipping.mjs", "verify_resource_tile_ids.mjs", "verify_integration.mjs", "verify_polygon_clip_precheck.mjs", "verify_polygon_ol_cpu_pipeline.mjs", "verify_stream_upload_batch.mjs", "verify_geometry_upload_batch.mjs", "verify_direct_renderfeature_buffers.mjs", "verify_real_mvt_parts_flat_parity.mjs"];
for(const name of tests){
 const p=spawnSync(process.execPath,['tests/'+name],{encoding:'utf8',timeout:120000,maxBuffer:10485760});
 console.log(p.status===0?'PASS':'FAIL',name);
 if(p.status!==0||p.error){console.error(p.stdout,p.stderr,p.error);process.exit(1)}
}
console.log('UNIT_17_17_PASS');
