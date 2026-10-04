/** Original procedural materials for the interactive observatory. */
const noiseFunctions = `
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float value = 0.0;
  float weight = 0.5;
  for (int i = 0; i < 4; i++) {
    value += noise(p) * weight;
    p = p * 2.03 + vec3(11.3, 7.1, 2.8);
    weight *= 0.5;
  }
  return value;
}
`;

export const cosmicVertexShader = `
varying vec2 vUv;
varying vec3 vLocal;
varying vec3 vNormal;
void main() {
  vUv = uv;
  vLocal = position;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const diskFragmentShader = `
uniform float uTime;
uniform float uEnergy;
uniform float uThinking;
uniform float uHearing;
uniform float uSpeaking;
uniform float uError;
uniform float uOpacity;
varying vec3 vLocal;
${noiseFunctions}
void main() {
  float radius = length(vLocal.xy);
  float r = clamp((radius - 1.16) / 2.6, 0.0, 1.0);
  float angle = atan(vLocal.y, vLocal.x);
  float speed = mix(4.5, 0.38, pow(r, 0.65));
  float flow = angle - uTime * speed;
  vec3 samplePoint = vec3(cos(flow), sin(flow), radius * 1.9);
  float wisps = fbm(samplePoint * 4.5 + vec3(radius * 2.0, uTime * 0.13, 0.0));
  float fine = fbm(samplePoint * 13.0 + vec3(uTime * 0.05));
  float strands = pow(0.5 + 0.5 * sin(radius * 38.0 + wisps * 13.0), 3.0);
  float spiral = pow(0.5 + 0.5 * sin(flow * 5.0 + radius * 15.0 + wisps * 8.0), 6.0);
  float innerHeat = exp(-r * 4.3);
  float beaming = 0.7 + 0.55 * cos(angle - 0.7);
  vec3 ember = mix(vec3(0.28, 0.05, 0.018), vec3(1.6, 0.58, 0.18), innerHeat);
  ember = mix(ember, vec3(2.7, 1.95, 1.1), pow(innerHeat, 3.0));
  ember += vec3(0.24, 0.09, 0.45) * uThinking * wisps;
  ember += vec3(0.05, 0.25, 0.3) * uHearing * (1.0-r);
  ember = mix(ember, vec3(0.8, 0.03, 0.06), uError * 0.6);
  float density = (0.25 + wisps * 1.0 + fine * 0.25 + strands * 0.35 + spiral * 0.5);
  float fade = smoothstep(0.0, 0.045, r) * (1.0 - smoothstep(0.65, 1.0, r));
  float brightness = beaming * density * (0.65 + innerHeat * 0.7 + uEnergy * 0.55);
  gl_FragColor = vec4(ember * brightness, fade * (0.4 + wisps * 0.6) * uOpacity);
}
`;

export const lensFragmentShader = `
uniform float uTime;
uniform float uEnergy;
uniform float uThinking;
uniform float uHearing;
uniform float uSpeaking;
uniform float uError;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float r = length(p);
  float angle = atan(p.y, p.x);
  float photon = exp(-pow((r - 0.302) * 110.0, 2.0));
  float atmosphere = exp(-abs(r - 0.307) * 70.0) * 0.13;
  float arcs = exp(-pow((r - 0.34) * 30.0, 2.0));
  arcs *= pow(max(0.0, sin(angle)), 4.0) * 0.17;
  float beaming = 0.55 + pow(0.5 + 0.5 * cos(angle + 0.4), 2.0) * 1.0;
  vec3 warm = vec3(1.6, 0.95, 0.5);
  warm = mix(warm, vec3(0.8, 1.55, 1.9), uHearing * 0.45 + uSpeaking * uEnergy * 0.4);
  warm = mix(warm, vec3(1.2, 0.58, 1.8), uThinking * 0.25);
  warm = mix(warm, vec3(1.3, 0.07, 0.12), uError * 0.7);
  float emission = (photon * 0.6 + atmosphere + arcs) * beaming;
  gl_FragColor = vec4(warm * (1.0 + uEnergy), emission * uOpacity);
}
`;

export const sunFragmentShader = `
uniform float uTime;
uniform float uEnergy;
uniform float uThinking;
uniform float uHearing;
uniform float uSpeaking;
uniform float uError;
uniform float uOpacity;
varying vec3 vLocal;
varying vec3 vNormal;
${noiseFunctions}
void main() {
  float cells = fbm(vLocal * 9.0 + vec3(uTime * 0.15, 0.0, uTime * 0.08));
  float fine = noise(vLocal * 32.0 + vec3(uTime * 0.1));
  vec3 hot = mix(vec3(1.5, 0.22, 0.01), vec3(3.0, 1.8, 0.58), cells);
  hot += fine * 0.4 + uEnergy * vec3(0.7, 0.4, 0.2);
  hot = mix(hot, vec3(1.7, 0.09, 0.02), uError * 0.65);
  gl_FragColor = vec4(hot, uOpacity);
}
`;

export const atmosphereFragmentShader = `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vNormal;
void main() {
  float rim = pow(1.0 - abs(normalize(vNormal).z), 3.4);
  gl_FragColor = vec4(uColor * 1.2, rim * 0.42 * uOpacity);
}
`;

export const planetFragmentShader = `
uniform vec3 uColor;
uniform float uSeed;
uniform float uOpacity;
varying vec3 vLocal;
varying vec3 vNormal;
${noiseFunctions}
void main() {
  float terrain = fbm(vLocal * 15.0 + vec3(uSeed * 7.0));
  float bands = sin(vLocal.y * 28.0 + terrain * 8.0) * 0.14;
  vec3 land = uColor * (0.65 + terrain * 0.8 + bands);
  if (uSeed > 1.9 && uSeed < 2.1) {
    land = mix(vec3(0.03, 0.16, 0.32), vec3(0.24, 0.42, 0.27), smoothstep(0.43, 0.57, terrain));
    land = mix(land, vec3(0.8, 0.87, 0.92), smoothstep(0.72, 0.82, abs(vLocal.y)));
    float clouds = smoothstep(0.65, 0.8, fbm(vLocal * 24.0));
    land = mix(land, vec3(0.9), clouds * 0.45);
  }
  float lighting = 0.16 + max(0.0, dot(normalize(vNormal), normalize(vec3(-0.4, 0.5, 1.0)))) * 0.9;
  gl_FragColor = vec4(land * lighting, uOpacity);
}
`;

export const starVertexShader = `
uniform float uTime;
uniform float uGravity;
uniform float uPixelRatio;
attribute float aSeed;
attribute float aSize;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec3 p = position;
  float phase = fract(aSeed + uTime * (0.035 + aSeed * 0.012));
  float orbit = aSeed * 45.0 + phase * 4.7;
  float r = 13.0 * pow(1.0 - phase, 1.5) + 0.75;
  vec3 captured = vec3(cos(orbit) * r, sin(orbit) * r * 0.75 + 0.2, mix(-15.0, -0.2, phase));
  p = mix(p, captured, uGravity * step(0.28, aSeed));
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(aSize * uPixelRatio * 13.0 / max(2.0, -mvPosition.z), 0.7, 3.0);
  vAlpha = (0.25 + 0.55 * aSeed) * (0.85 + 0.15 * sin(uTime * 0.4 + aSeed * 100.0));
  vAlpha *= mix(1.0, smoothstep(0.0, 0.07, phase) * (1.0-smoothstep(0.84,1.0,phase)), uGravity);
  vColor = mix(vec3(0.56,0.7,0.9), vec3(1.0,0.86,0.7), aSeed);
}
`;

export const starFragmentShader = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float core = exp(-dot(p,p) * 24.0);
  gl_FragColor = vec4(vColor, core * vAlpha);
}
`;

export const pointerLensFragmentShader = `
uniform vec2 uTrail[6];
uniform float uStrength;
uniform float uAspect;
void mainUv(inout vec2 uv) {
  vec2 offset = vec2(0.0);
  for (int i = 0; i < 5; i++) {
    vec2 a = uTrail[i];
    vec2 b = uTrail[i+1];
    vec2 line = b-a;
    float t = clamp(dot(uv-a,line) / max(dot(line,line),0.00001),0.0,1.0);
    vec2 centre = a + line*t;
    vec2 delta = uv-centre;
    float d = length(delta * vec2(uAspect,1.0));
    float falloff = exp(-d*d*110.0) * (1.0-float(i)/6.0);
    offset += delta * falloff * uStrength * 0.26;
  }
  uv += offset;
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
}
`;
