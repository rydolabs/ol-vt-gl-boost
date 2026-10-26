// Origin: src/renderer/integration/TileGeometryClipper.js
/** Tile-local clipping for Web Mercator MVT polygon fills and their ORIGINAL edges.
 * The tile extent is an optional neutral [minX,minY,maxX,maxY] rectangle.
 * Geometry outside the source tile is buffer data, not another visible fill.
 * Keep clipping outside RendererKernel and the WebGL backend.
 */
export function validClipExtent(extent) {
  return Array.isArray(extent) && extent.length === 4 && extent.every(Number.isFinite) &&
    extent[0] < extent[2] && extent[1] < extent[3];
}

function inside(p, edge, bounds) {
  switch (edge) {
    case 0: return p[0] >= bounds[0];
    case 1: return p[0] <= bounds[2];
    case 2: return p[1] >= bounds[1];
    default: return p[1] <= bounds[3];
  }
}
function intersect(a, b, edge, bounds) {
  const axis = edge < 2 ? 0 : 1;
  const value = bounds[edge === 0 ? 0 : edge === 1 ? 2 : edge === 2 ? 1 : 3];
  const delta = b[axis] - a[axis];
  const t = delta === 0 ? 0 : (value - a[axis]) / delta;
  const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  p[axis] = value;
  return p;
}
function clipTriangle(triangle, bounds) {
  let poly = triangle;
  for (let edge = 0; edge < 4 && poly.length; edge++) {
    const result = [];
    let previous = poly[poly.length-1], wasInside = inside(previous, edge, bounds);
    for (const current of poly) {
      const isInside = inside(current, edge, bounds);
      if (isInside !== wasInside) result.push(intersect(previous, current, edge, bounds));
      if (isInside) result.push(current);
      previous = current; wasInside = isInside;
    }
    poly = result;
  }
  return poly;
}
const twiceArea = (a,b,c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);

/** Clip already triangulated fills (including holes) against source tile extent.
 * This avoids reclassifying polygon holes or creating synthetic outer rings.
 */
export function clipTriangleMeshToExtent(mesh, bounds) {
  if (!validClipExtent(bounds) || !mesh?.length) return mesh;
  const output = [];
  for (let i=0; i+5<mesh.length; i+=6) {
    const a=[mesh[i],mesh[i+1]],b=[mesh[i+2],mesh[i+3]],c=[mesh[i+4],mesh[i+5]];
    const minX=Math.min(a[0],b[0],c[0]),maxX=Math.max(a[0],b[0],c[0]);
    const minY=Math.min(a[1],b[1],c[1]),maxY=Math.max(a[1],b[1],c[1]);
    if(maxX < bounds[0] || minX > bounds[2] || maxY < bounds[1] || minY > bounds[3]) continue;
    if(minX >= bounds[0] && maxX <= bounds[2] && minY >= bounds[1] && maxY <= bounds[3]) {
      output.push(...a,...b,...c); continue;
    }
    const clipped = clipTriangle([a,b,c],bounds);
    for(let j=1;j+1<clipped.length;j++) {
      if(Math.abs(twiceArea(clipped[0],clipped[j],clipped[j+1]))>1e-12)
        output.push(...clipped[0],...clipped[j],...clipped[j+1]);
    }
  }
  return new Float32Array(output);
}


/** Stream clipped triangles to a GPU writer callback without a JS output array
 * and without the intermediate Float32Array returned by clipTriangleMeshToExtent.
 * The callback receives the exact triangle vertex coordinates in legacy order.
 * Input is already Float32-rounded triangulation (same as the legacy path). */
export function forEachClippedTriangle(mesh, bounds, emit) {
  if (!mesh?.length) return 0;
  const doClip=validClipExtent(bounds);
  let count=0;
  for(let i=0;i+5<mesh.length;i+=6){
    const ax=mesh[i],ay=mesh[i+1],bx=mesh[i+2],by=mesh[i+3],cx=mesh[i+4],cy=mesh[i+5];
    if(!doClip){emit(ax,ay,bx,by,cx,cy);count++;continue;}
    const minX=Math.min(ax,bx,cx),maxX=Math.max(ax,bx,cx);
    const minY=Math.min(ay,by,cy),maxY=Math.max(ay,by,cy);
    if(maxX<bounds[0]||minX>bounds[2]||maxY<bounds[1]||minY>bounds[3])continue;
    if(minX>=bounds[0]&&maxX<=bounds[2]&&minY>=bounds[1]&&maxY<=bounds[3]){
      emit(ax,ay,bx,by,cx,cy);count++;continue;
    }
    const clipped=clipTriangle([[ax,ay],[bx,by],[cx,cy]],bounds);
    for(let j=1;j+1<clipped.length;j++){
      if(Math.abs(twiceArea(clipped[0],clipped[j],clipped[j+1]))>1e-12){
        emit(...clipped[0],...clipped[j],...clipped[j+1]);count++;
      }
    }
  }
  return count;
}

/** Clip the *original* edges as open paths, never stroke a newly cut tile edge. */
export function clipPolylineToExtent(points, bounds) {
  if (!validClipExtent(bounds)) return points?.length > 1 ? [points] : [];
  const paths = [];
  let run=[];
  const flush=()=>{if(run.length>1)paths.push(run);run=[];};
  const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];
  for(let i=1;i<(points?.length||0);i++) {
    const a=points[i-1],b=points[i];
    const dx=b[0]-a[0],dy=b[1]-a[1];
    if(dx===0&&dy===0)continue;
    let t0=0,t1=1,visible=true;
    // Four Liang-Barsky half-planes, without allocating four pair arrays for
    // EVERY segment. This retains exactly the same arithmetic and edge order.
    for(let edge=0;edge<4;edge++) {
      const p=edge===0?-dx:edge===1?dx:edge===2?-dy:dy;
      const q=edge===0?a[0]-bounds[0]:edge===1?bounds[2]-a[0]:edge===2?a[1]-bounds[1]:bounds[3]-a[1];
      if(p===0) {if(q<0){visible=false;break;} continue;}
      const t=q/p;
      if(p<0)t0=Math.max(t0,t);else t1=Math.min(t1,t);
      if(t0>t1){visible=false;break;}
    }
    if(!visible || t1-t0<=1e-12) {flush();continue;}
    const begin=[a[0]+t0*dx,a[1]+t0*dy],end=[a[0]+t1*dx,a[1]+t1*dy];
    if(run.length&&!same(run[run.length-1],begin))flush();
    if(!run.length)run.push(begin);
    if(!same(run[run.length-1],end))run.push(end);
    if(t1<1)flush();
  }
  flush();
  return paths;
}

// Origin: src/renderer/integration/PolygonClipPrecheck.js
/**
 * Exact conservative source-tile clipping precheck. All polygon rings (including
 * holes) must be entirely inside/outside the same half-plane for the decision.
 * An internal polygon may be triangulated without *any* post-Earcut triangle
 * clipping; triangles are convex combinations of the input ring vertices.
 *
 * Fall back for partial/boundary/invalid shapes; never fabricate cut edges.
 * Coordinates are examined in Float32 precision because the old clipping code
 * clips the triangulator's Float32Array, not the original JS doubles.
 *
 * 'inside'  => generated triangle bytes are already final; don't copy/reclip.
 * 'outside' => the entire polygon is on one exterior side; empty fill.
 * 'partial' => old per-triangle clip must be executed.
 */
export function classifyPolygonClip(rings,bounds){
  if(!validClipExtent(bounds))return 'partial';
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,seen=false;
  for(const ring of rings||[])for(const point of ring||[]){
    const x=Math.fround(Number(point?.[0])),y=Math.fround(Number(point?.[1]));
    if(!Number.isFinite(x)||!Number.isFinite(y))return 'partial';
    seen=true;
    if(x<minX)minX=x;if(x>maxX)maxX=x;
    if(y<minY)minY=y;if(y>maxY)maxY=y;
  }
  if(!seen)return 'partial';
  if(maxX<bounds[0]||minX>bounds[2]||maxY<bounds[1]||minY>bounds[3])return 'outside';
  if(minX>=bounds[0]&&maxX<=bounds[2]&&minY>=bounds[1]&&maxY<=bounds[3])return 'inside';
  return 'partial';
}
