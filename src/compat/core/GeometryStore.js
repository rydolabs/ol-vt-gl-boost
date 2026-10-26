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
