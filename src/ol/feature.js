/** R67: cohesive implementation, originally separate R64 files. */

// Origin: src/ol/OlGeometryAdapter.js
function cloneCoord(coord) {
  return Array.isArray(coord) ? coord.map(Number) : coord;
}
function cloneCoords(coords) {
  return Array.isArray(coords) ? coords.map(cloneCoords) : Number(coords);
}
function geometryType(geometry) {
  if (!geometry) return null;
  if (typeof geometry.getType === 'function') return geometry.getType();
  return geometry.type || null;
}
function coordinatesOf(geometry) {
  if (typeof geometry.getCoordinates === 'function') return geometry.getCoordinates();
  return geometry.coordinates;
}
function circleRing(geometry, segments) {
  const center = typeof geometry.getCenter === 'function' ? geometry.getCenter() : geometry.center;
  const radius = typeof geometry.getRadius === 'function' ? geometry.getRadius() : geometry.radius;
  if (!center || !Number.isFinite(radius)) throw new Error('Circle geometry requires center/radius');
  const ring=[];
  for(let i=0;i<=segments;i++){
    const a=(i/segments)*Math.PI*2;
    ring.push([center[0]+Math.cos(a)*radius, center[1]+Math.sin(a)*radius]);
  }
  return ring;
}

/**
 * Convert an OpenLayers geometry (or OL-compatible public geometry object) into
 * renderer-neutral geometry descriptors. No OpenLayers classes are imported.
 */
export function toNeutralGeometries(geometry, {circleSegments=64}={}) {
  if (!geometry) return [];
  const type=geometryType(geometry);
  const coords=coordinatesOf(geometry);
  switch(type){
    case 'Point': return [{kind:'point', coordinates:cloneCoord(coords), sourceType:type}];
    case 'MultiPoint': return coords.map((c,index)=>({kind:'point',coordinates:cloneCoord(c),sourceType:type,partIndex:index}));
    case 'LineString': return [{kind:'line',coordinates:cloneCoords(coords),sourceType:type}];
    case 'MultiLineString': return coords.map((c,index)=>({kind:'line',coordinates:cloneCoords(c),sourceType:type,partIndex:index}));
    case 'Polygon': return [{kind:'polygon',rings:cloneCoords(coords),sourceType:type}];
    case 'MultiPolygon': return coords.map((rings,index)=>({kind:'polygon',rings:cloneCoords(rings),sourceType:type,partIndex:index}));
    case 'Circle': return [{kind:'polygon',rings:[circleRing(geometry,circleSegments)],sourceType:type,circle:true}];
    case 'GeometryCollection': {
      const geoms=typeof geometry.getGeometries === 'function' ? geometry.getGeometries() : (geometry.geometries||[]);
      const out=[];
      geoms.forEach((g,collectionIndex)=>{
        for(const n of toNeutralGeometries(g,{circleSegments})) out.push({...n,collectionIndex});
      });
      return out;
    }
    default: throw new Error(`Unsupported OpenLayers geometry type: ${type}`);
  }
}

export function neutralGeometryType(geometry) {
  const type=geometryType(geometry);
  if(type==='Point'||type==='MultiPoint') return 'point';
  if(type==='LineString'||type==='MultiLineString') return 'line';
  if(type==='Polygon'||type==='MultiPolygon'||type==='Circle') return 'polygon';
  if(type==='GeometryCollection'){
    const geoms=typeof geometry.getGeometries === 'function' ? geometry.getGeometries() : (geometry.geometries||[]);
    return geoms.length ? neutralGeometryType(geoms[0]) : null;
  }
  return null;
}

// Origin: src/ol/OlFeatureAdapter.js
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
