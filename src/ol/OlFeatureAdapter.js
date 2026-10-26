import { toNeutralGeometries } from './OlGeometryAdapter.js';
import { toNeutralStyles } from './OlStyleAdapter.js';

export class OlFeatureAdapter {
  constructor(){this.ids=new WeakMap();this.nextId=1;}
  keyOf(feature){
    const id=typeof feature?.getId==='function'?feature.getId():feature?.id;
    if(id!=null) return `ol:${String(id)}`;
    if((typeof feature==='object'&&feature!==null)||typeof feature==='function'){
      if(!this.ids.has(feature))this.ids.set(feature,this.nextId++);
      return `ol@${this.ids.get(feature)}`;
    }
    throw new Error('feature must be an object');
  }
  adapt(feature,{styleLike=null,resolution=1,circleSegments=64}={}){
    const geometry=typeof feature.getGeometry==='function'?feature.getGeometry():feature.geometry;
    const props=typeof feature.getProperties==='function'?{...feature.getProperties()}:{...(feature.properties||{})};
    delete props.geometry;
    const ownStyle=typeof feature.getStyle==='function'?feature.getStyle():feature.style;
    return {key:this.keyOf(feature),properties:props,geometries:toNeutralGeometries(geometry,{circleSegments}),styles:toNeutralStyles(ownStyle??styleLike,{feature,resolution}),source:feature};
  }
}
