import earcut from '../../vendor/openlayers-10.10.0-runtime/node_modules/earcut/src/earcut.js';

/** Use source RenderFeature coordinates without creating one [x,y] object per point.
 * Closure/duplicate removal and original-vertex order are identical to
 * materializeFlatPolygonRings() + EarcutPolygonTriangulator.cleanRing(). */
function cleanedFlatRing(flat,start,end,stride){
  const result=[];
  const n=(end-start)/stride;
  if(!n)return result;
  const firstX=Number(flat[start]),firstY=Number(flat[start+1]);
  const lastX=Number(flat[end-stride]),lastY=Number(flat[end-stride+1]);
  const stop=(n>1&&firstX===lastX&&firstY===lastY)?end-stride:end;
  let hasLast=false,lastSeenX,lastSeenY;
  for(let i=start;i<stop;i+=stride){
    const x=Number(flat[i]),y=Number(flat[i+1]);
    if(hasLast&&x===lastSeenX&&y===lastSeenY)continue;
    result.push(x,y);hasLast=true;lastSeenX=x;lastSeenY=y;
  }
  return result;
}

// Ring order, cleaning and index generation match EarcutPolygonTriangulator.
export function triangulateEarcutFlat(flat,ranges,stride=2){
  const coords=[],holes=[];
  for(const [start,end] of ranges){
    const cleaned=cleanedFlatRing(flat,start,end,stride);
    if(cleaned.length<6)continue;
    if(coords.length)holes.push(coords.length/2);
    for(let j=0;j<cleaned.length;j++)coords.push(cleaned[j]);
  }
  if(!coords.length)return new Float32Array(0);
  const indices=earcut(coords,holes,2);
  const out=new Float32Array(indices.length*2);
  let o=0;for(const idx of indices){out[o++]=coords[idx*2];out[o++]=coords[idx*2+1];}
  return out;
}

// Same original ear clipping algorithm/order; only the intermediate vertex
// representation changes from an array of [x,y] to interleaved doubles.
export function triangulateSimpleFlat(flat,start,end,stride=2,bbox=true){
  const ring=cleanedFlatRing(flat,start,end,stride),count=ring.length/2;
  if(count<3)return new Float32Array(0);
  // R29 opt-in: linearithmic earcut on partial single-ring polygon meshes.
  // Outputs mathematically equivalent triangle coverage with different internal
  // tessellation, so require an independent exact GPU output gate before use.
  if(globalThis.__m5R29EarcutPartial===true){
    const ids=earcut(ring,null,2),result=new Float32Array(ids.length*2);
    for(let i=0;i<ids.length;i++){result[2*i]=ring[2*ids[i]];result[2*i+1]=ring[2*ids[i]+1];}
    return result;
  }
  let signedArea=0;
  for(let i=0,j=count-1;i<count;j=i++){
    signedArea+=ring[2*j]*ring[2*i+1]-ring[2*i]*ring[2*j+1];
  }
  const ids=Array.from({length:count},(_,i)=>signedArea<0?count-1-i:i);
  const tris=[];
  let guard=0;
  const cross=(ia,ib,ic)=>{
    const a=ia*2,b=ib*2,c=ic*2;
    return (ring[b]-ring[a])*(ring[c+1]-ring[a+1])-(ring[b+1]-ring[a+1])*(ring[c]-ring[a]);
  };
  while(ids.length>3&&guard++<count*count){
    let clipped=false;
    for(let k=0;k<ids.length;k++){
      const ia=ids[(k-1+ids.length)%ids.length],ib=ids[k],ic=ids[(k+1)%ids.length];
      if(cross(ia,ib,ic)<=0)continue;
      const a=ia*2,b=ib*2,c=ic*2;
      const lowX=bbox?Math.min(ring[a],ring[b],ring[c]):0;
      const highX=bbox?Math.max(ring[a],ring[b],ring[c]):0;
      const lowY=bbox?Math.min(ring[a+1],ring[b+1],ring[c+1]):0;
      const highY=bbox?Math.max(ring[a+1],ring[b+1],ring[c+1]):0;
      let contains=false;
      for(const id of ids){
        if(id===ia||id===ib||id===ic)continue;
        const point=id*2,x=ring[point],y=ring[point+1];
        if(bbox&&Number.isFinite(x)&&Number.isFinite(y)&&(x<lowX||x>highX||y<lowY||y>highY))continue;
        const c1=cross(ia,ib,id),c2=cross(ib,ic,id),c3=cross(ic,ia,id);
        const neg=c1<0||c2<0||c3<0,pos=c1>0||c2>0||c3>0;
        if(!(neg&&pos)){contains=true;break;}
      }
      if(contains)continue;
      tris.push(ring[a],ring[a+1],ring[b],ring[b+1],ring[c],ring[c+1]);
      ids.splice(k,1);clipped=true;break;
    }
    if(!clipped)throw new Error('Unable to triangulate polygon ring (self-intersection or degeneracy)');
  }
  if(ids.length===3){for(const id of ids){const p=id*2;tris.push(ring[p],ring[p+1]);}}
  return new Float32Array(tris);
}
