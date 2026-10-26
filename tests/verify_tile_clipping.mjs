import assert from 'node:assert/strict';
import {clipTriangleMeshToExtent,clipPolylineToExtent} from '../src/tile/clip.js';
import {NeutralGeometryCompiler} from '../src/tile/NeutralGeometryCompiler.js';
import {EarcutPolygonTriangulator} from '../src/tile/EarcutPolygonTriangulator.js';
const rect=[0,0,10,10];
const original=new Float32Array([-2,-2,12,-2,12,12,-2,-2,12,12,-2,12]);
const clipped=clipTriangleMeshToExtent(original,rect);
assert(clipped.length>=6);for(let i=0;i<clipped.length;i+=2){assert(clipped[i]>=0&&clipped[i]<=10);assert(clipped[i+1]>=0&&clipped[i+1]<=10)}
let filled=0;for(let i=0;i<clipped.length;i+=6)filled+=Math.abs((clipped[i+2]-clipped[i])*(clipped[i+5]-clipped[i+1])-(clipped[i+3]-clipped[i+1])*(clipped[i+4]-clipped[i]))/2;
assert(Math.abs(filled-100)<1e-5,`Fill area ${filled}`);
const outside=clipPolylineToExtent([[12,0],[12,10]],rect);assert.equal(outside.length,0,'No synthetic tile edge stroke');
const cross=clipPolylineToExtent([[-5,5],[5,5],[15,5]],rect);assert.equal(cross.length,1);assert.deepEqual(cross[0],[[0,5],[5,5],[10,5]]);
const joined=clipPolylineToExtent([[-5,-5],[15,15],[15,-5]],rect);assert.equal(joined.length,1);assert.deepEqual(joined[0],[[0,0],[10,10]]);
// Hole must remain unfilled after triangulating then clipping triangles.
const compiler=new NeutralGeometryCompiler({polygonTriangulator:new EarcutPolygonTriangulator()});
const holePoly={kind:'polygon',clipExtent:rect,rings:[[[ -4,-4],[14,-4],[14,14],[-4,14],[-4,-4]],[[4,4],[4,6],[6,6],[6,4],[4,4]]]};
const triangles=compiler.compile(holePoly).data;let area=0;for(let i=0;i<triangles.length;i+=6)area+=Math.abs((triangles[i+2]-triangles[i])*(triangles[i+5]-triangles[i+1])-(triangles[i+3]-triangles[i+1])*(triangles[i+4]-triangles[i]))/2;
assert(Math.abs(area-96)<1e-3,`Hole fill area ${area}`);
console.log(JSON.stringify({pass:true,filledArea:filled,polygonHoleArea:area,triangles:triangles.length/6,clippedOutsideStrokes:outside.length}));
