export class DirtyTracker {
  constructor(){ this.ids=new Set(); }
  mark(id){ if(id!=null) this.ids.add(id); }
  has(id){ return this.ids.has(id); }
  clear(id){ if(id==null) this.ids.clear(); else this.ids.delete(id); }
  consume(){ const out=[...this.ids]; this.ids.clear(); return out; }
  peek(){ return [...this.ids]; }
  get size(){ return this.ids.size; }
}
