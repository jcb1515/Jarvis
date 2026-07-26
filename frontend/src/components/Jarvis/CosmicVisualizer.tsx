import { Stars } from '@react-three/drei';
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
  float radius = length(p) * 2.0;
  if (radius > 1.0 || radius < 0.16) discard;
  float angle = atan(p.y, p.x);
  float spiral = sin(angle * 7.0 - uTime * 1.6 - radius * 19.0);
  float filaments = noise(vec2(angle * 2.2 + uTime * 0.28, radius * 12.0));
  float heat = smoothstep(1.0, 0.18, radius);
  float structure = smoothstep(-0.55, 0.9, spiral + filaments * 1.25);
  vec3 outerColor = vec3(0.08, 0.28, 0.58);
  vec3 middleColor = vec3(0.95, 0.28, 0.07);
  vec3 coreColor = vec3(1.0, 0.9, 0.58);
  vec3 color = mix(outerColor, middleColor, heat);
  color = mix(color, coreColor, pow(heat, 4.0) * structure);
  color *= 0.45 + structure * 1.3 + uEnergy * 1.4;
  float edge = smoothstep(1.0, 0.76, radius) * smoothstep(0.16, 0.24, radius);
  float alpha = edge * (0.22 + structure * 0.78);
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
  color = mix(color, whiteHot, pow(hot, 4.0) + uEnergy * 0.22);
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
  float pulse = 0.72 + sin(uTime * 1.7) * 0.08 + uEnergy * 0.45;
  vec3 color = mix(vec3(1.0, 0.12, 0.01), vec3(1.0, 0.68, 0.16), fresnel);
  gl_FragColor = vec4(color * pulse, fresnel * 0.48);
}
`;

const getAudioEnergy = (frequencyData: Uint8Array | null): number => {
  if (!frequencyData || frequencyData.length === 0) return 0;
  const usefulBins = Math.max(1, Math.floor(frequencyData.length * 0.68));
  let total = 0;
  for (let index = 0; index < usefulBins; index += 1) {
    total += frequencyData[index];
  }
  return total / usefulBins / 255;
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
  const uniforms = useMemo(createUniforms, []);
  const smoothedEnergyRef = useRef(0);

  useFrame(({ clock }, delta) => {
    const frequencyEnergy =
      stage === 'SPEAKING' ? getAudioEnergy(getFrequencyData()) : 0;
    smoothedEnergyRef.current +=
      (frequencyEnergy - smoothedEnergyRef.current) * 0.2;
    const energy = smoothedEnergyRef.current;
    const thinkingMultiplier = stage === 'THINKING' ? 3.2 : 1;
    uniforms.uTime.value +=
      delta * thinkingMultiplier * (reducedMotion ? 0.2 : 1);
    uniforms.uEnergy.value = energy;
    if (diskRef.current) {
      diskRef.current.rotation.z +=
        delta * 0.07 * thinkingMultiplier * (reducedMotion ? 0 : 1);
    }
    if (groupRef.current) {
      groupRef.current.rotation.y =
        Math.sin(clock.elapsedTime * 0.13) * (reducedMotion ? 0 : 0.08);
    }
    [upperJetRef.current, lowerJetRef.current].forEach((jet) => {
      if (!jet) return;
      jet.scale.y = 0.18 + energy * 2.8;
      const material = jet.material as THREE.MeshBasicMaterial;
      material.opacity = stage === 'SPEAKING' ? 0.12 + energy * 0.78 : 0.03;
    });
  });

  return (
    <group ref={groupRef} visible={visible} position={[0, 0.18, 0]}>
      <mesh ref={diskRef} rotation={[1.08, 0.08, 0]}>
        <planeGeometry args={[6.8, 6.8, 1, 1]} />
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
      <mesh scale={0.78}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshBasicMaterial color="#000006" />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} scale={1.07}>
        <torusGeometry args={[0.92, 0.035, 12, 160]} />
        <meshBasicMaterial
          blending={THREE.AdditiveBlending}
          color="#e7f4ff"
          transparent
          opacity={0.88}
        />
      </mesh>
      <mesh ref={upperJetRef} position={[0, 2.15, -0.2]}>
        <coneGeometry args={[0.22, 2.3, 24, 1, true]} />
        <meshBasicMaterial
          blending={THREE.AdditiveBlending}
          color="#7ad9ff"
          depthWrite={false}
          opacity={0.03}
          side={THREE.DoubleSide}
          transparent
        />
      </mesh>
      <mesh
        ref={lowerJetRef}
        position={[0, -2.15, -0.2]}
        rotation={[0, 0, Math.PI]}
      >
        <coneGeometry args={[0.22, 2.3, 24, 1, true]} />
        <meshBasicMaterial
          blending={THREE.AdditiveBlending}
          color="#557dff"
          depthWrite={false}
          opacity={0.03}
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
  const smoothedEnergyRef = useRef(0);

  useFrame(({ clock }, delta) => {
    const frequencyEnergy =
      stage === 'SPEAKING' ? getAudioEnergy(getFrequencyData()) : 0;
    smoothedEnergyRef.current +=
      (frequencyEnergy - smoothedEnergyRef.current) * 0.18;
    const energy = smoothedEnergyRef.current;
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
      const scale = 1.32 + energy * 0.14;
      coronaRef.current.scale.setScalar(scale);
    }
    orbitRefs.current.forEach((orbit, index) => {
      if (!orbit) return;
      orbit.rotation.z +=
        delta *
        PLANETS[index].speed *
        thinkingMultiplier *
        motionMultiplier;
    });
    flareRefs.current.forEach((flare, index) => {
      if (!flare) return;
      const phase = Math.sin(clock.elapsedTime * 2.3 + index * 1.7) * 0.08;
      flare.scale.setScalar(
        stage === 'SPEAKING' ? 0.82 + energy * 1.5 + phase : 0.55,
      );
      const material = flare.material as THREE.MeshBasicMaterial;
      material.opacity = stage === 'SPEAKING' ? 0.16 + energy * 0.72 : 0.04;
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
            <meshBasicMaterial
              color="#315779"
              transparent
              opacity={0.34}
            />
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
            opacity={0.04}
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
  return (
    <>
      <color attach="background" args={['#01030a']} />
      <fog attach="fog" args={['#01030a', 10, 32]} />
      <Stars
        count={2200}
        depth={52}
        fade
        factor={2.6}
        radius={36}
        saturation={0.32}
        speed={reducedMotion ? 0 : stage === 'THINKING' ? 0.85 : 0.24}
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
          intensity={1.45}
          luminanceThreshold={0.18}
          luminanceSmoothing={0.7}
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
