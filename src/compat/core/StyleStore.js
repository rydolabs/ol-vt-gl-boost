function stable(v){ if(Array.isArray(v)) return '['+v.map(stable).join(',')+']'; if(v&&typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}'; return JSON.stringify(v); }
export class StyleStore {
  constructor(){ this.byId=new Map(); this.byKey=new Map(); this.nextId=1; }
  intern(style){ const key=stable(style); if(this.byKey.has(key)) return this.byKey.get(key); const id=this.nextId++; this.byKey.set(key,id); this.byId.set(id,Object.freeze({...style})); return id; }
  get(id){ return this.byId.get(id); }
  get size(){ return this.byId.size; }
}
