/**
 * Renderer-neutral MapTiler/MapLibre GL style adapter.
 * No OpenLayers or renderer imports: it only evaluates style JSON against a
 * feature-like object and returns the flat-style subset understood by the OL
 * style boundary.
 */
function propsOf(feature){
  if(typeof feature?.getProperties==='function') return feature.getProperties()||{};
  return feature?.properties||feature||{};
}
function getProp(feature,key){
  if(typeof feature?.get==='function') return feature.get(key);
  return propsOf(feature)?.[key];
}
function geometryType(feature){
  const t=typeof feature?.getType==='function'?feature.getType():feature?.type;
  if(t==='Point'||t==='MultiPoint')return 'Point';
  if(t==='LineString'||t==='MultiLineString')return 'LineString';
  if(t==='Polygon'||t==='MultiPolygon')return 'Polygon';
  return t||null;
}
function truthy(v){return Boolean(v);}
function num(v,fallback=0){const n=Number(v);return Number.isFinite(n)?n:fallback;}
function interpolate(a,b,t){
  if(Array.isArray(a)&&Array.isArray(b))return a.map((v,i)=>num(v)+(num(b[i],num(v))-num(v))*t);
  if(typeof a==='number'||typeof b==='number')return num(a)+(num(b)-num(a))*t;
  return t<.5?a:b;
}
function evalInterpolate(expr,ctx){
  const input=evaluate(expr[2],ctx),stops=expr.slice(3);if(stops.length<4)return stops[1];
  const x=num(input),base=Array.isArray(expr[1])&&expr[1][0]==='exponential'?num(expr[1][1],1):1;
  for(let i=0;i<stops.length-2;i+=2){const s0=num(stops[i]),v0=evaluate(stops[i+1],ctx),s1=num(stops[i+2]),v1=evaluate(stops[i+3],ctx);if(x<=s0)return v0;if(x<=s1){let t=(x-s0)/(s1-s0||1);if(base!==1)t=(Math.pow(base,t)-1)/(base-1);return interpolate(v0,v1,t);}}
  return evaluate(stops[stops.length-1],ctx);
}
export function evaluate(expr,ctx={}){
  if(!Array.isArray(expr))return expr;
  if(!expr.length)return expr;
  const op=expr[0];
  if(typeof op!=='string')return expr;
  switch(op){
    case 'literal': return expr[1];
    case 'zoom': return num(ctx.zoom);
    case 'pitch': return num(ctx.pitch);
    case 'boolean': {for(const x of expr.slice(1)){const v=evaluate(x,ctx);if(typeof v==='boolean')return v;}return false;}
    case 'to-color': return colorToRgba(evaluate(expr[1],ctx));
    case 'get': {const obj=expr.length>2?evaluate(expr[2],ctx):propsOf(ctx.feature);return obj?.[expr[1]];}
    case 'has': {const obj=expr.length>2?evaluate(expr[2],ctx):propsOf(ctx.feature);return Object.prototype.hasOwnProperty.call(obj||{},expr[1]);}
    case 'geometry-type': return geometryType(ctx.feature);
    case 'id': return typeof ctx.feature?.getId==='function'?ctx.feature.getId():ctx.feature?.id;
    case '!': return !truthy(evaluate(expr[1],ctx));
    case 'all': return expr.slice(1).every(x=>truthy(evaluate(x,ctx)));
    case 'any': return expr.slice(1).some(x=>truthy(evaluate(x,ctx)));
    case '==': return evaluate(expr[1],ctx)===evaluate(expr[2],ctx);
    case '!=': return evaluate(expr[1],ctx)!==evaluate(expr[2],ctx);
    case '>': return evaluate(expr[1],ctx)>evaluate(expr[2],ctx);
    case '>=': return evaluate(expr[1],ctx)>=evaluate(expr[2],ctx);
    case '<': return evaluate(expr[1],ctx)<evaluate(expr[2],ctx);
    case '<=': return evaluate(expr[1],ctx)<=evaluate(expr[2],ctx);
    case 'in': {const v=evaluate(expr[1],ctx),hay=evaluate(expr[2],ctx);return Array.isArray(hay)?hay.includes(v):expr.slice(2).map(x=>evaluate(x,ctx)).includes(v);}
    case '!in': {const v=evaluate(expr[1],ctx),hay=evaluate(expr[2],ctx);return Array.isArray(hay)?!hay.includes(v):!expr.slice(2).map(x=>evaluate(x,ctx)).includes(v);}
    case 'coalesce': {for(const x of expr.slice(1)){const v=evaluate(x,ctx);if(v!=null)return v;}return null;}
    case 'case': {for(let i=1;i<expr.length-1;i+=2)if(truthy(evaluate(expr[i],ctx)))return evaluate(expr[i+1],ctx);return evaluate(expr[expr.length-1],ctx);}
    case 'match': {const input=evaluate(expr[1],ctx);for(let i=2;i<expr.length-1;i+=2){const label=evaluate(expr[i],ctx);if(Array.isArray(label)?label.includes(input):label===input)return evaluate(expr[i+1],ctx);}return evaluate(expr[expr.length-1],ctx);}
    case 'step': {const input=num(evaluate(expr[1],ctx));let out=evaluate(expr[2],ctx);for(let i=3;i<expr.length;i+=2){if(input<num(evaluate(expr[i],ctx)))break;out=evaluate(expr[i+1],ctx);}return out;}
    case 'interpolate': return evalInterpolate(expr,ctx);
    case 'to-number': return num(evaluate(expr[1],ctx),expr.length>2?num(evaluate(expr[2],ctx)):0);
    case 'to-string': {const v=evaluate(expr[1],ctx);return v==null?'':String(v);}
    case 'concat': return expr.slice(1).map(x=>String(evaluate(x,ctx)??'')).join('');
    case '+': return expr.slice(1).reduce((a,x)=>a+num(evaluate(x,ctx)),0);
    case '-': return expr.length===2?-num(evaluate(expr[1],ctx)):num(evaluate(expr[1],ctx))-num(evaluate(expr[2],ctx));
    case '*': return expr.slice(1).reduce((a,x)=>a*num(evaluate(x,ctx)),1);
    case '/': return num(evaluate(expr[1],ctx))/(num(evaluate(expr[2],ctx),1)||1);
    default: return expr;
  }
}

function hue2rgb(p,q,t){if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;}
function hslToRgba(h,s,l,a=1){
  h=((num(h)%360)+360)%360/360;s=Math.max(0,Math.min(1,num(s)));l=Math.max(0,Math.min(1,num(l)));
  if(s===0)return [l,l,l,num(a,1)];
  const q=l<.5?l*(1+s):l+s-l*s,p=2*l-q;return [hue2rgb(p,q,h+1/3),hue2rgb(p,q,h),hue2rgb(p,q,h-1/3),num(a,1)];
}
function colorToRgba(c){
  if(Array.isArray(c))return [num(c[0]),num(c[1]),num(c[2]),c.length>3?num(c[3],1):1];
  if(typeof c!=='string')return c;
  const s=c.trim();let m=s.match(/^#([0-9a-f]{3,8})$/i);
  if(m){let h=m[1];if(h.length===3||h.length===4)h=h.split('').map(x=>x+x).join('');if(h.length===6||h.length===8)return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).concat(h.length===8?parseInt(h.slice(6,8),16)/255:1);}
  m=s.match(/^rgba?\(([^)]+)\)$/i);if(m){const p=m[1].split(',').map(x=>x.trim());const cv=x=>x.endsWith('%')?parseFloat(x)/100:parseFloat(x)/255;return [cv(p[0]),cv(p[1]),cv(p[2]),p[3]==null?1:parseFloat(p[3])];}
  m=s.match(/^hsla?\(([^)]+)\)$/i);if(m){const p=m[1].split(',').map(x=>x.trim());const pct=x=>x.endsWith('%')?parseFloat(x)/100:parseFloat(x);return hslToRgba(parseFloat(p[0]),pct(p[1]),pct(p[2]),p[3]==null?1:parseFloat(p[3]));}
  return c;
}
function opacityColor(color,opacity){const rgba=colorToRgba(color);if(!Array.isArray(rgba))return rgba;const out=[...rgba];out[3]=(out[3]??1)*num(opacity,1);return out;}
function evalLegacyFunction(v,ctx){
  if(!v||Array.isArray(v)||typeof v!=='object'||!Array.isArray(v.stops))return v;
  const input=v.property?num(getProp(ctx.feature,v.property)):num(ctx.zoom);
  const stops=v.stops;if(!stops.length)return null;if(input<=num(stops[0][0]))return evaluate(stops[0][1],ctx);
  const base=num(v.base,1);for(let i=0;i<stops.length-1;i++){const [s0,r0]=stops[i],[s1,r1]=stops[i+1];if(input<=num(s1)){let t=(input-num(s0))/(num(s1)-num(s0)||1);if(base!==1)t=(Math.pow(base,t)-1)/(base-1);return interpolate(evaluate(r0,ctx),evaluate(r1,ctx),t);}}return evaluate(stops[stops.length-1][1],ctx);
}
function val(obj,key,ctx,fallback){const v=obj?.[key];if(v===undefined)return fallback;const legacy=evalLegacyFunction(v,ctx);return evaluate(legacy,ctx);}
function visible(layer){return layer?.layout?.visibility!=='none';}
function zoomOf(tile,resolution,zoomProvider){if(zoomProvider)return num(zoomProvider(tile,resolution));const c=tile?.getTileCoord?.()||tile?.tileCoord;return c?num(c[0]):0;}

function flatStyle(layer,ctx,index){
  const p=layer.paint||{},l=layer.layout||{};const sortKey=num(val(l,'line-sort-key',ctx,0),0);const z=index*1000000+sortKey;
  if(layer.type==='fill'){
    const color=opacityColor(val(p,'fill-color',ctx,'#000000'),val(p,'fill-opacity',ctx,1));
    const out={'z-index':z,'fill-color':color};
    const outline=val(p,'fill-outline-color',ctx,null);if(outline!=null){out['stroke-color']=opacityColor(outline,val(p,'fill-opacity',ctx,1));out['stroke-width']=1;}
    return out;
  }
  if(layer.type==='line'){
    return {'z-index':z,'stroke-color':opacityColor(val(p,'line-color',ctx,'#000000'),val(p,'line-opacity',ctx,1)),'stroke-width':num(val(p,'line-width',ctx,1),1)+2*num(val(p,'line-gap-width',ctx,0),0),'stroke-offset':num(val(p,'line-offset',ctx,0),0),'stroke-line-cap':val(l,'line-cap',ctx,'butt'),'stroke-line-join':val(l,'line-join',ctx,'miter'),'stroke-miter-limit':num(val(l,'line-miter-limit',ctx,10),10),'stroke-line-dash':val(p,'line-dasharray',ctx,null)};
  }
  if(layer.type==='circle'){
    return {'z-index':z,'circle-radius':num(val(p,'circle-radius',ctx,5),5),'circle-fill-color':opacityColor(val(p,'circle-color',ctx,'#000000'),val(p,'circle-opacity',ctx,1)),'circle-stroke-color':opacityColor(val(p,'circle-stroke-color',ctx,'transparent'),val(p,'circle-stroke-opacity',ctx,1)),'circle-stroke-width':num(val(p,'circle-stroke-width',ctx,0),0)};
  }
  return null;
}

function legacyValue(feature,key){if(key==='$type')return geometryType(feature);if(key==='$id')return typeof feature?.getId==='function'?feature.getId():feature?.id;return getProp(feature,key);}
export function evaluateFilter(filter,ctx={}){
  if(!Array.isArray(filter)||!filter.length)return truthy(evaluate(filter,ctx));
  const op=filter[0];
  if(op==='all')return filter.slice(1).every(x=>evaluateFilter(x,ctx));
  if(op==='any')return filter.slice(1).some(x=>evaluateFilter(x,ctx));
  if(op==='none')return !filter.slice(1).some(x=>evaluateFilter(x,ctx));
  const legacyKey=typeof filter[1]==='string'&&!['literal','zoom','geometry-type'].includes(filter[1]);
  if(!legacyKey)return truthy(evaluate(filter,ctx));
  const left=legacyValue(ctx.feature,filter[1]);
  switch(op){
    case 'has': return left!==undefined;
    case '!has': return left===undefined;
    case '==': return left===filter[2];
    case '!=': return left!==filter[2];
    case '>': return left>filter[2]; case '>=': return left>=filter[2]; case '<': return left<filter[2]; case '<=': return left<=filter[2];
    case 'in': return filter.slice(2).includes(left);
    case '!in': return !filter.slice(2).includes(left);
    default: return truthy(evaluate(filter,ctx));
  }
}
function collectOps(value,out){if(!Array.isArray(value)||!value.length)return;const op=value[0];if(typeof op==='string')out.add(op);for(const x of value.slice(1))collectOps(x,out);}
export function analyzeStyleCapabilities(style,{supportedTypes=['fill','line','circle']}={}){
  const types=new Map(),paintKeys=new Map(),layoutKeys=new Map(),ops=new Set(),sourceLayers=new Set();
  for(const layer of style?.layers||[]){
    types.set(layer.type,(types.get(layer.type)||0)+1);if(layer['source-layer'])sourceLayers.add(layer['source-layer']);collectOps(layer.filter,ops);
    for(const [k,v] of Object.entries(layer.paint||{})){paintKeys.set(k,(paintKeys.get(k)||0)+1);collectOps(v,ops);}
    for(const [k,v] of Object.entries(layer.layout||{})){layoutKeys.set(k,(layoutKeys.get(k)||0)+1);collectOps(v,ops);}
  }
  const supported=new Set(supportedTypes);return {layerCount:(style?.layers||[]).length,types:Object.fromEntries([...types].sort()),supportedLayerCount:[...(style?.layers||[])].filter(x=>supported.has(x.type)).length,unsupportedTypes:[...types.keys()].filter(x=>!supported.has(x)).sort(),sourceLayers:[...sourceLayers].sort(),expressionOperators:[...ops].sort(),paintKeys:Object.fromEntries([...paintKeys].sort()),layoutKeys:Object.fromEntries([...layoutKeys].sort())};
}

export class MapTilerStyleAdapter {
  constructor({style,source=null,zoomProvider=null,supportedTypes=['fill','line','circle']}={}){
    if(!style||!Array.isArray(style.layers))throw new Error('MapTilerStyleAdapter requires a style JSON object with layers[]');
    this.style=style;this.source=source;this.zoomProvider=typeof zoomProvider==='function'?zoomProvider:null;this.supportedTypes=new Set(supportedTypes);this.layers=style.layers.map((layer,index)=>({layer,index})).filter(x=>this.supportedTypes.has(x.layer.type));
  }
  matchingLayers(sourceLayer,feature,{resolution=1,tile=null}={}){
    const zoom=zoomOf(tile,resolution,this.zoomProvider),ctx={feature,zoom,resolution,tile};
    return this.layers.filter(({layer})=>{
      if(!visible(layer))return false;
      if(this.source&&layer.source&&layer.source!==this.source)return false;
      if(layer['source-layer']!=null&&layer['source-layer']!==sourceLayer)return false;
      if(layer.minzoom!=null&&zoom<num(layer.minzoom))return false;
      if(layer.maxzoom!=null&&zoom>=num(layer.maxzoom))return false;
      return layer.filter==null||evaluateFilter(layer.filter,ctx);
    });
  }
  resolve(sourceLayer,feature,resolution=1,tile=null){
    const zoom=zoomOf(tile,resolution,this.zoomProvider),ctx={feature,zoom,resolution,tile};
    return this.matchingLayers(sourceLayer,feature,{resolution,tile}).map(({layer,index})=>flatStyle(layer,ctx,index)).filter(Boolean);
  }
  resolver(){return (sourceLayer,feature,resolution,tile)=>this.resolve(sourceLayer,feature,resolution,tile);}
  sourceLayerFilter(){const layers=new Set(this.layers.map(x=>x.layer['source-layer']).filter(x=>x!=null));return sourceLayer=>layers.size===0||layers.has(sourceLayer);}
}
