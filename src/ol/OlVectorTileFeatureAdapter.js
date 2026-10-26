import { materializeFlatPolygonRings } from '../tile/DirectFeaturePolygonBuffers.js';
import { olPolygonEndss, polygonPartsOlOrientation } from './PolygonRingGrouping.js';
import { toNeutralStyles } from './OlStyleAdapter.js';
import { packRenderFeatureLineInstances, packRenderFeatureGpuJoinNeighbors, packRenderFeatureGpuJoinNeighborsFused, referenceRenderFeatureFlatLine, preferFlatLineVertexWindow, referenceRenderFeatureGpuJoinDirect } from '../tile/RenderFeatureLinePacker.js';

function pairs(flat,start=0,end=flat.length,stride=2){
  const out=[];for(let i=start;i<end;i+=stride)out.push([Number(flat[i]),Number(flat[i+1])]);return out;
}
function pointInRing(p,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];const hit=((yi>p[1])!==(yj>p[1]))&&(p[0]<(xj-xi)*(p[1]-yi)/(yj-yi||1e-30)+xi);if(hit)inside=!inside;
}return inside;}
function polygonParts(flat,ends,stride=2){
  const rings=[];let start=0;for(const end of ends||[]){const ring=pairs(flat,start,end,stride);if(ring.length&&((ring[0][0]!==ring[ring.length-1][0])||(ring[0][1]!==ring[ring.length-1][1])))ring.push([...ring[0]]);rings.push(ring);start=end;}
  if(rings.length<=1)return rings.length?[rings]:[];
  // RenderFeature flattens Polygon/MultiPolygon to one ends array. Group rings by
  // containment instead of depending on OL internal inflateEnds().
  // Most vector-tile building rings are disjoint. A cached outer-ring
  // bounding box rejects the overwhelming majority of impossible containment
  // candidates before the more expensive point-in-polygon ray test. This is
  // a conservative filter: boundary coordinates still reach pointInRing(),
  // preserving its exact inside/boundary behavior and ring ordering.
  const parts=[], bounds=[];
  for(const ring of rings){
    const probe=ring[0];let owner=-1;
    for(let i=parts.length-1;i>=0;i--){
      const b=bounds[i];
      if(probe[0]<b.minX||probe[0]>b.maxX||probe[1]<b.minY||probe[1]>b.maxY)continue;
      if(pointInRing(probe,parts[i][0])){owner=i;break;}
    }
    if(owner>=0)parts[owner].push(ring);
    else{
      parts.push([ring]);
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for(const p of ring){if(p[0]<minX)minX=p[0];if(p[0]>maxX)maxX=p[0];if(p[1]<minY)minY=p[1];if(p[1]>maxY)maxY=p[1];}
      bounds.push({minX,minY,maxX,maxY});
    }
  }
  return parts;
}
function typeOf(f){return typeof f?.getType==='function'?f.getType():f?.type;}
function propsOf(f){return typeof f?.getProperties==='function'?{...f.getProperties()}:{...(f?.properties||{})};}
function flatOf(f){return typeof f?.getFlatCoordinates==='function'?f.getFlatCoordinates():f?.flatCoordinates;}
function endsOf(f){return typeof f?.getEnds==='function'?f.getEnds():f?.ends;}
function projectionCode(p){return typeof p?.getCode==='function'?p.getCode():String(p||'');}
function sameProjection(a,b){if(!a||!b)return true;return a===b||projectionCode(a)===projectionCode(b);}
function transformCoordinate(c,fn,sourceProjection,targetProjection){
  if(!fn||sameProjection(sourceProjection,targetProjection))return c;
  const out=fn([Number(c[0]),Number(c[1])],sourceProjection,targetProjection);
  if(!Array.isArray(out)||out.length<2||!Number.isFinite(Number(out[0]))||!Number.isFinite(Number(out[1])))throw new Error('VectorTile coordinateTransform must return a finite [x,y] coordinate');
  return [Number(out[0]),Number(out[1])];
}
function transformGeometry(g,fn,sourceProjection,targetProjection){
  if(!fn||sameProjection(sourceProjection,targetProjection))return g;
  if(g.kind==='point')return {...g,coordinates:transformCoordinate(g.coordinates,fn,sourceProjection,targetProjection)};
  if(g.kind==='line')return {...g,coordinates:g.coordinates.map(c=>transformCoordinate(c,fn,sourceProjection,targetProjection))};
  if(g.kind==='polygon')return {...g,rings:g.rings.map(r=>r.map(c=>transformCoordinate(c,fn,sourceProjection,targetProjection)))};
  return g;
}

/** Adapt OL MVT RenderFeature (default MVT output) without importing OL classes. */
export class OlVectorTileFeatureAdapter {
  constructor(){this.ids=new WeakMap();this.nextId=1;}
  keyOf(feature,{tileKey='tile'}={}){
    const id=typeof feature?.getId==='function'?feature.getId():feature?.id;
    if(id!=null)return `mvt:${tileKey}:${String(id)}`;
    if(!this.ids.has(feature))this.ids.set(feature,this.nextId++);
    return `mvt:${tileKey}@${this.ids.get(feature)}`;
  }
  sourceLayerOf(feature,{layerProperty='layer'}={}){const properties=propsOf(feature);return properties[layerProperty]??properties.layer??null;}
  adapt(feature,{tileKey='tile',styleLike=null,resolution=1,layerProperty='layer',sourceProjection=null,targetProjection=null,coordinateTransform=null,clipExtent=null,styleMode='parts',directLineBuffer=false,gpuJoinSolidLine=false,flatCoordinatesGpuLine=false,singleStyleLinePack=false,directFeatureGpuJoin=false,fusedGpuJoinPacking=false,polygonOlRingGrouping=false,disableWorkerFeatureBuffers=false}={}){
    const type=typeOf(feature),flat=flatOf(feature),ends=endsOf(feature)||[],stride=Number(feature?.getStride?.()||feature?.stride_||2);
    if(!type||!flat)throw new Error('Vector tile feature must expose getType/getFlatCoordinates');
    const geometries=[];
    // Direct flat-coordinate path for BOTH 'stack' and 'parts' style modes.
    // Keep separate geometries for each MultiLineString part under 'parts',
    // because the style array is indexed by part, unlike stack styling.
    // No JS [x,y] objects or g.paths are created for either case.
    const directCoordinatesAllowed=!coordinateTransform||sameProjection(sourceProjection,targetProjection);
    const lineType=type==='LineString'||type==='MultiLineString';
    const canDirect=directLineBuffer && lineType && directCoordinatesAllowed;
    let resolved=styleLike;if(typeof resolved==='function')resolved=resolved(feature,resolution,this.sourceLayerOf(feature,{layerProperty}));
    const neutralStyles=toNeutralStyles(resolved,{feature,resolution});
    const isSolidStroke=(style)=>!style?.stroke || (
      !(style.stroke.dash?.length) && !style.stroke.patternSrc &&
      !style.stroke.offset && !style.stroke.dashOffset
    );
    // Opt-in: in 'parts' mode, one style means every independent line
    // has the same style. Keep the public styleMode unchanged, but package
    // all sub-lines as one shared geometry and retain the original 'ends'.
    // Do not merge when styles can vary by part or projection must change.
    const singleStylePackedLine=singleStyleLinePack && canDirect &&
      styleMode==='parts' && type==='MultiLineString' && neutralStyles.length===1;
    // Lightweight path boundaries only. No per-path Geometry or RenderReference.
    // The original parts path has one orderSeed increment per 'end'.
    const packedPartVertexCounts=singleStylePackedLine
      ? ends.map((stop,i)=> (stop-(i?ends[i-1]:0))/stride) : null;
    if(canDirect){
      const ranges=(styleMode==='stack'||singleStylePackedLine)?[{start:0,end:flat.length}]:
        (type==='MultiLineString'?ends:[flat.length]).map((end,i,arr)=>({start:i?arr[i-1]:0,end}));
      for(let i=0;i<ranges.length;i++){
        const {start,end}=ranges[i];
        const useGpuJoin=gpuJoinSolidLine && (styleMode==='stack'
          ? neutralStyles.every(isSolidStroke)
          : isSolidStroke(neutralStyles[Math.min(i,neutralStyles.length-1)]));
        const partEnds=(styleMode==='stack'||singleStylePackedLine)&&type==='MultiLineString'?ends:null;
        const flatCandidate=useGpuJoin&&flatCoordinatesGpuLine?referenceRenderFeatureFlatLine(flat,partEnds,stride,start,end):null;
        const flatPack=flatCoordinatesGpuLine==='auto' && !preferFlatLineVertexWindow(flatCandidate)?null:flatCandidate;
        const directPack=directFeatureGpuJoin&&singleStylePackedLine&&useGpuJoin&&!flatPack
          ?referenceRenderFeatureGpuJoinDirect(flat,partEnds,stride,start,end):null;
        const gpuPack=!directPack&&!flatPack&&useGpuJoin?(fusedGpuJoinPacking?packRenderFeatureGpuJoinNeighborsFused:packRenderFeatureGpuJoinNeighbors)(flat,partEnds,stride,start,end):null;
        const packed=directPack??flatPack??gpuPack??packRenderFeatureLineInstances(flat,partEnds,stride,start,end);
        geometries.push({kind:'line',...packed,sourceType:type,directLineBuffer:true,
          ...(styleMode==='parts'?{partIndex:i}:{})});
      }
    }
    else if(type==='Point')geometries.push(disableWorkerFeatureBuffers && directCoordinatesAllowed?{kind:'point',directFeaturePoint:true,flatCoordinates:flat,flatStart:0,sourceType:type}:{kind:'point',coordinates:pairs(flat,0,2,stride)[0],sourceType:type});
    else if(type==='MultiPoint'){if(disableWorkerFeatureBuffers && directCoordinatesAllowed){for(let i=0;i<flat.length;i+=stride)geometries.push({kind:'point',directFeaturePoint:true,flatCoordinates:flat,flatStart:i,sourceType:type,partIndex:i/stride});}else pairs(flat,0,flat.length,stride).forEach((c,i)=>geometries.push({kind:'point',coordinates:c,sourceType:type,partIndex:i}));}
    else if(type==='LineString')geometries.push({kind:'line',coordinates:pairs(flat,0,flat.length,stride),sourceType:type});
    else if(type==='MultiLineString'){let s=0;for(let i=0;i<ends.length;i++){geometries.push({kind:'line',coordinates:pairs(flat,s,ends[i],stride),sourceType:type,partIndex:i});s=ends[i];}}
    else if(type==='Polygon'||type==='MultiPolygon'){
      if(disableWorkerFeatureBuffers && polygonOlRingGrouping && directCoordinatesAllowed){
        // OL orientation grouping without constructing point-pair objects.
        const starts=new Map();let previous=0;
        for(const end of ends){starts.set(end,previous);previous=end;}
        const endss=olPolygonEndss(flat,ends,stride);
        for(let i=0;i<endss.length;i++){
          const ranges=endss[i].map(end=>[starts.get(end)??0,end]);
          let cachedRings;
          const g={kind:'polygon',flatPolygonBuffers:true,flatCoordinates:flat,flatRanges:ranges,flatStride:stride,
            sourceType:type,partIndex:i,
            get rings(){return cachedRings??(cachedRings=materializeFlatPolygonRings(flat,ranges,stride));}};
          geometries.push(g);
        }
      }else (polygonOlRingGrouping?polygonPartsOlOrientation(flat,ends,stride):polygonParts(flat,ends,stride))
        .forEach((rings,i)=>geometries.push({kind:'polygon',rings,sourceType:type,partIndex:i}));
    }else throw new Error(`Unsupported MVT RenderFeature type: ${type}`);
    const properties=propsOf(feature);const sourceLayer=properties[layerProperty]??properties.layer??null;
    return {key:this.keyOf(feature,{tileKey}),properties,sourceLayer,singleStylePackedLine,packedPartVertexCounts,geometries:geometries.map(g=>{const transformed=transformGeometry(g,coordinateTransform,sourceProjection,targetProjection);if(g.kind==='polygon'&&clipExtent){if(transformed===g && g.flatPolygonBuffers){g.clipExtent=clipExtent;return g;}return {...transformed,clipExtent};}return transformed;}),styles:neutralStyles,styleMode,source:feature,tileKey,sourceProjection,targetProjection};
  }
}
