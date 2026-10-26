const NAMED={black:[0,0,0,1],white:[1,1,1,1],red:[1,0,0,1],green:[0,128/255,0,1],blue:[0,0,1,1],transparent:[0,0,0,0]};
function clamp01(v){return Math.max(0,Math.min(1,Number(v)));}
function hue2rgb(p,q,t){if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;}
function hslToRgba(h,s,l,a=1){h=((Number(h)%360)+360)%360/360;s=clamp01(s);l=clamp01(l);if(s===0)return [l,l,l,clamp01(a)];const q=l<.5?l*(1+s):l+s-l*s,p=2*l-q;return [hue2rgb(p,q,h+1/3),hue2rgb(p,q,h),hue2rgb(p,q,h-1/3),clamp01(a)];}
export function colorToRgba(color){
  if(color==null) return null;
  if(Array.isArray(color)){
    const rgb=color.slice(0,3).map(v=>Number(v)>1?Number(v)/255:Number(v));
    return [clamp01(rgb[0]||0),clamp01(rgb[1]||0),clamp01(rgb[2]||0),clamp01(color.length>3?color[3]:1)];
  }
  if(typeof color!=='string') return null;
  const s=color.trim().toLowerCase(); if(NAMED[s]) return [...NAMED[s]];
  let m=s.match(/^#([0-9a-f]{3,8})$/i);
  if(m){let h=m[1];if(h.length===3||h.length===4)h=h.split('').map(x=>x+x).join('');if(h.length===6||h.length===8){const n=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255);return [...n,h.length===8?parseInt(h.slice(6,8),16)/255:1];}}
  m=s.match(/^rgba?\(([^)]+)\)$/);
  if(m){const p=m[1].split(',').map(x=>x.trim());if(p.length>=3){const cv=x=>x.endsWith('%')?parseFloat(x)/100:parseFloat(x)/255;return [clamp01(cv(p[0])),clamp01(cv(p[1])),clamp01(cv(p[2])),clamp01(p[3]==null?1:parseFloat(p[3]))];}}
  m=s.match(/^hsla?\(([^)]+)\)$/);
  if(m){const p=m[1].split(',').map(x=>x.trim());if(p.length>=3){const pct=x=>x.endsWith('%')?parseFloat(x)/100:parseFloat(x);return hslToRgba(parseFloat(p[0]),pct(p[1]),pct(p[2]),p[3]==null?1:parseFloat(p[3]));}}
  return null;
}
function read(obj,method,prop){if(!obj)return undefined;if(typeof obj[method]==='function')return obj[method]();return obj[prop];}
function scale2(v){if(Array.isArray(v))return [Number(v[0]??1),Number(v[1]??v[0]??1)];const n=Number(v??1);return [n,n];}
// Internal shader enum: round=0, butt=4, square=5; round=0, bevel=6, miter=7.
function cap(v){return ({round:0,butt:4,square:5})[v]??0;}
function join(v){return ({round:0,bevel:6,miter:7})[v]??0;}
function flatToNeutral(style){
  const out={zIndex:style['z-index']??style.zIndex??0};
  if(style['fill-color']!=null) out.fill={color:colorToRgba(style['fill-color']),patternSrc:style['fill-pattern-src']??null};
  if(style['stroke-color']!=null||style['stroke-width']!=null||style['stroke-pattern-src']) out.stroke={
    color:colorToRgba(style['stroke-color']??[0,0,0,1]), width:Number(style['stroke-width']??1),
    lineCap:style['stroke-line-cap']??'round', lineJoin:style['stroke-line-join']??'round',
    dash:style['stroke-line-dash']?[...style['stroke-line-dash']]:null, dashOffset:Number(style['stroke-line-dash-offset']??0),
    miterLimit:Number(style['stroke-miter-limit']??10), offset:Number(style['stroke-offset']??0), patternSrc:style['stroke-pattern-src']??null,
    patternSpacing:Number(style['stroke-pattern-spacing']??0), patternStartOffset:Number(style['stroke-pattern-start-offset']??0),
  };
  if(style['circle-radius']!=null) out.point={kind:'circle',radius:Number(style['circle-radius']),fillColor:colorToRgba(style['circle-fill-color']),strokeColor:colorToRgba(style['circle-stroke-color']),strokeWidth:Number(style['circle-stroke-width']??0),opacity:Number(style['circle-opacity']??1),rotation:Number(style['circle-rotation']??0),rotateWithView:Boolean(style['circle-rotate-with-view']??false),scale:style['circle-scale']??1,displacement:style['circle-displacement']?[...style['circle-displacement']]:[0,0]};
  if(style['icon-src']) out.point={kind:'icon',src:style['icon-src'],opacity:Number(style['icon-opacity']??1),rotation:Number(style['icon-rotation']??0),rotateWithView:Boolean(style['icon-rotate-with-view']??false),scale:style['icon-scale']??1,displacement:style['icon-displacement']?[...style['icon-displacement']]:[0,0],anchor:style['icon-anchor']?[...style['icon-anchor']]:null};
  return out;
}
function classicToNeutral(style){
  const fill=read(style,'getFill','fill'), stroke=read(style,'getStroke','stroke'), image=read(style,'getImage','image');
  const out={zIndex:Number(read(style,'getZIndex','zIndex')??0)};
  if(fill){const c=read(fill,'getColor','color');out.fill={color:colorToRgba(c),patternSrc:null};}
  if(stroke){out.stroke={color:colorToRgba(read(stroke,'getColor','color')??[0,0,0,1]),width:Number(read(stroke,'getWidth','width')??1),lineCap:read(stroke,'getLineCap','lineCap')??'round',lineJoin:read(stroke,'getLineJoin','lineJoin')??'round',dash:[...(read(stroke,'getLineDash','lineDash')||[])],dashOffset:Number(read(stroke,'getLineDashOffset','lineDashOffset')??0),miterLimit:Number(read(stroke,'getMiterLimit','miterLimit')??10),offset:0,patternSrc:null};}
  if(image){
    const radius=read(image,'getRadius','radius');
    if(radius!=null){
      const ifill=read(image,'getFill','fill'), istroke=read(image,'getStroke','stroke'), points=read(image,'getPoints','points');
      const kind=points===4?'square':'circle';
      out.point={kind,radius:Number(radius),fillColor:colorToRgba(read(ifill,'getColor','color')),strokeColor:colorToRgba(read(istroke,'getColor','color')),strokeWidth:Number(read(istroke,'getWidth','width')??0),opacity:Number(read(image,'getOpacity','opacity')??1),rotation:Number(read(image,'getRotation','rotation')??0),rotateWithView:Boolean(read(image,'getRotateWithView','rotateWithView')??false),scale:read(image,'getScale','scale')??1,displacement:[...(read(image,'getDisplacement','displacement')||[0,0])]};
    }else{
      const img=read(image,'getImage','image');
      const size=read(image,'getImageSize','imgSize')||read(image,'getSize','size')||(img&&[img.width,img.height]);
      const src=read(image,'getSrc','src')||null;
      const anchor=read(image,'getAnchor','anchor')||null;
      if(img&&size){
        out.point={kind:'icon',image:img,src,width:Number(size[0]||img.width||1),height:Number(size[1]||img.height||1),anchor:anchor?[...anchor]:null,opacity:Number(read(image,'getOpacity','opacity')??1),rotation:Number(read(image,'getRotation','rotation')??0),rotateWithView:Boolean(read(image,'getRotateWithView','rotateWithView')??false),scale:read(image,'getScale','scale')??1,displacement:[...(read(image,'getDisplacement','displacement')||[0,0])]};
      }
    }
  }
  const text=read(style,'getText','text');
  if(text){
    const tf=read(text,'getFill','fill'),ts=read(text,'getStroke','stroke');const value=read(text,'getText','text');
    if(value!=null&&String(value)!=='')out.text={
      text:String(value),font:read(text,'getFont','font')||'10px sans-serif',fillColor:colorToRgba(read(tf,'getColor','color')||'#333'),strokeColor:colorToRgba(read(ts,'getColor','color')),strokeWidth:Number(read(ts,'getWidth','width')??0),
      offsetX:Number(read(text,'getOffsetX','offsetX')??0),offsetY:Number(read(text,'getOffsetY','offsetY')??0),rotation:Number(read(text,'getRotation','rotation')??0),rotateWithView:Boolean(read(text,'getRotateWithView','rotateWithView')??false),scale:read(text,'getScale','scale')??1,
      textAlign:read(text,'getTextAlign','textAlign')||'center',justify:read(text,'getJustify','justify')||null,textBaseline:read(text,'getTextBaseline','textBaseline')||'middle',padding:[...(read(text,'getPadding','padding')||[0,0,0,0])]
    };
  }
  return out;
}

/** Translate public OL Style/FlatStyle values into renderer-neutral descriptors. */
export function toNeutralStyles(styleLike,{feature=null,resolution=1}={}){
  if(styleLike==null) return [];
  const resolved=typeof styleLike==='function'?styleLike(feature,resolution):styleLike;
  const list=Array.isArray(resolved)?resolved:[resolved];
  return list.filter(Boolean).map(s=>{
    const neutral=(typeof s.getFill==='function'||typeof s.getStroke==='function'||typeof s.getImage==='function')?classicToNeutral(s):flatToNeutral(s);
    if(neutral.stroke){neutral.stroke.capCode=cap(neutral.stroke.lineCap);neutral.stroke.joinCode=join(neutral.stroke.lineJoin);}
    return neutral;
  });
}

function rgbaCss(c){const x=c||[0,0,0,0];return `rgba(${Math.round((x[0]||0)*255)},${Math.round((x[1]||0)*255)},${Math.round((x[2]||0)*255)},${x[3]??1})`;}
function alignAnchorX(align,w,padL,padR){if(align==='left'||align==='start')return padL;if(align==='right'||align==='end')return w-padR;return w/2;}
function baselineAnchorY(base,h,padT,padB,ascent){if(base==='top'||base==='hanging')return padT;if(base==='bottom'||base==='ideographic')return h-padB;if(base==='alphabetic')return padT+ascent;return h/2;}
function makeTextSprite(t){
  const c=document.createElement('canvas'),ctx=c.getContext('2d');ctx.font=t.font||'10px sans-serif';const m=ctx.measureText(t.text);
  const stroke=t.strokeWidth||0,p=t.padding||[0,0,0,0],extra=Math.ceil(stroke+2);const pt=Number(p[0]||0)+extra,pr=Number(p[1]||0)+extra,pb=Number(p[2]||0)+extra,pl=Number(p[3]||0)+extra;
  const fontPx=Number((String(t.font||'10px').match(/([0-9.]+)px/)||[])[1]||10);const ascent=Math.ceil(m.actualBoundingBoxAscent||fontPx*.8),descent=Math.ceil(m.actualBoundingBoxDescent||fontPx*.25);const left=Math.ceil(m.actualBoundingBoxLeft||0),right=Math.ceil(m.actualBoundingBoxRight||m.width);
  c.width=Math.max(1,Math.ceil(left+right+pl+pr));c.height=Math.max(1,Math.ceil(ascent+descent+pt+pb));
  const x=c.getContext('2d');x.font=t.font||'10px sans-serif';x.textAlign='left';x.textBaseline='alphabetic';const dx=pl+left,dy=pt+ascent;
  if(t.strokeColor&&stroke){x.strokeStyle=rgbaCss(t.strokeColor);x.lineWidth=stroke;x.strokeText(t.text,dx,dy);}x.fillStyle=rgbaCss(t.fillColor||[0,0,0,1]);x.fillText(t.text,dx,dy);
  return {canvas:c,anchor:[alignAnchorX(t.textAlign,c.width,pl,pr),baselineAnchorY(t.textBaseline,c.height,pt,pb,ascent)]};
}

/** Convert the currently renderer-supported neutral subset to StyleStore payload. */
export function toRendererStyle(neutral,geometryKind){
  if(geometryKind==='polygon') return {color:neutral.fill?.color||[0,0,0,0],premultiplyAlpha:true};
  if(geometryKind==='point'){
    const p=neutral.point||{};
    if(p.kind==='icon'&&p.image){
      const [sx,sy]=scale2(p.scale),w=p.width,h=p.height,anchor=p.anchor||[w/2,h/2];
      const spriteSize=[Math.abs(w*sx),Math.abs(h*sy)], pointSize=Math.max(...spriteSize);
      const displacementScreen=[(w/2-anchor[0])*sx,(h/2-anchor[1])*sy];
      return {color:[1,1,1,p.opacity??1],pointSize,pointShape:2,spriteSize,symbolRotation:p.rotation||0,spriteRotation:-(p.rotation||0),spriteRotateWithView:Boolean(p.rotateWithView),spriteKey:`ol-icon:${p.src||''}:${w}x${h}:${anchor.join(',')}`,spriteDescriptor:{width:w,height:h,bytes:w*h*4,sourceFactory:()=>p.image},spriteOpacity:p.opacity??1,pointDisplacementScreen:displacementScreen,premultiplyAlpha:true};
    }
    if(neutral.text&&typeof document!=='undefined'){
      const t=neutral.text,[sx,sy]=scale2(t.scale),sprite=makeTextSprite(t),c=sprite.canvas,w=c.width,h=c.height,anchor=sprite.anchor;
      const spriteSize=[Math.abs(w*sx),Math.abs(h*sy)],pointSize=Math.max(...spriteSize);
      const displacementScreen=[(w/2-anchor[0])*sx+(t.offsetX||0),(h/2-anchor[1])*sy+(t.offsetY||0)];
      return {color:[1,1,1,1],pointSize,pointShape:2,spriteSize,symbolRotation:t.rotation||0,spriteRotation:-(t.rotation||0),spriteRotateWithView:Boolean(t.rotateWithView),spriteKey:`ol-text:${t.text}:${t.font}:${t.textAlign}:${t.textBaseline}:${JSON.stringify(t.fillColor)}:${JSON.stringify(t.strokeColor)}:${t.strokeWidth}:${JSON.stringify(t.padding)}`,spriteDescriptor:{width:w,height:h,bytes:w*h*4,sourceFactory:()=>c},spriteOpacity:1,pointDisplacementScreen:displacementScreen,premultiplyAlpha:true};
    }
    const color=[...(p.fillColor||neutral.fill?.color||[1,1,1,1])];color[3]=(color[3]??1)*(p.opacity??1);const radius=p.radius||3;const [sx,sy]=scale2(p.scale);// OL CircleStyle radius measures the fill edge; the stroke is centred
    // on that edge and contributes half its width on *both* sides. WebGL
    // point size must cover the entire outer stroke, not only the fill.
    const pointSize=((p.kind==='square'?radius*Math.SQRT2:radius*2)
      +(p.kind==='circle'?Math.max(0,Number(p.strokeWidth||0)):0))*Math.max(Math.abs(sx),Math.abs(sy));
    return {color,pointSize,pointShape:p.kind==='circle'?1:0,pointStrokeColor:p.strokeColor||[0,0,0,0],pointStrokeWidth:(p.strokeWidth||0)*Math.max(Math.abs(sx),Math.abs(sy)),pointDisplacementScreen:[Number(p.displacement?.[0]||0),-Number(p.displacement?.[1]||0)],symbolRotation:p.rotation||0,spriteRotation:-(p.rotation||0),spriteRotateWithView:Boolean(p.rotateWithView),premultiplyAlpha:true};
  }
  if(geometryKind==='line'){
    const s=neutral.stroke||{};
    return {strokeColor:s.color||[0,0,0,1],strokeWidth:s.width??1,strokeOffset:s.offset||0,strokeCap:s.capCode||0,strokeJoin:s.joinCode||0,strokeMiterLimit:s.miterLimit||10,dashPattern:s.dash?.length?s.dash:undefined,dashOffset:s.dashOffset||0,useStrokePattern:Boolean(s.patternSrc),strokePatternTextureKey:s.patternSrc||undefined,strokePatternTextureSpacing:s.patternSpacing||20,strokePatternTextureStartOffset:s.patternStartOffset||0,strokePatternTextureOffset:[0,0]};
  }
  throw new Error(`Unsupported geometry kind: ${geometryKind}`);
}
