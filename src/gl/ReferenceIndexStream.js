export class ReferenceIndexStream {
  constructor(indices, Type=Uint16Array){ this.indices = indices instanceof Type ? indices : new Type(indices); }
  get byteLength(){ return this.indices.byteLength; }
  upload(gl, usage=gl.STATIC_DRAW){ const b=gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,this.indices,usage); this.buffer=b; return b; }
}
