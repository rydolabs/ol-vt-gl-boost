export const lineVertexShader = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
//instance buffer(divisor = 1)
attribute vec2  a_segmentStart;
attribute vec2  a_segmentEnd;
attribute float a_distance;
attribute vec2  a_joinAngles;
attribute float a_angleTangentSum;//a_parameters

//static quad buffer(divisor = 0)
attribute vec2  a_quadCorner; // a_parameters -> static vertex buffer

uniform mat4  u_projectionMatrix;
uniform float u_worldOffsetX;
uniform vec2  u_viewportSizePx;
uniform float u_depth;
uniform float u_resolution;

uniform float u_strokeWidth;
uniform float u_strokeOffset;

varying vec2  v_segmentStart;
varying vec2  v_segmentEnd;
varying float v_angleStart;
varying float v_angleEnd;
varying float v_distanceOffsetPx;
varying float v_segmentLength;
varying vec2  v_segmentTangent;

vec2 worldToPx(vec2 worldPos) {
  vec4 screenPos = u_projectionMatrix * vec4(worldPos + vec2(u_worldOffsetX, 0.0), 0.0, 1.0);
  return (0.5 * (screenPos.xy / screenPos.w) + 0.5) * u_viewportSizePx;
}

vec4 pxToScreen(vec2 pxPos) {
  vec2 screen = 2.0 * pxPos / u_viewportSizePx - 1.0;
  return vec4(screen, u_depth, 1.0);
}

bool isCap(float joinAngle) {
  return joinAngle < -0.1;
}
vec2 getJoinOffsetDirection(vec2 normalPx, float joinAngle) {
  float halfAngle = joinAngle / 2.0;
  float c = cos(halfAngle);
  float s = sin(halfAngle);
  vec2 angleBisectorNormal = vec2(s * normalPx.x + c * normalPx.y, -c * normalPx.x + s * normalPx.y);
  float length = 1.0 / s;
  return angleBisectorNormal * length;
}

vec2 getOffsetPoint(vec2 point, vec2 normal, float joinAngle, float cosJoinAngle, float offsetPx) {
  if (cosJoinAngle > 0.998 || isCap(joinAngle))
    return point - normal * offsetPx;
  return point - getJoinOffsetDirection(normal, joinAngle) * offsetPx;
}


void main() {
  v_angleStart = a_joinAngles.x;
  v_angleEnd = a_joinAngles.y;

  vec2 segmentStartPx = worldToPx(a_segmentStart);
  vec2 segmentEndPx = worldToPx(a_segmentEnd);  
  vec2 tangentPx = normalize(segmentEndPx - segmentStartPx);
  vec2 normalPx = vec2(-tangentPx.y, tangentPx.x);
  float cosAngleStart = cos(v_angleStart);
  float cosAngleEnd = cos(v_angleEnd);
  segmentStartPx = getOffsetPoint(segmentStartPx, normalPx, v_angleStart, cosAngleStart, u_strokeOffset);
  segmentEndPx = getOffsetPoint(segmentEndPx, normalPx, v_angleEnd, cosAngleEnd, u_strokeOffset);
  
  float normalDir  = a_quadCorner.y < 0.0 ?  1.0 : -1.0;
  float tangentDir = a_quadCorner.x < 0.0 ?  1.0 : -1.0;
  float angle = a_quadCorner.x < 0.0 ? v_angleStart : v_angleEnd;
  vec2 joinDirection;  
  vec2  positionPx = a_quadCorner.x < 0.0 ? segmentStartPx : segmentEndPx;

  float cosAngle = a_quadCorner.x < 0.0 ? cosAngleStart : cosAngleEnd;
  if (cosAngle > 0.985 || isCap(angle)) {
    joinDirection = normalPx * normalDir - tangentPx * tangentDir;
  } else {
    joinDirection = getJoinOffsetDirection(normalPx * normalDir, angle);
  }

  positionPx = positionPx + joinDirection * (u_strokeWidth * 0.5 + 1.);
  gl_Position = pxToScreen(positionPx);

  v_segmentStart = segmentStartPx;
  v_segmentEnd   = segmentEndPx;
  v_distanceOffsetPx = a_distance / u_resolution - (u_strokeOffset * a_angleTangentSum);
  v_segmentLength = length(segmentEndPx - segmentStartPx);
  v_segmentTangent = tangentPx;
}
`;

export const lineFragmentShader = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2  v_segmentStart;
varying vec2  v_segmentEnd;
varying float v_angleStart;
varying float v_angleEnd;

varying float v_distanceOffsetPx;
varying float v_segmentLength;
varying vec2  v_segmentTangent;

uniform float u_strokeWidth;
uniform vec4 u_strokeColor;
uniform float u_pixelRatio;
uniform float u_globalAlpha;
uniform float u_strokeCap;
uniform float u_strokeJoin;
uniform float u_strokeMiterLimit;

uniform float u_dashPattern[8];
uniform int u_dashCount;
uniform float u_dashOffset;
uniform float u_dashTotalLength;

uniform bool u_useStrokePattern;
uniform sampler2D u_strokePatternTexture;
uniform vec2  u_strokePatternTextureSize;
uniform vec2  u_strokePatternTextureOffset;
uniform vec2 u_strokePatternTextureSampleSize;
uniform float u_strokePatternTextureSpacing;
uniform float u_strokePatternTextureStartOffset;

vec4 sampleStrokePattern(sampler2D texture, vec2 textureSize, vec2 textureOffset, vec2 sampleSize, float spacingPx, float startOffsetPx, float currentLengthPx, float currentRadiusRatio, float lineWidth) {
  float scaleFactor = sampleSize.y / lineWidth;
  float currentLengthScaled = currentLengthPx * scaleFactor;
  float spacingScaled = max(spacingPx * scaleFactor, sampleSize.x);
  float uCoordPx = mod(currentLengthScaled - startOffsetPx * scaleFactor + sampleSize.x, spacingScaled);
  // make sure that we're not sampling too close to the borders to avoid interpolation with outside pixels
  uCoordPx = clamp(uCoordPx, 0.5, sampleSize.x - 0.5);
  if (uCoordPx > sampleSize.x - 1.0) return vec4(0.0);
  float vCoordPx = (0.5 - 0.5 * currentRadiusRatio) * sampleSize.y;
  vec2  texCoord = (vec2(uCoordPx, vCoordPx) + textureOffset) / textureSize; 
  return texture2D(texture, texCoord);
}

float getSingleDashDistance(float distance, float radius, float dashOffset, float dashLength, float dashLengthTotal, float capType, float lineWidth) {
  float localDistance = mod(distance, dashLengthTotal);
  float distanceSegment = abs(localDistance - dashOffset - dashLength * 0.5) - dashLength * 0.5;
  distanceSegment = min(distanceSegment, dashLengthTotal - localDistance);
  if (capType == 5.0) {
    distanceSegment -= lineWidth * 0.5;
  } else if (capType == 0.0) {
    distanceSegment = min(distanceSegment, sqrt(distanceSegment * distanceSegment + radius * radius) - lineWidth * 0.5);
  }
  return distanceSegment;
}

float dashDistanceField(float distance, float radius, float capType, float lineWidth,
  float dashPattern[8], int dashCount, float dashOffset, float totalDashLength) {

  float minDistance = 1e6;
  float currentOffset = 0.0;
  for (int i = 0; i < 8; i += 2) {
    if (i + 1 >= dashCount) break;
    float dashLength = dashPattern[i];
    float gapLength = dashPattern[i+1];
    float dashDist = getSingleDashDistance(distance + dashOffset, radius, currentOffset, dashLength, totalDashLength, capType, lineWidth);
    minDistance = min(minDistance, dashDist);
    currentOffset += dashLength + gapLength;
  }
  return minDistance;

}

bool isCap(float a) { return a < -0.1; }
float segmentDistanceField(vec2 point, vec2 start, vec2 end, float width) {
  vec2 tangent = normalize(end - start);
  vec2 normal = vec2(-tangent.y, tangent.x);
  vec2 startToPoint = point - start;
  return abs(dot(startToPoint, normal)) - width * 0.5;
}
float buttCapDistanceField(vec2 point, vec2 start, vec2 end) {
  vec2 startToPoint = point - start;
  vec2 tangent = normalize(end - start);
  return dot(startToPoint, -tangent);
}
float squareCapDistanceField(vec2 point, vec2 start, vec2 end, float width) {
  return buttCapDistanceField(point, start, end) - width * 0.5;
}
float roundCapDistanceField(vec2 point, vec2 start, vec2 end, float width) {
  float onSegment = max(0., 1000. * dot(point - start, end - start));
  return length(point - start) - width * 0.5 - onSegment;
}

float roundJoinDistanceField(vec2 point, vec2 start, vec2 end, float width) {
  return roundCapDistanceField(point, start, end, width);
}

float bevelJoinFieldFromTrig(vec2 point, vec2 start, vec2 end, float width, float c, float s, float direction) {
  vec2 startToPoint = point - start;
  vec2 tangent = normalize(end - start);
  vec2 bisector = vec2(c * tangent.x - s * tangent.y, s * tangent.x + c * tangent.y);
  float radius = width * 0.5 * s;
  return dot(startToPoint, bisector * direction) - radius;
}

float bevelJoinField(vec2 point, vec2 start, vec2 end, float width, float joinAngle) {
  float halfAngle = joinAngle * 0.5;
  return bevelJoinFieldFromTrig(point, start, end, width, cos(halfAngle), sin(halfAngle), -sign(sin(joinAngle)));
}

float miterJoinDistanceField(vec2 point, vec2 start, vec2 end, float width, float joinAngle) {
  float halfAngle = joinAngle * 0.5;
  float s = sin(halfAngle);
  if (cos(joinAngle) > 0.985) { // avoid risking a division by zero
    return bevelJoinFieldFromTrig(point, start, end, width, cos(halfAngle), s, -sign(sin(joinAngle)));
  }
  float miterLength = 1. / s;
  float miterLimit = u_strokeMiterLimit;
  if (miterLength > miterLimit) {
    return bevelJoinFieldFromTrig(point, start, end, width, cos(halfAngle), s, -sign(sin(joinAngle)));
  }
  return -1000.;
}

float capDistanceField(vec2 point, vec2 start, vec2 end, float width, float capType) {
   if (capType == 4.0) {
    return buttCapDistanceField(point, start, end);
  } else if (capType == 5.0) {
    return squareCapDistanceField(point, start, end, width);
  }
  return roundCapDistanceField(point, start, end, width);
}

float joinDistanceField(vec2 point, vec2 start, vec2 end, float width, float joinAngle, float joinType) {
  if (joinType == 6.0) {
    return bevelJoinField(point, start, end, width, joinAngle);
  } else if (joinType == 7.0) {
    return miterJoinDistanceField(point, start, end, width, joinAngle);
  }
  return roundJoinDistanceField(point, start, end, width);
}

float computeSegmentPointDistance(vec2 point, vec2 start, vec2 end, float width, float joinAngle, float capType, float joinType) {
  if (isCap(joinAngle)) {
    return capDistanceField(point, start, end, width, capType);
  }
  return joinDistanceField(point, start, end, width, joinAngle, joinType);
}

float distanceFromSegment(vec2 point, vec2 start, vec2 end) {
  vec2 tangent = end - start;
  vec2 startToPoint = point - start;
  // inspire by capsule fn in https://iquilezles.org/articles/distfunctions/
  float h = clamp(dot(startToPoint, tangent) / dot(tangent, tangent), 0.0, 1.0);
  return length(startToPoint - tangent * h);
}

void main() {
  vec2  currentPoint = gl_FragCoord.xy / u_pixelRatio;

  float segmentLength = v_segmentLength;
  vec2 segmentTangent = v_segmentTangent;

  float currentLengthPx = max(0., min(dot(segmentTangent, currentPoint - v_segmentStart), segmentLength)) + v_distanceOffsetPx;

  float segmentStartDistance = computeSegmentPointDistance(currentPoint, v_segmentStart, v_segmentEnd, u_strokeWidth, v_angleStart, u_strokeCap, u_strokeJoin);
  float segmentEndDistance = computeSegmentPointDistance(currentPoint, v_segmentEnd, v_segmentStart, u_strokeWidth, v_angleEnd, u_strokeCap, u_strokeJoin);
  float distanceField = max(
    segmentDistanceField(currentPoint, v_segmentStart, v_segmentEnd, u_strokeWidth),
    max(segmentStartDistance, segmentEndDistance)
  );

  float dashField = -1000.0;
  if (u_dashCount > 0) {
    float currentRadiusPx = distanceFromSegment(currentPoint, v_segmentStart, v_segmentEnd);
    dashField = dashDistanceField(currentLengthPx, currentRadiusPx, u_strokeCap, u_strokeWidth, u_dashPattern, u_dashCount, u_dashOffset, u_dashTotalLength);
  }
  distanceField = max(distanceField, dashField);
  vec4 color = u_strokeColor;
  if (u_useStrokePattern) {
    vec2 segmentNormal = vec2(-segmentTangent.y, segmentTangent.x);
    float currentRadiusRatio = dot(segmentNormal, currentPoint - v_segmentStart) * 2. / u_strokeWidth;  
    color = u_strokeColor * sampleStrokePattern(
      u_strokePatternTexture,
      u_strokePatternTextureSize,
      u_strokePatternTextureOffset,
      u_strokePatternTextureSampleSize,
      u_strokePatternTextureSpacing,
      u_strokePatternTextureStartOffset,
      currentLengthPx,
      currentRadiusRatio,
      u_strokeWidth
    );
  }

  color.a *= smoothstep(0.5, -0.5, distanceField);
  gl_FragColor = color;
  gl_FragColor.a *= u_globalAlpha;
  gl_FragColor.rgb *= gl_FragColor.a;

  // Ordinary OL screen paint keeps low-alpha fragments; discard only applies to hit detection.
}
`;


/** Solid-stroke experimental GPU join path: previous/start/end/next XY.
 * The flat coordinates are reused directly in the adapter without path objects.
 * Unlike the legacy shader, no CPU join angles/tangent sums/distances are read.
 * Dash/texture/offset strokes must stay on the existing shader path.
 */
export const lineGpuJoinVertexShader = lineVertexShader
  .replace(
    'attribute vec2  a_segmentStart;\nattribute vec2  a_segmentEnd;\nattribute float a_distance;\nattribute vec2  a_joinAngles;\nattribute float a_angleTangentSum;//a_parameters',
    'attribute vec2 a_prevPoint;\nattribute vec2 a_segmentStart;\nattribute vec2 a_segmentEnd;\nattribute vec2 a_nextPoint;')
  .replace('void main() {\n  v_angleStart = a_joinAngles.x;\n  v_angleEnd = a_joinAngles.y;', `
float gpuAngleBetween(vec2 p0, vec2 pA, vec2 pB) {
  vec2 a=pA-p0;
  vec2 b=pB-p0;
  if(dot(a,a)==0.0 || dot(b,b)==0.0)return 0.0;
  float theta=atan(a.x*b.y-a.y*b.x,a.x*b.x+a.y*b.y);
  return theta <= 0.0 ? theta + 6.283185307179586 : theta;
}
void main() {
  v_angleStart = all(equal(a_prevPoint,a_segmentStart)) ? -1.0 :
    gpuAngleBetween(a_segmentStart,a_segmentEnd,a_prevPoint);
  v_angleEnd = all(equal(a_nextPoint,a_segmentEnd)) ? -1.0 :
    6.283185307179586 - gpuAngleBetween(a_segmentEnd,a_nextPoint,a_segmentStart);`)
  .replace('v_distanceOffsetPx = a_distance / u_resolution - (u_strokeOffset * a_angleTangentSum);',
    'v_distanceOffsetPx = 0.0;');


/** Sliding-window WebGL1 raw vertex buffer shader. The same XY position is
 * stored only once in a shared [x,y,flags] array. ANGLE instancing advances
 * four vec2 attributes through that array with overlapping offsets, so no
 * per-segment CPU expansion or GPU texture fetch is required. */
export const lineFlatVertexShader = lineGpuJoinVertexShader
  .replace('attribute vec2 a_nextPoint;', 'attribute vec2 a_nextPoint;\nattribute float a_startFlags;\nattribute float a_endFlags;')
  .replace('void main() {\n  v_angleStart = all(equal(a_prevPoint,a_segmentStart)) ? -1.0 :',
    `void main() {
  // A reference/path boundary produces a virtual segment. Never rasterize it.
  // First bit: path start. Second bit: path end.
  if(a_startFlags >= 1.5 || mod(a_endFlags,2.0) > 0.5){
    gl_Position = vec4(3.0,3.0,0.0,1.0);
    return;
  }
  v_angleStart = mod(a_startFlags,2.0) > 0.5 ? -1.0 :`)
  .replace('v_angleEnd = all(equal(a_nextPoint,a_segmentEnd)) ? -1.0 :',
    'v_angleEnd = a_endFlags >= 1.5 ? -1.0 :');
