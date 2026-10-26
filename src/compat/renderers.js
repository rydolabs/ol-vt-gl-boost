// Origin: src/renderer/renderers/SimpleRenderer.js
// Shared M4-derived WebGL1 simple vertex/fragment shader contract.
export const M4_SIMPLE_VERTEX_SHADER = 'precision mediump float; attribute vec2 a_pos; uniform float u_pointSize; uniform mat4 u_projectionMatrix; uniform float u_worldOffsetX; uniform vec2 u_pointDisplacement; uniform vec2 u_viewportSizeCss; void main(){gl_Position=u_projectionMatrix*vec4(a_pos+vec2(u_worldOffsetX,0.0),0.0,1.0); if(u_viewportSizeCss.x>0.0&&u_viewportSizeCss.y>0.0){gl_Position.xy+=vec2(2.0*u_pointDisplacement.x/u_viewportSizeCss.x,2.0*u_pointDisplacement.y/u_viewportSizeCss.y)*gl_Position.w;} gl_PointSize=u_pointSize;}';
export const M4_SIMPLE_FRAGMENT_SHADER = 'precision mediump float; uniform vec4 u_color; uniform bool u_isPoint; uniform float u_pointShape; uniform vec4 u_pointStrokeColor; uniform float u_pointStrokeWidth; uniform float u_pointSize; uniform bool u_premultiplyAlpha; uniform sampler2D u_spriteTexture; uniform float u_spriteOpacity; uniform vec2 u_spriteSize; uniform float u_spriteRotation; void main(){ vec4 color=u_color; if(u_isPoint){ vec2 q=gl_PointCoord-vec2(0.5); float cs=cos(u_spriteRotation),sn=sin(u_spriteRotation); vec2 r=vec2(cs*q.x-sn*q.y,sn*q.x+cs*q.y); if(u_pointShape>1.5){vec2 px=r*u_pointSize;vec2 uv=px/max(u_spriteSize,vec2(1.0))+vec2(0.5);if(any(lessThan(uv,vec2(0.0)))||any(greaterThan(uv,vec2(1.0))))discard;vec4 tex=texture2D(u_spriteTexture,uv);color=vec4(tex.rgb*tex.a,tex.a)*u_spriteOpacity;if(color.a<0.003)discard;gl_FragColor=color;return;} if(u_pointShape>0.5){ float d=length(r); if(d>0.5)discard; float border=u_pointStrokeWidth/max(u_pointSize,1.0); if(border>0.0 && d>0.5-border)color=u_pointStrokeColor; } } gl_FragColor=u_premultiplyAlpha?vec4(color.rgb*color.a,color.a):color; }';
export class SimpleRenderer {
  constructor(type){ this.type=type; this.resource=null; this.indexStreamName=`${type}.indices`; this.spriteKeys=new Set(); }
  _buildReferenceBuffers(backend,references,styleStore,resourceManager=this.resource?.resourceManager){
    const groups=new Map();
    for(const r of references){
      if(r.visible===false) continue;
      const meta=this.resource.geometryMeta.get(r.geometryId); if(!meta)continue;
      const range=resourceManager?.getPhysicalRange(r.geometryId); if(!range)continue;
      if(range.offset%8!==0) throw new Error(`unaligned vec2 geometry range: ${r.geometryId}`);
      const first=range.offset/8;
      const layerKey=String(r.sceneLayerKey??'__default');
      const styleZIndex=Number(r.sceneStyleZIndex??0);
      const worldOffsetX=Number(r.sceneWorldOffsetX??0);
      const groupKey=`${layerKey}|${styleZIndex}|${r.styleId}|${worldOffsetX}`;
      if(!groups.has(groupKey))groups.set(groupKey,{styleId:r.styleId,layerKey,styleZIndex,worldOffsetX,idx:[]});
      const a=groups.get(groupKey).idx;
      // Indexed polygons keep unique vertices in the geometry arena and map
      // Earcut/ear-clip indices into the existing global ELEMENT_ARRAY_BUFFER.
      // Non-indexed polygons and points preserve the original hot path.
      if(this.type==='polygon' && meta.indices){
        for(let k=0;k<meta.indices.length;k++)a.push(first+meta.indices[k]);
      }else for(let k=0;k<meta.count;k++)a.push(first+k);
    }
    const keep=new Set(), ebos=[]; let uploadedBytes=0;
    resourceManager.beginStreamUploadBatch(this.indexStreamName,{alignment:4,target:'ELEMENT_ARRAY_BUFFER'});
    try {
    for(const [groupKey,group] of groups){
      const {styleId,layerKey,styleZIndex,worldOffsetX,idx}=group;
      let max=0;for(let i=0;i<idx.length;i++)if(idx[i]>max)max=idx[i];
      const useUint32=max>65535;
      if(useUint32&&!backend.supportsUint32ElementIndices?.()) throw new Error(`SimpleRenderer global vertex index requires OES_element_index_uint: ${max}`);
      const arr=useUint32?new Uint32Array(idx):new Uint16Array(idx), id=String(groupKey); keep.add(id);
      const range=resourceManager.upsertStreamResource(this.indexStreamName,id,arr,{alignment:4,target:'ELEMENT_ARRAY_BUFFER'});
      uploadedBytes+=arr.byteLength; ebos.push({styleId,layerKey,styleZIndex,worldOffsetX,id,count:idx.length,bytes:arr.byteLength,offset:range.offset,indexType:useUint32?'UNSIGNED_INT':'UNSIGNED_SHORT'});
    }
    } finally { resourceManager.endStreamUploadBatch(this.indexStreamName); }
    resourceManager.retainStreamResources(this.indexStreamName,keep);
    this.resource.ebos=ebos; this.resource.styleStore=styleStore; this.resource.references=references;
    this.resource.layoutVersion=resourceManager?.layoutVersion ?? 0;
    this.resource.indexLayoutVersion=resourceManager?.getStreamLayoutVersion(this.indexStreamName) ?? 0;
    return {referenceRebuilds:1,referenceUploadBytes:uploadedBytes};
  }
  _syncLayout(backend){
    const rm=this.resource?.resourceManager;
    if(!rm) return;
    if(this.resource.layoutVersion!==rm.layoutVersion){
      this._buildReferenceBuffers(backend,this.resource.references,this.resource.styleStore,rm);
      return;
    }
    const v=rm.getStreamLayoutVersion(this.indexStreamName);
    if(this.resource.indexLayoutVersion!==v){
      for(const e of this.resource.ebos){const range=rm.getStreamRange(this.indexStreamName,e.id);if(range)e.offset=range.offset;}
      this.resource.indexLayoutVersion=v;
    }
  }
  _syncPointTextures(references,styleStore,resourceManager){if(this.type!=='point')return;const next=new Set();for(const r of references){const s=styleStore.get(r.styleId);if(s?.spriteKey&&s?.spriteDescriptor)next.add(s.spriteKey);}for(const key of this.spriteKeys)if(!next.has(key))resourceManager.releaseTexture(key);for(const key of next)if(!this.spriteKeys.has(key)){const style=references.map(r=>styleStore.get(r.styleId)).find(s=>s?.spriteKey===key);if(style)resourceManager.acquireTexture(key,style.spriteDescriptor);}this.spriteKeys=next;}
  prepare(backend, geometryEntries, references, styleStore, resourceManager){
    const geometryMeta=new Map();
    for(const g of geometryEntries){
      const count=(g.data?.length||0)/2;
      geometryMeta.set(g.id,{count,indices:this.type==='polygon' && g.indices instanceof Uint32Array ? g.indices : null});
    }
    this.resource={ebos:[],styleStore,geometryMeta,geometryEntries,references,resourceManager,layoutVersion:-1,indexLayoutVersion:-1};
    this._syncPointTextures(references,styleStore,resourceManager);
    this._buildReferenceBuffers(backend,references,styleStore,resourceManager);
    return this.resource;
  }
  updateReferences(backend,references,styleStore,resourceManager=this.resource?.resourceManager){ this._syncPointTextures(references,styleStore,resourceManager); return this._buildReferenceBuffers(backend,references,styleStore,resourceManager); }
  updateGeometry(backend,g){
    const meta=this.resource?.geometryMeta.get(g.id); if(!meta) return {rebuild:true,compiled:0,uploadedBytes:0};
    const count=g.data.length/2; if(count!==meta.count) return {rebuild:true,compiled:0,uploadedBytes:0};
    const indices=this.type==='polygon' && g.indices instanceof Uint32Array ? g.indices : null;
    const old=meta.indices;
    let indicesChanged=(old===null)!==(indices===null) || (old&&indices&&old.length!==indices.length);
    if(!indicesChanged&&old&&indices){for(let i=0;i<old.length;i++)if(old[i]!==indices[i]){indicesChanged=true;break;}}
    if(indicesChanged){meta.indices=indices;return {rebuild:false,compiled:1,referenceDirty:true,uploadedBytes:g.data.byteLength};}
    return {rebuild:false,compiled:1,uploadedBytes:(g.data instanceof Float32Array?g.data.byteLength:new Float32Array(g.data).byteLength)};
  }
  draw(backend,references,{frame=null}={}){
    this._syncLayout(backend);
    const gl=backend.gl, rm=this.resource.resourceManager;
    if(!rm?.gpuBuffer) return;
    const indexBuffer=rm.getStreamBuffer(this.indexStreamName); if(!indexBuffer)return;
    const vs=M4_SIMPLE_VERTEX_SHADER, fs=M4_SIMPLE_FRAGMENT_SHADER;
    const c=backend.program('simple-'+this.type,vs,fs); backend.useProgram(c.program); backend.disableAllAttribs?.(); backend.bindBuffer(gl.ARRAY_BUFFER,rm.gpuBuffer); backend.bindFloatAttrib(c,'a_pos',2,0,0,0); const pm=frame?.clipMatrix||new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]); backend.uniformMatrix4fv(backend.uniform(c,'u_projectionMatrix'),false,pm); backend.uniform1f(backend.uniform(c,'u_worldOffsetX'),0); backend.uniform2f(backend.uniform(c,'u_viewportSizeCss'),frame?.size?.[0]||backend.canvas.width/(frame?.pixelRatio||1),frame?.size?.[1]||backend.canvas.height/(frame?.pixelRatio||1)); backend.uniform2f(backend.uniform(c,'u_pointDisplacement'),0,0); backend.uniform1f(backend.uniform(c,'u_spriteOpacity'),1); backend.uniform2f(backend.uniform(c,'u_spriteSize'),1,1); backend.uniform1f(backend.uniform(c,'u_spriteRotation'),0); backend.uniform1i(backend.uniform(c,'u_isPoint'),this.type==='point'?1:0); backend.uniform1f(backend.uniform(c,'u_pointShape'),0); backend.uniform4fv(backend.uniform(c,'u_pointStrokeColor'),new Float32Array([0,0,0,0])); backend.uniform1f(backend.uniform(c,'u_pointStrokeWidth'),0); backend.uniform1i(backend.uniform(c,'u_premultiplyAlpha'),0); backend.uniform1f(backend.uniform(c,'u_pointSize'),this.type==='point'?6:1); const mode=this.type==='point'?gl.POINTS:gl.TRIANGLES;
    backend.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);
    const requestedGroups=new Set((references||[]).map(r=>`${String(r.sceneLayerKey??'__default')}|${Number(r.sceneStyleZIndex??0)}|${r.styleId}|${Number(r.sceneWorldOffsetX??0)}`));
    for(const e of this.resource.ebos){ if(requestedGroups.size&&!requestedGroups.has(`${e.layerKey}|${e.styleZIndex}|${e.styleId}|${Number(e.worldOffsetX??0)}`))continue; backend.uniform1f(backend.uniform(c,'u_worldOffsetX'),Number(e.worldOffsetX??0)); const s=this.resource.styleStore.get(e.styleId); backend.uniform4fv(backend.uniform(c,'u_color'),s.color); backend.uniform1i(backend.uniform(c,'u_premultiplyAlpha'),s.premultiplyAlpha?1:0); if(this.type==='point'){backend.uniform1f(backend.uniform(c,'u_pointSize'),(s.pointSize||6)*(frame?.pixelRatio||1));backend.uniform1f(backend.uniform(c,'u_pointShape'),s.pointShape||0);backend.uniform4fv(backend.uniform(c,'u_pointStrokeColor'),s.pointStrokeColor||new Float32Array([0,0,0,0]));backend.uniform1f(backend.uniform(c,'u_pointStrokeWidth'),(s.pointStrokeWidth||0)*(frame?.pixelRatio||1));const theta=(s.symbolRotation||0)+(s.spriteRotateWithView?(frame?.rotation||0):0);const ds=s.pointDisplacementScreen||null;let pd=s.pointDisplacement||[0,0];if(ds){const cc=Math.cos(theta),ssn=Math.sin(theta),dx=cc*ds[0]-ssn*ds[1],dy=ssn*ds[0]+cc*ds[1];pd=[dx,-dy];}backend.uniform2f(backend.uniform(c,'u_pointDisplacement'),pd[0],pd[1]);backend.uniform1f(backend.uniform(c,'u_spriteOpacity'),s.spriteOpacity??1);backend.uniform1f(backend.uniform(c,'u_spriteRotation'),-theta);const ss=s.spriteSize||[s.pointSize||6,s.pointSize||6];backend.uniform2f(backend.uniform(c,'u_spriteSize'),ss[0]*(frame?.pixelRatio||1),ss[1]*(frame?.pixelRatio||1));if(s.spriteKey){gl.activeTexture(gl.TEXTURE0);backend.bindTexture(gl.TEXTURE_2D,rm.getTexture(s.spriteKey));backend.uniform1i(backend.uniform(c,'u_spriteTexture'),0);}} backend.drawElements(mode,e.count,e.indexType==='UNSIGNED_INT'?gl.UNSIGNED_INT:gl.UNSIGNED_SHORT,e.offset); }
  }
}

// Origin: src/renderer/renderers/PointRenderer.js


// Origin: src/renderer/renderers/PolygonRenderer.js

