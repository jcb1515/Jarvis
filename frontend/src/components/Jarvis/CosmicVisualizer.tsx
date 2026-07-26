import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

export type JarvisStage =
  | 'READY'
  | 'HEARING'
  | 'THINKING'
  | 'RESPONDING'
  | 'SPEAKING'
  | 'ERROR';

export type CosmicMode = 'BLACK_HOLE' | 'SOLAR_SYSTEM';

interface VisualizerProps {
  getFrequencyData: () => Uint8Array | null;
  mode: CosmicMode;
  stage: JarvisStage;
}

interface CelestialProps {
  getFrequencyData: () => Uint8Array | null;
  reducedMotion: boolean;
  stage: JarvisStage;
  visible: boolean;
}

interface ShaderUniforms {
  [uniform: string]: THREE.IUniform<number>;
  uEnergy: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
}

interface StarLayerProps {
  count: number;
  depth: number;
  drift: number;
  pointSize: number;
  radius: number;
  reducedMotion: boolean;
  seed: number;
}

const vertexShader = `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const accretionFragmentShader = `
uniform float uTime;
uniform float uEnergy;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec2 p = vUv - 0.5;
  vec2 diskPoint = vec2(p.x, p.y * 4.7);
  float radius = length(diskPoint) * 2.0;
  if (radius > 1.0 || radius < 0.17) discard;

  float angle = atan(diskPoint.y, diskPoint.x);
  float bands = sin(radius * 78.0 - angle * 5.0 + uTime * 0.72);
  float filaments = noise(vec2(angle * 4.0 - uTime * 0.18, radius * 36.0));
  float structure = smoothstep(-0.72, 0.9, bands * 0.44 + filaments);
  float innerHeat = pow(1.0 - smoothstep(0.17, 1.0, radius), 1.55);

  float beamingDirection = -0.72 + sin(uTime * 0.16) * 0.16;
  float facing = 0.5 + 0.5 * cos(angle - beamingDirection);
  float beaming = mix(0.12, 2.45, pow(facing, 2.6));
  float turbulentBeaming = beaming * mix(0.62, 1.22, structure);

  vec3 deepRed = vec3(0.42, 0.015, 0.002);
  vec3 orange = vec3(1.0, 0.19, 0.015);
  vec3 warmWhite = vec3(1.0, 0.89, 0.59);
  vec3 color = mix(deepRed, orange, smoothstep(0.02, 0.72, innerHeat));
  color = mix(color, warmWhite, pow(innerHeat, 3.4) * (0.48 + structure * 0.52));
  color *= turbulentBeaming * (0.72 + uEnergy * 1.8);

  float outerFade = smoothstep(1.0, 0.78, radius);
  float innerFade = smoothstep(0.17, 0.22, radius);
  float verticalFade = smoothstep(0.11, 0.025, abs(p.y));
  float alpha = outerFade * innerFade * verticalFade;
  gl_FragColor = vec4(color, alpha);
}
`;

const lensingFragmentShader = `
uniform float uTime;
uniform float uEnergy;
varying vec2 vUv;

void main() {
  vec2 p = vUv - 0.5;
  vec2 lensPoint = vec2(p.x, p.y * 1.18);
  float radius = length(lensPoint);
  float ring = exp(-pow(abs(radius - 0.205) * 42.0, 1.35));
  float polar = abs(p.y) / max(radius, 0.001);
  float verticalArc = smoothstep(0.23, 0.67, polar);
  float angle = atan(lensPoint.y, lensPoint.x);
  float beaming = mix(0.18, 1.85, pow(0.5 + 0.5 * cos(angle + 0.7), 2.3));
  float shimmer = 0.78 + sin(angle * 9.0 - uTime * 1.35) * 0.14;
  shimmer += sin(angle * 3.0 - uTime * 0.72) * 0.08;
  float heat = smoothstep(0.0, 0.8, beaming);
  vec3 color = mix(vec3(0.8, 0.045, 0.003), vec3(1.0, 0.72, 0.3), heat);
  float alpha = ring * verticalArc * beaming * shimmer * (0.5 + uEnergy * 0.9);
  if (alpha < 0.008) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

const sunFragmentShader = `
uniform float uTime;
uniform float uEnergy;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vPosition;

float plasma(vec3 p) {
  float value = 0.0;
  value += sin(p.x * 9.0 + uTime * 1.2);
  value += sin(p.y * 13.0 - uTime * 0.8);
  value += sin((p.x + p.z) * 18.0 + uTime * 1.6);
  value += sin(length(p.xy) * 24.0 - uTime * 2.0);
  return value * 0.25;
}

void main() {
  float turbulence = plasma(normalize(vPosition));
  float facing = clamp(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
  float limb = pow(1.0 - facing, 2.2);
  float hot = smoothstep(-0.6, 0.9, turbulence);
  vec3 ember = vec3(0.92, 0.12, 0.015);
  vec3 gold = vec3(1.0, 0.58, 0.04);
  vec3 whiteHot = vec3(1.0, 0.94, 0.62);
  vec3 color = mix(ember, gold, hot);
  color = mix(color, whiteHot, pow(hot, 4.0) + uEnergy * 0.35);
  color += vec3(1.0, 0.18, 0.02) * limb * 1.4;
  gl_FragColor = vec4(color, 1.0);
}
`;

const coronaFragmentShader = `
uniform float uTime;
uniform float uEnergy;
varying vec3 vNormal;

void main() {
  float fresnel = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 2.4);
  float pulse = 0.68 + sin(uTime * 1.7) * 0.06 + uEnergy * 0.78;
  vec3 color = mix(vec3(1.0, 0.12, 0.01), vec3(1.0, 0.68, 0.16), fresnel);
  gl_FragColor = vec4(color * pulse, fresnel * (0.38 + uEnergy * 0.42));
}
`;

const seededRandom = (state: number): [number, number] => {
  const next = (state * 1664525 + 1013904223) >>> 0;
  return [next / 4294967296, next];
};

const createStarGeometry = (
  count: number,
  radius: number,
  depth: number,
  seed: number,
): THREE.BufferGeometry => {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = [
    new THREE.Color('#fffdf7'),
    new THREE.Color('#f1f4ff'),
    new THREE.Color('#fff0d6'),
    new THREE.Color('#dfe8ff'),
  ];
  let randomState = seed;
  for (let index = 0; index < count; index += 1) {
    let randomValue = 0;
    [randomValue, randomState] = seededRandom(randomState);
    positions[index * 3] = (randomValue * 2 - 1) * radius;
    [randomValue, randomState] = seededRandom(randomState);
    positions[index * 3 + 1] = (randomValue * 2 - 1) * radius * 0.5;
    [randomValue, randomState] = seededRandom(randomState);
    positions[index * 3 + 2] = -2 - randomValue * depth;
    [randomValue, randomState] = seededRandom(randomState);
    const color = palette[Math.floor(randomValue * palette.length)];
    [randomValue, randomState] = seededRandom(randomState);
    const intensity = 0.32 + Math.pow(randomValue, 2.4) * 0.68;
    colors[index * 3] = color.r * intensity;
    colors[index * 3 + 1] = color.g * intensity;
    colors[index * 3 + 2] = color.b * intensity;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
};

function StarLayer({
  count,
  depth,
  drift,
  pointSize,
  radius,
  reducedMotion,
  seed,
}: StarLayerProps) {
  const groupRef = useRef<THREE.Group>(null);
  const geometry = useMemo(
    () => createStarGeometry(count, radius, depth, seed),
    [count, depth, radius, seed],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.position.x = reducedMotion
      ? 0
      : -((clock.elapsedTime * drift) % (radius * 2));
  });
  return (
    <group ref={groupRef}>
      {[0, radius * 2].map((offset) => (
        <points geometry={geometry} key={offset} position={[offset, 0, 0]}>
          <pointsMaterial
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            opacity={0.82}
            size={pointSize}
            sizeAttenuation
            transparent
            vertexColors
          />
        </points>
      ))}
    </group>
  );
}

const getAudioLevel = (frequencyData: Uint8Array | null): number => {
  if (!frequencyData || frequencyData.length === 0) return 0;
  const usefulBins = Math.max(1, Math.floor(frequencyData.length * 0.48));
  let total = 0;
  let peak = 0;
  for (let index = 0; index < usefulBins; index += 1) {
    const value = frequencyData[index] / 255;
    total += value * value;
    peak = Math.max(peak, value);
  }
  const rootMeanSquare = Math.sqrt(total / usefulBins);
  const combined = Math.max(rootMeanSquare * 1.55, peak * 0.78);
  const normalized = THREE.MathUtils.clamp((combined - 0.018) / 0.42, 0, 1);
  return Math.pow(normalized, 0.68);
};

const updateEnvelope = (current: number, target: number): number => {
  const speed = target > current ? 0.58 : 0.105;
  return current + (target - current) * speed;
};

const createUniforms = (): ShaderUniforms => ({
  uEnergy: { value: 0 },
  uTime: { value: 0 },
});

function BlackHole({
  getFrequencyData,
  reducedMotion,
  stage,
  visible,
}: CelestialProps) {
  const groupRef = useRef<THREE.Group>(null);
  const diskRef = useRef<THREE.Mesh>(null);
  const upperJetRef = useRef<THREE.Mesh>(null);
  const lowerJetRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const uniforms = useMemo(createUniforms, []);
  const energyRef = useRef(0);
  const previousRawRef = useRef(0);
  const rotationSpeedRef = useRef(0.2);

  useFrame(({ clock }, delta) => {
    const raw = stage === 'SPEAKING' ? getAudioLevel(getFrequencyData()) : 0;
    energyRef.current = updateEnvelope(energyRef.current, raw);
    const transient = Math.max(0, raw - previousRawRef.current) * 1.8;
    previousRawRef.current = raw;
    const energy = THREE.MathUtils.clamp(energyRef.current + transient, 0, 1);
    const targetRotationSpeed = stage === 'THINKING' ? 0.7 : 0.2;
    rotationSpeedRef.current = THREE.MathUtils.damp(
      rotationSpeedRef.current,
      targetRotationSpeed,
      2.2,
      delta,
    );
    const animationMultiplier = rotationSpeedRef.current / 0.2;
    uniforms.uTime.value +=
      delta * animationMultiplier * (reducedMotion ? 0.18 : 1);
    uniforms.uEnergy.value = energy;
    if (diskRef.current && !reducedMotion) {
      diskRef.current.rotation.z += delta * rotationSpeedRef.current;
    }
    if (groupRef.current) {
      groupRef.current.rotation.y =
        Math.sin(clock.elapsedTime * 0.12) * (reducedMotion ? 0 : 0.055);
    }
    if (haloRef.current) {
      haloRef.current.scale.setScalar(1 + energy * 0.18);
      const material = haloRef.current.material as THREE.MeshBasicMaterial;
      material.opacity = 0.05 + energy * 0.38;
    }
    [upperJetRef.current, lowerJetRef.current].forEach((jet) => {
      if (!jet) return;
      jet.scale.x = 0.72 + energy * 1.45;
      jet.scale.y = 0.08 + Math.pow(energy, 0.72) * 5.8;
      jet.scale.z = 0.72 + energy * 1.45;
      const material = jet.material as THREE.MeshBasicMaterial;
      material.opacity = stage === 'SPEAKING' ? 0.025 + energy * 0.92 : 0.012;
    });
  });

  return (
    <group ref={groupRef} visible={visible} position={[0, 0.2, 0]}>
      <mesh position={[0, 0, -0.35]} scale={[1.28, 1, 1]}>
        <planeGeometry args={[6.8, 6.8]} />
        <shaderMaterial
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          fragmentShader={lensingFragmentShader}
          side={THREE.DoubleSide}
          transparent
          uniforms={uniforms}
          vertexShader={vertexShader}
        />
      </mesh>
      <mesh ref={diskRef} position={[0, -0.04, -0.08]} rotation={[0, 0, -0.025]}>
        <planeGeometry args={[7.2, 4.8]} />
        <shaderMaterial
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          fragmentShader={accretionFragmentShader}
          side={THREE.DoubleSide}
          transparent
          uniforms={uniforms}
          vertexShader={vertexShader}
        />
      </mesh>
      <mesh position={[0, 0, 0.18]} scale={[0.88, 0.88, 0.5]}>
        <sphereGeometry args={[1, 72, 72]} />
        <meshBasicMaterial color="#000000" />
      </mesh>
      <mesh position={[0, 0, 0.32]} scale={[1.28, 1, 1]}>
        <planeGeometry args={[6.8, 6.8]} />
        <shaderMaterial
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          fragmentShader={lensingFragmentShader}
          side={THREE.DoubleSide}
          transparent
          uniforms={uniforms}
          vertexShader={vertexShader}
        />
      </mesh>
      <mesh ref={haloRef} position={[0, 0, 0.34]}>
        <ringGeometry args={[0.9, 1.01, 128]} />
        <meshBasicMaterial
          blending={THREE.AdditiveBlending}
          color="#ffb15c"
          depthWrite={false}
          opacity={0.05}
          transparent
        />
      </mesh>
      <mesh ref={upperJetRef} position={[0, 1.42, -0.48]}>
        <coneGeometry args={[0.19, 2.7, 32, 1, true]} />
        <meshBasicMaterial
          blending={THREE.AdditiveBlending}
          color="#fff1cd"
          depthWrite={false}
          opacity={0.012}
          side={THREE.DoubleSide}
          transparent
        />
      </mesh>
      <mesh
        ref={lowerJetRef}
        position={[0, -1.42, -0.48]}
        rotation={[0, 0, Math.PI]}
      >
        <coneGeometry args={[0.19, 2.7, 32, 1, true]} />
        <meshBasicMaterial
          blending={THREE.AdditiveBlending}
          color="#ff6a1a"
          depthWrite={false}
          opacity={0.012}
          side={THREE.DoubleSide}
          transparent
        />
      </mesh>
    </group>
  );
}

const PLANETS = [
  { color: '#b6a08c', distance: 2.25, radius: 0.1, speed: 1.05 },
  { color: '#d7a264', distance: 2.72, radius: 0.15, speed: 0.78 },
  { color: '#5d9fcf', distance: 3.25, radius: 0.17, speed: 0.58 },
  { color: '#b55d42', distance: 3.78, radius: 0.12, speed: 0.46 },
] as const;

function SolarSystem({
  getFrequencyData,
  reducedMotion,
  stage,
  visible,
}: CelestialProps) {
  const sunRef = useRef<THREE.Mesh>(null);
  const coronaRef = useRef<THREE.Mesh>(null);
  const orbitRefs = useRef<Array<THREE.Group | null>>([]);
  const flareRefs = useRef<Array<THREE.Mesh | null>>([]);
  const sunUniforms = useMemo(createUniforms, []);
  const coronaUniforms = useMemo(createUniforms, []);
  const energyRef = useRef(0);
  const previousRawRef = useRef(0);

  useFrame((_state, delta) => {
    const raw = stage === 'SPEAKING' ? getAudioLevel(getFrequencyData()) : 0;
    energyRef.current = updateEnvelope(energyRef.current, raw);
    const transient = Math.max(0, raw - previousRawRef.current) * 1.65;
    previousRawRef.current = raw;
    const energy = THREE.MathUtils.clamp(energyRef.current + transient, 0, 1);
    const thinkingMultiplier = stage === 'THINKING' ? 3.4 : 1;
    const motionMultiplier = reducedMotion ? 0.08 : 1;
    sunUniforms.uTime.value += delta * thinkingMultiplier * motionMultiplier;
    sunUniforms.uEnergy.value = energy;
    coronaUniforms.uTime.value += delta * motionMultiplier;
    coronaUniforms.uEnergy.value = energy;
    if (sunRef.current) {
      sunRef.current.rotation.y += delta * 0.08 * thinkingMultiplier;
    }
    if (coronaRef.current) {
      coronaRef.current.scale.setScalar(1.3 + energy * 0.38);
    }
    orbitRefs.current.forEach((orbit, index) => {
      if (!orbit) return;
      orbit.rotation.z +=
        delta *
        PLANETS[index].speed *
        thinkingMultiplier *
        motionMultiplier;
    });
    flareRefs.current.forEach((flare) => {
      if (!flare) return;
      flare.scale.setScalar(
        stage === 'SPEAKING' ? 0.18 + Math.pow(energy, 0.68) * 3.9 : 0.18,
      );
      const material = flare.material as THREE.MeshBasicMaterial;
      material.opacity = stage === 'SPEAKING' ? 0.025 + energy * 0.94 : 0.018;
    });
  });

  return (
    <group visible={visible} position={[0, 0.12, 0]} rotation={[0.96, 0, 0]}>
      <mesh ref={sunRef}>
        <sphereGeometry args={[1.16, 96, 96]} />
        <shaderMaterial
          fragmentShader={sunFragmentShader}
          uniforms={sunUniforms}
          vertexShader={vertexShader}
        />
      </mesh>
      <mesh ref={coronaRef}>
        <sphereGeometry args={[1, 72, 72]} />
        <shaderMaterial
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          fragmentShader={coronaFragmentShader}
          side={THREE.BackSide}
          transparent
          uniforms={coronaUniforms}
          vertexShader={vertexShader}
        />
      </mesh>
      {PLANETS.map((planet, index) => (
        <group
          key={planet.distance}
          ref={(group) => {
            orbitRefs.current[index] = group;
          }}
          rotation={[0, 0, index * 1.34]}
        >
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[planet.distance, 0.006, 6, 160]} />
            <meshBasicMaterial color="#8f8f8f" transparent opacity={0.22} />
          </mesh>
          <mesh position={[planet.distance, 0, 0]}>
            <sphereGeometry args={[planet.radius, 32, 32]} />
            <meshStandardMaterial
              color={planet.color}
              metalness={0.12}
              roughness={0.72}
            />
          </mesh>
        </group>
      ))}
      {[0, 1, 2].map((index) => (
        <mesh
          key={index}
          ref={(mesh) => {
            flareRefs.current[index] = mesh;
          }}
          position={[
            Math.cos(index * 2.1) * 0.88,
            Math.sin(index * 2.1) * 0.88,
            0.25,
          ]}
          rotation={[Math.PI / 2, index * 0.8, index * 1.9]}
        >
          <torusGeometry args={[0.42, 0.038, 12, 72, Math.PI * 1.3]} />
          <meshBasicMaterial
            blending={THREE.AdditiveBlending}
            color="#ff8c21"
            depthWrite={false}
            opacity={0.018}
            transparent
          />
        </mesh>
      ))}
      <pointLight color="#ff8a39" decay={2} distance={14} intensity={80} />
    </group>
  );
}

const useReducedMotion = (): boolean => {
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reducedMotion;
};

function Scene({ getFrequencyData, mode, stage }: VisualizerProps) {
  const reducedMotion = useReducedMotion();
  const thinkingSpeed = stage === 'THINKING' ? 1.5 : 1;
  return (
    <>
      <color attach="background" args={['#000000']} />
      <fog attach="fog" args={['#000000', 14, 42]} />
      <StarLayer
        count={1550}
        depth={46}
        drift={0.12 * thinkingSpeed}
        pointSize={0.028}
        radius={42}
        reducedMotion={reducedMotion}
        seed={173}
      />
      <StarLayer
        count={720}
        depth={28}
        drift={0.22 * thinkingSpeed}
        pointSize={0.052}
        radius={42}
        reducedMotion={reducedMotion}
        seed={941}
      />
      <StarLayer
        count={170}
        depth={16}
        drift={0.36 * thinkingSpeed}
        pointSize={0.092}
        radius={42}
        reducedMotion={reducedMotion}
        seed={2026}
      />
      <ambientLight intensity={0.08} />
      <BlackHole
        getFrequencyData={getFrequencyData}
        reducedMotion={reducedMotion}
        stage={stage}
        visible={mode === 'BLACK_HOLE'}
      />
      <SolarSystem
        getFrequencyData={getFrequencyData}
        reducedMotion={reducedMotion}
        stage={stage}
        visible={mode === 'SOLAR_SYSTEM'}
      />
      <EffectComposer multisampling={0}>
        <Bloom
          intensity={1.55}
          luminanceThreshold={0.14}
          luminanceSmoothing={0.72}
          mipmapBlur
        />
      </EffectComposer>
    </>
  );
}

export function CosmicVisualizer({
  getFrequencyData,
  mode,
  stage,
}: VisualizerProps) {
  return (
    <div
      aria-label={`JARVIS ${
        mode === 'BLACK_HOLE' ? 'black hole' : 'solar system'
      } audio visualizer`}
      className="jarvis-cosmos"
      role="img"
    >
      <Canvas
        camera={{ fov: 46, position: [0, 0, 9] }}
        dpr={[1, 1.5]}
        gl={{
          alpha: false,
          antialias: true,
          powerPreference: 'high-performance',
        }}
      >
        <Scene
          getFrequencyData={getFrequencyData}
          mode={mode}
          stage={stage}
        />
      </Canvas>
    </div>
  );
}
