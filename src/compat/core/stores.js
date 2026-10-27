/** R68: grouped legacy compatibility utilities; algorithms preserved without changes. */

// Consolidated from src/compat/core/GeometryStore.js
export class GeometryStore {
  constructor(){ this.byId=new Map(); this.byKey=new Map(); this.nextId=1; }
  upsert(key, geometry){
    if(this.byKey.has(key)){
      const id=this.byKey.get(key), prev=this.byId.get(id);
      this.byId.set(id,{...prev,...geometry,id,key,version:(prev.version||0)+1});
      return {id,created:false};
    }
    const id=this.nextId++; this.byKey.set(key,id); this.byId.set(id,{...geometry,id,key,version:1}); return {id,created:true};
  }
  get(id){ return this.byId.get(id); }
  values(){ return this.byId.values(); }
  get size(){ return this.byId.size; }
}

// Consolidated from src/compat/core/StyleStore.js
function stable(v){ if(Array.isArray(v)) return '['+v.map(stable).join(',')+']'; if(v&&typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}'; return JSON.stringify(v); }
export class StyleStore {
  constructor(){ this.byId=new Map(); this.byKey=new Map(); this.nextId=1; }
  intern(style){ const key=stable(style); if(this.byKey.has(key)) return this.byKey.get(key); const id=this.nextId++; this.byKey.set(key,id); this.byId.set(id,Object.freeze({...style})); return id; }
  get(id){ return this.byId.get(id); }
  get size(){ return this.byId.size; }
}

// Consolidated from src/compat/core/DirtyTracker.js
export class DirtyTracker {
  constructor(){ this.ids=new Set(); }
  mark(id){ if(id!=null) this.ids.add(id); }
  has(id){ return this.ids.has(id); }
  clear(id){ if(id==null) this.ids.clear(); else this.ids.delete(id); }
  consume(){ const out=[...this.ids]; this.ids.clear(); return out; }
  peek(){ return [...this.ids]; }
  get size(){ return this.ids.size; }
}
