export class WebGL1Backend {
  constructor(canvas,{gpuCompletionMode='submit',cacheBindings=true,profileTiming=false,contextAntialias=null}={}){
    if(!['submit','blocking'].includes(gpuCompletionMode)) throw new Error(`Unsupported GPU completion mode: ${gpuCompletionMode}`);
    this.gpuCompletionMode=gpuCompletionMode;this.cacheBindings=cacheBindings!==false;this.profileTiming=profileTiming===true;
    this.canvas=canvas; this.contextAntialias=contextAntialias; this.gl=canvas.getContext('webgl',contextAntialias===null?undefined:{antialias:contextAntialias}); if(!this.gl) throw new Error('WebGL1 unavailable');
    this.ext=this.gl.getExtension('ANGLE_instanced_arrays'); if(!this.ext) throw new Error('ANGLE_instanced_arrays unavailable'); this.elementIndexUintExt=this.gl.getExtension('OES_element_index_uint');
    this.programs=new Map(); this.patternTextures=new Map(); this.divisors=new Map(); this.enabledAttribs=new Set(); this._activeProgram=null;this._boundBuffers=new Map();this.resetStats();
  }

  restoreContext(){ this.gl=this.canvas.getContext('webgl',this.contextAntialias===null?undefined:{antialias:this.contextAntialias}); if(!this.gl) throw new Error('WebGL1 unavailable after restore'); this.ext=this.gl.getExtension('ANGLE_instanced_arrays'); if(!this.ext) throw new Error('ANGLE_instanced_arrays unavailable after restore'); this.elementIndexUintExt=this.gl.getExtension('OES_element_index_uint'); this.programs.clear(); this.patternTextures.clear(); this.divisors.clear(); this.enabledAttribs.clear();this._activeProgram=null;this._boundBuffers.clear();this.resetStats(); return this; }
  supportsUint32ElementIndices(){ return !!this.elementIndexUintExt; }
  resetStats(){ this.stats={drawCalls:0,bindBuffer:0,bindTexture:0,texImage2D:0,uniformCalls:0,useProgram:0,attribPointer:0,divisorCalls:0,bufferData:0,bufferDataBytes:0,bufferSubData:0,bufferSubDataBytes:0}; }
  beginFrame(){ this.resetStats(); this.invalidateStateCache(); const gl=this.gl; gl.viewport(0,0,this.canvas.width,this.canvas.height); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA); }
  endFrame(){
    // WebGL commands are ordered by the GPU and the browser/compositor handles
    // presentation synchronization. gl.finish() blocks the main thread until
    // *all* submitted GPU work completes; avoid that stall in normal rendering.
    // GL readPixels() remains synchronizing for correctness diagnostics.
    const timeStart=this.profileTiming?performance.now():0;
    if(this.gpuCompletionMode==='blocking') this.gl.finish();
    else this.gl.flush();
    const waited=this.profileTiming?performance.now()-timeStart:null;
    return {...this.stats,glError:this.gl.getError(),...(this.profileTiming?{gpuFinishWaitMs:waited}:{})};
  }
  compileShader(type,source){ const gl=this.gl,s=gl.createShader(type); gl.shaderSource(s,source); gl.compileShader(s); if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  program(key,vs,fs){ if(this.programs.has(key)) return this.programs.get(key); const gl=this.gl,p=gl.createProgram(); gl.attachShader(p,this.compileShader(gl.VERTEX_SHADER,vs)); gl.attachShader(p,this.compileShader(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(p); if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); const x={program:p,attrib:new Map(),uniform:new Map()}; this.programs.set(key,x); return x; }
  // Only cache state owned by this backend. A new frame invalidates it because
  // external GL users may have changed bindings between M5 draw passes.
  invalidateStateCache(){this._activeProgram=null;this._boundBuffers.clear();}
  useProgram(p){if(this.cacheBindings&&this._activeProgram===p)return;this.gl.useProgram(p);this._activeProgram=p;this.stats.useProgram++;}
  attrib(cache,name){ if(!cache.attrib.has(name)) cache.attrib.set(name,this.gl.getAttribLocation(cache.program,name)); return cache.attrib.get(name); }
  uniform(cache,name){ if(!cache.uniform.has(name)) cache.uniform.set(name,this.gl.getUniformLocation(cache.program,name)); return cache.uniform.get(name); }
  bindBuffer(target,b){if(this.cacheBindings&&this._boundBuffers.get(target)===b)return;this.gl.bindBuffer(target,b);this._boundBuffers.set(target,b);this.stats.bindBuffer++;}
  bindTexture(target,t){ this.gl.bindTexture(target,t); this.stats.bindTexture++; }
  resolveEnum(value,fallback){ if(typeof value==='number')return value; if(typeof value==='string'&&this.gl[value]!=null)return this.gl[value]; return fallback; }
  createBufferResource(targetName='ARRAY_BUFFER',capacity=0,usageName='DYNAMIC_DRAW'){ const gl=this.gl,target=this.resolveEnum(targetName,gl.ARRAY_BUFFER),usage=this.resolveEnum(usageName,gl.DYNAMIC_DRAW),buffer=gl.createBuffer(); this.bindBuffer(target,buffer); this.bufferData(target,capacity,usage); return buffer; }
  uploadBufferResource(targetName,buffer,offset,data){ const gl=this.gl,target=this.resolveEnum(targetName,gl.ARRAY_BUFFER); this.bindBuffer(target,buffer); this.bufferSubData(target,offset,data); }
  deleteBufferResource(buffer){ if(!buffer)return;for(const [target,bound] of this._boundBuffers)if(bound===buffer)this._boundBuffers.delete(target);this.gl.deleteBuffer(buffer); }
  createTextureResource(source,{minFilter,magFilter,wrapS,wrapT}={}){ const gl=this.gl,tex=gl.createTexture(); this.bindTexture(gl.TEXTURE_2D,tex); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source); this.stats.texImage2D++; gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,this.resolveEnum(minFilter,gl.LINEAR)); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,this.resolveEnum(magFilter,gl.LINEAR)); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,this.resolveEnum(wrapS,gl.CLAMP_TO_EDGE)); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,this.resolveEnum(wrapT,gl.CLAMP_TO_EDGE)); return tex; }
  deleteTextureResource(texture){ if(texture)this.gl.deleteTexture(texture); }
  bufferData(target,data,usage){ this.gl.bufferData(target,data,usage); this.stats.bufferData++; this.stats.bufferDataBytes+=typeof data==='number'?data:(data?.byteLength||0); }
  bufferSubData(target,offset,data){ this.gl.bufferSubData(target,offset,data); this.stats.bufferSubData++; this.stats.bufferSubDataBytes+=data?.byteLength||0; }
  setDivisor(loc,v){ if(loc<0)return; if(this.divisors.get(loc)===v)return; this.ext.vertexAttribDivisorANGLE(loc,v); this.divisors.set(loc,v); this.stats.divisorCalls++; }
  bindFloatAttrib(cache,name,size,stride,offset,divisor=0){ const gl=this.gl,loc=this.attrib(cache,name); if(loc<0)return; gl.enableVertexAttribArray(loc); this.enabledAttribs.add(loc); gl.vertexAttribPointer(loc,size,gl.FLOAT,false,stride,offset); this.stats.attribPointer++; this.setDivisor(loc,divisor); }
  disableAllAttribs(){ const gl=this.gl; for(const loc of this.enabledAttribs){ gl.disableVertexAttribArray(loc); this.setDivisor(loc,0); } this.enabledAttribs.clear(); }
  resetAttribDivisor(loc){ this.setDivisor(loc,0); }
  resetProgramAttribDivisors(cache,names){ for(const n of names){ const l=this.attrib(cache,n); if(l>=0)this.setDivisor(l,0); } }
  uniform1f(loc,v){this.gl.uniform1f(loc,v);this.stats.uniformCalls++} uniform1i(loc,v){this.gl.uniform1i(loc,v);this.stats.uniformCalls++}
  uniform1fv(loc,v){this.gl.uniform1fv(loc,v);this.stats.uniformCalls++} uniform2f(loc,a,b){this.gl.uniform2f(loc,a,b);this.stats.uniformCalls++}
  uniform4fv(loc,v){this.gl.uniform4fv(loc,v);this.stats.uniformCalls++} uniform4f(loc,a,b,c,d){this.gl.uniform4f(loc,a,b,c,d);this.stats.uniformCalls++}
  uniformMatrix4fv(loc,t,v){this.gl.uniformMatrix4fv(loc,t,v);this.stats.uniformCalls++}
  drawArrays(mode,first,count){this.gl.drawArrays(mode,first,count);this.stats.drawCalls++}
  drawElements(mode,count,type,offset){this.gl.drawElements(mode,count,type,offset);this.stats.drawCalls++}
  drawElementsInstanced(mode,count,type,offset,instances){this.ext.drawElementsInstancedANGLE(mode,count,type,offset,instances);this.stats.drawCalls++}
}
