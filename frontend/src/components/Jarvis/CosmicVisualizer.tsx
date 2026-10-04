import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, OrbitControls } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import { Component, memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode, RefObject } from 'react';
import type { OrbitControls as OrbitControlsInstance } from 'three-stdlib';
import * as THREE from 'three';
import {
  atmosphereFragmentShader,
  cosmicVertexShader,
  diskFragmentShader,
  lensFragmentShader,
  planetFragmentShader,
  pointerLensFragmentShader,
  starFragmentShader,
  starVertexShader,
  sunFragmentShader,
} from './cosmic-shaders';

export type JarvisStage = 'READY' | 'HEARING' | 'THINKING' | 'RESPONDING' | 'SPEAKING' | 'ERROR';
export type CosmicMode = 'BLACK_HOLE' | 'SOLAR_SYSTEM';
export type SceneQuality = 'balanced' | 'high';
export type ViewCommand = 'reset' | 'left' | 'right' | 'up' | 'down';

export interface ViewRequest {
  command: ViewCommand;
  revision: number;
}

interface VisualizerProps {
  getFrequencyData: () => Uint8Array | null;
  getMicData: () => Uint8Array | null;
  mode: CosmicMode;
  quality: SceneQuality;
  stage: JarvisStage;
  viewRequest: ViewRequest;
}

type UniformName = 'uTime' | 'uEnergy' | 'uThinking' | 'uHearing' | 'uSpeaking' | 'uError' | 'uOpacity';
type CelestialUniforms = Record<UniformName, THREE.Uniform<number>>;
type ShaderUniformSource = Readonly<Record<string, THREE.Uniform<number> | THREE.Uniform<THREE.Color>>>;

/** R3F copies uniform containers; update the renderer-owned values explicitly. */
const useMaterialUniforms = (source: ShaderUniformSource): RefObject<THREE.ShaderMaterial | null> => {
  const material = useRef<THREE.ShaderMaterial>(null);
  const entries = useMemo(() => Object.entries(source), [source]);
  useFrame(() => {
    if (!material.current) return;
    for (const [name, uniform] of entries) {
      const target = material.current.uniforms[name];
      if (!target) throw new Error(`Observatory shader is missing its declared uniform: ${name}`);
      if (typeof uniform.value === 'number') target.value = uniform.value;
      else if (target.value === uniform.value) target.value = uniform.value.clone();
      else (target.value as THREE.Color).copy(uniform.value);
    }
  });
  return material;
};

interface SceneLook {
  flow: number;
  thinking: number;
  hearing: number;
  speaking: number;
  error: number;
}

const STATE_LOOK: Record<JarvisStage, SceneLook> = {
  READY: { flow: 0.2, thinking: 0, hearing: 0, speaking: 0, error: 0 },
  HEARING: { flow: 0.2, thinking: 0, hearing: 1, speaking: 0, error: 0 },
  THINKING: { flow: 0.7, thinking: 1, hearing: 0, speaking: 0, error: 0 },
  RESPONDING: { flow: 0.7, thinking: 1, hearing: 0, speaking: 0, error: 0 },
  SPEAKING: { flow: 0.2, thinking: 0, hearing: 0, speaking: 1, error: 0 },
  ERROR: { flow: 0.12, thinking: 0, hearing: 0, speaking: 0, error: 1 },
};

const createUniforms = (opacity: number): CelestialUniforms => ({
  uTime: new THREE.Uniform(0),
  uEnergy: new THREE.Uniform(0),
  uThinking: new THREE.Uniform(0),
  uHearing: new THREE.Uniform(0),
  uSpeaking: new THREE.Uniform(0),
  uError: new THREE.Uniform(0),
  uOpacity: new THREE.Uniform(opacity),
});

const audioEnergy = (data: Uint8Array | null): number => {
  if (!data || data.length === 0) return 0;
  const count = Math.max(1, Math.floor(data.length * 0.48));
  let sum = 0;
  for (let index = 0; index < count; index += 1) sum += (data[index] / 255) ** 2;
  return Math.min(1, Math.sqrt(sum / count) * 2.4);
};

const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
};

interface BodyProps {
  uniforms: CelestialUniforms;
}

function BlackHole({ uniforms }: BodyProps) {
  const upperMaterial = useMaterialUniforms(uniforms);
  const lowerMaterial = useMaterialUniforms(uniforms);
  const lensMaterial = useMaterialUniforms(uniforms);
  const lens = useRef<THREE.Mesh>(null);
  const disk = useRef<THREE.Group>(null);
  const assembly = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    if (lens.current) lens.current.quaternion.copy(camera.quaternion);
    if (disk.current) disk.current.rotation.z = -0.13 + uniforms.uTime.value * 0.015;
    if (assembly.current) {
      assembly.current.visible = uniforms.uOpacity.value > 0.005;
      assembly.current.scale.setScalar(0.96 + uniforms.uOpacity.value * 0.04);
    }
  });
  return (
    <group ref={assembly}>
      <group ref={disk} rotation={[1.12, -0.08, -0.13]}>
        {[0, -0.022].map((height) => (
          <mesh key={height} position={[0, 0, height]}>
            <ringGeometry args={[1.16, 3.78, 192, 10]} />
            <shaderMaterial
              ref={height === 0 ? upperMaterial : lowerMaterial}
              vertexShader={cosmicVertexShader}
              fragmentShader={diskFragmentShader}
              uniforms={uniforms}
              transparent
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>
      <mesh>
        <sphereGeometry args={[1.05, 96, 64]} />
        <meshBasicMaterial color="#010204" toneMapped={false} />
      </mesh>
      <mesh ref={lens} renderOrder={2}>
        <planeGeometry args={[3.5, 3.5]} />
        <shaderMaterial
          ref={lensMaterial}
          vertexShader={cosmicVertexShader}
          fragmentShader={lensFragmentShader}
          uniforms={uniforms}
          transparent
          depthTest={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

interface PlanetDefinition {
  color: string;
  distance: number;
  radius: number;
  speed: number;
  seed: number;
}

const PLANETS: readonly PlanetDefinition[] = [
  { color: '#aaa398', distance: 1.62, radius: 0.075, speed: 0.95, seed: 0 },
  { color: '#cdb28f', distance: 2.03, radius: 0.13, speed: 0.7, seed: 1 },
  { color: '#71a2bc', distance: 2.55, radius: 0.16, speed: 0.52, seed: 2 },
  { color: '#b36746', distance: 3.06, radius: 0.11, speed: 0.43, seed: 3 },
  { color: '#c79c72', distance: 3.74, radius: 0.3, speed: 0.28, seed: 4 },
  { color: '#c6b88c', distance: 4.57, radius: 0.23, speed: 0.19, seed: 5 },
];

interface PlanetProps extends BodyProps {
  planet: PlanetDefinition;
}

function Planet({ planet, uniforms }: PlanetProps) {
  const orbit = useRef<THREE.Group>(null);
  const body = useRef<THREE.Mesh>(null);
  const material = useMemo(() => ({
    uColor: new THREE.Uniform(new THREE.Color(planet.color)),
    uSeed: new THREE.Uniform(planet.seed),
    uOpacity: uniforms.uOpacity,
  }), [planet, uniforms]);
  const materialRef = useMaterialUniforms(material);
  const atmosphere = useMemo(() => ({ uColor: new THREE.Uniform(new THREE.Color('#4ba6d7')), uOpacity: uniforms.uOpacity }), [uniforms]);
  const atmosphereRef = useMaterialUniforms(atmosphere);
  useFrame(() => {
    if (orbit.current) orbit.current.rotation.z = planet.seed * 1.21 + uniforms.uTime.value * planet.speed;
    if (body.current) body.current.rotation.y = uniforms.uTime.value * 0.16;
  });
  return (
    <group>
      <mesh>
        <ringGeometry args={[planet.distance - 0.0025, planet.distance + 0.0025, 192]} />
        <meshBasicMaterial color="#8da2b8" opacity={0.16} transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <group ref={orbit}>
        <group position={[planet.distance, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh ref={body} scale={planet.radius}>
            <sphereGeometry args={[1, 40, 32]} />
            <shaderMaterial ref={materialRef} vertexShader={cosmicVertexShader} fragmentShader={planetFragmentShader} uniforms={material} transparent />
          </mesh>
          {planet.seed === 2 && (
            <mesh scale={planet.radius * 1.09}>
              <sphereGeometry args={[1, 32, 24]} />
              <shaderMaterial
                ref={atmosphereRef}
                vertexShader={cosmicVertexShader}
                fragmentShader={atmosphereFragmentShader}
                uniforms={atmosphere}
                blending={THREE.AdditiveBlending}
                transparent
                depthWrite={false}
              />
            </mesh>
          )}
          {planet.seed === 5 && (
            <mesh rotation={[1.1, 0.3, 0]}>
              <ringGeometry args={[planet.radius * 1.4, planet.radius * 2.3, 96]} />
              <meshStandardMaterial color="#c0ac87" opacity={0.6} transparent side={THREE.DoubleSide} roughness={0.75} />
            </mesh>
          )}
        </group>
      </group>
    </group>
  );
}

function SolarSystem({ uniforms }: BodyProps) {
  const assembly = useRef<THREE.Group>(null);
  const corona = useRef<THREE.Mesh>(null);
  const atmosphere = useMemo(() => ({
    uColor: new THREE.Uniform(new THREE.Color('#ff973c')),
    uOpacity: uniforms.uOpacity,
  }), [uniforms]);
  const sunMaterial = useMaterialUniforms(uniforms);
  const coronaMaterial = useMaterialUniforms(atmosphere);
  useFrame(() => {
    if (assembly.current) assembly.current.visible = uniforms.uOpacity.value > 0.005;
    if (corona.current) corona.current.scale.setScalar(1.2 + uniforms.uEnergy.value * 0.28);
  });
  return (
    <group ref={assembly}>
      <mesh>
        <sphereGeometry args={[0.77, 72, 48]} />
        <shaderMaterial ref={sunMaterial} vertexShader={cosmicVertexShader} fragmentShader={sunFragmentShader} uniforms={uniforms} transparent />
      </mesh>
      <mesh ref={corona}>
        <sphereGeometry args={[0.77, 48, 32]} />
        <shaderMaterial
          ref={coronaMaterial}
          vertexShader={cosmicVertexShader}
          fragmentShader={atmosphereFragmentShader}
          uniforms={atmosphere}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
        />
      </mesh>
      <group rotation={[1.0, 0.05, -0.35]}>
        {PLANETS.map((planet) => <Planet key={planet.seed} planet={planet} uniforms={uniforms} />)}
      </group>
      <pointLight color="#ffc788" intensity={8} distance={15} decay={2} />
    </group>
  );
}

function OrbitalSculpture({ uniforms }: BodyProps) {
  const ring = useRef<THREE.Group>(null);
  const material = useRef<THREE.MeshPhysicalMaterial>(null);
  useFrame(() => {
    if (ring.current) ring.current.rotation.y = 0.25 + uniforms.uTime.value * 0.04;
    if (material.current) material.current.opacity = uniforms.uOpacity.value * 0.55;
  });
  return (
    <group ref={ring} rotation={[0.42, 0.25, 0.16]}>
      <mesh rotation={[1.18, 0.1, 0]}>
        <torusGeometry args={[4.35, 0.012, 8, 256]} />
        <meshPhysicalMaterial ref={material} color="#adbcca" metalness={0.88} roughness={0.2} clearcoat={1} transparent opacity={0.55} />
      </mesh>
      <mesh rotation={[1.35, -0.28, -0.28]}>
        <torusGeometry args={[4.53, 0.004, 6, 256]} />
        <meshBasicMaterial color="#7d8a99" transparent opacity={0.16} />
      </mesh>
      <mesh position={[4.16, 0.7, -0.45]}>
        <sphereGeometry args={[0.047, 16, 16]} />
        <meshStandardMaterial color="#bfdbed" metalness={0.95} roughness={0.18} />
      </mesh>
    </group>
  );
}

const createStarGeometry = (count: number): THREE.BufferGeometry => {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  let seed = 1931;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (random() - 0.5) * 48;
    positions[index * 3 + 1] = (random() - 0.5) * 29;
    positions[index * 3 + 2] = -3 - random() * 28;
    seeds[index] = random();
    sizes[index] = 1 + random() * 2.8;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  return geometry;
};

interface StarProps {
  mode: CosmicMode;
  quality: SceneQuality;
  stage: JarvisStage;
  reducedMotion: boolean;
}

function Starfield({ mode, quality, stage, reducedMotion }: StarProps) {
  const geometry = useMemo(() => createStarGeometry(quality === 'high' ? 1900 : 1100), [quality]);
  const uniforms = useMemo(() => ({ uTime: new THREE.Uniform(0), uGravity: new THREE.Uniform(0), uPixelRatio: new THREE.Uniform(1) }), []);
  const material = useMaterialUniforms(uniforms);
  const speed = useRef(1);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(({ gl }, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const targetSpeed = stage === 'THINKING' || stage === 'RESPONDING' ? 2.4 : 1;
    speed.current = THREE.MathUtils.damp(speed.current, targetSpeed, 2.5, delta);
    uniforms.uTime.value += reducedMotion ? 0 : delta * speed.current;
    uniforms.uGravity.value = THREE.MathUtils.damp(uniforms.uGravity.value, mode === 'BLACK_HOLE' ? 1 : 0, 1.5, delta);
    uniforms.uPixelRatio.value = gl.getPixelRatio();
  });
  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={starVertexShader}
        fragmentShader={starFragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** Connector to the post-processing renderer; it never touches assistant state. */
class PointerLensEffect extends Effect {
  readonly strength: THREE.Uniform<number>;
  readonly aspect: THREE.Uniform<number>;
  constructor(trail: THREE.Vector2[]) {
    const strength = new THREE.Uniform(0);
    const aspect = new THREE.Uniform(1);
    const uniforms = new Map<string, THREE.Uniform<number> | THREE.Uniform<THREE.Vector2[]>>([
      ['uTrail', new THREE.Uniform(trail)], ['uStrength', strength], ['uAspect', aspect],
    ]);
    super('AstronoPointerLens', pointerLensFragmentShader, { uniforms });
    this.strength = strength;
    this.aspect = aspect;
  }
}

interface PointerLensProps {
  reducedMotion: boolean;
}

function PointerLens({ reducedMotion }: PointerLensProps) {
  const { gl, size } = useThree();
  const trail = useMemo(() => Array.from({ length: 6 }, () => new THREE.Vector2(0.5, 0.5)), []);
  const effect = useMemo(() => new PointerLensEffect(trail), [trail]);
  const pointer = useRef(new THREE.Vector2(0.5, 0.5));
  const pressure = useRef(0);
  useEffect(() => {
    const canvas = gl.domElement;
    const move = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const next = new THREE.Vector2((event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height);
      pressure.current = Math.min(1, next.distanceTo(pointer.current) * (event.buttons === 1 ? 18 : 3));
      pointer.current.copy(next);
    };
    canvas.addEventListener('pointermove', move);
    return () => canvas.removeEventListener('pointermove', move);
  }, [gl]);
  useEffect(() => () => effect.dispose(), [effect]);
  useFrame((_state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    effect.aspect.value = size.width / size.height;
    pressure.current *= Math.exp(-delta * 3.2);
    effect.strength.value = reducedMotion ? 0 : THREE.MathUtils.damp(effect.strength.value, pressure.current, 8, delta);
    for (let index = trail.length - 1; index > 0; index -= 1) trail[index].lerp(trail[index - 1], 1 - Math.exp(-delta * 12));
    trail[0].lerp(pointer.current, 1 - Math.exp(-delta * 16));
  });
  return <primitive object={effect} dispose={null} />;
}

interface CameraRigProps {
  mode: CosmicMode;
  reducedMotion: boolean;
  viewRequest: ViewRequest;
}

function CameraRig({ mode, reducedMotion, viewRequest }: CameraRigProps) {
  const controls = useRef<OrbitControlsInstance>(null);
  const { camera, size, gl } = useThree();
  const portrait = size.width < 740;
  const framing = useRef(false);
  const direction = useMemo(() => new THREE.Vector3(), []);
  const previousPortrait = useRef<boolean | null>(null);
  const distance = portrait ? (mode === 'SOLAR_SYSTEM' ? 25 : 20.3) : 11.4;
  const targetHeight = portrait ? 0.65 : 0.15;
  useEffect(() => {
    const current = controls.current;
    if (!current) return;
    if (previousPortrait.current !== portrait || reducedMotion) {
      camera.position.set(0, 1.1, distance);
      current.target.set(0, targetHeight, 0);
      current.update();
      current.saveState();
      framing.current = false;
    } else {
      framing.current = true;
    }
    previousPortrait.current = portrait;
  }, [camera, portrait, mode, reducedMotion, distance, targetHeight]);
  useFrame((_state, rawDelta) => {
    const current = controls.current;
    if (!current || !framing.current) return;
    const delta = Math.min(rawDelta, 0.05);
    direction.copy(camera.position).sub(current.target).normalize();
    const radius = THREE.MathUtils.damp(camera.position.distanceTo(current.target), distance, 4.2, delta);
    current.target.y = THREE.MathUtils.damp(current.target.y, targetHeight, 4.2, delta);
    camera.position.copy(current.target).addScaledVector(direction, radius);
    current.update();
    if (Math.abs(radius - distance) < 0.005 && Math.abs(current.target.y - targetHeight) < 0.005) {
      framing.current = false;
      current.saveState();
    }
  });
  useEffect(() => {
    const current = controls.current;
    if (!current) return;
    if (viewRequest.command === 'reset') current.reset();
    if (viewRequest.command === 'left') current.setAzimuthalAngle(current.getAzimuthalAngle() - 0.12);
    if (viewRequest.command === 'right') current.setAzimuthalAngle(current.getAzimuthalAngle() + 0.12);
    if (viewRequest.command === 'up') current.setPolarAngle(current.getPolarAngle() - 0.1);
    if (viewRequest.command === 'down') current.setPolarAngle(current.getPolarAngle() + 0.1);
    current.update();
  }, [viewRequest]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan={false}
      onStart={() => { framing.current = false; }}
      enableDamping={!reducedMotion}
      onChange={() => {
        const current = controls.current;
        if (!current) return;
        gl.domElement.dataset.viewAzimuth = current.getAzimuthalAngle().toFixed(4);
        gl.domElement.dataset.viewPolar = current.getPolarAngle().toFixed(4);
      }}
      dampingFactor={0.065}
      rotateSpeed={0.4}
      zoomSpeed={0.35}
      minDistance={portrait ? 15 : 8.3}
      maxDistance={portrait ? 30 : 15}
      minAzimuthAngle={-0.62}
      maxAzimuthAngle={0.62}
      minPolarAngle={1.12}
      maxPolarAngle={1.85}
    />
  );
}

function Scene({ getFrequencyData, getMicData, mode, quality, stage, viewRequest }: VisualizerProps) {
  const reducedMotion = useReducedMotion();
  const blackHole = useMemo(() => createUniforms(mode === 'BLACK_HOLE' ? 1 : 0), []);
  const solar = useMemo(() => createUniforms(mode === 'SOLAR_SYSTEM' ? 1 : 0), []);
  const flow = useRef(0.2);
  useFrame((_state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const look = STATE_LOOK[stage];
    const energy = audioEnergy(stage === 'HEARING' ? getMicData() : stage === 'SPEAKING' ? getFrequencyData() : null);
    flow.current = THREE.MathUtils.damp(flow.current, look.flow, 2.2, delta);
    for (const uniforms of [blackHole, solar]) {
      uniforms.uTime.value += reducedMotion ? 0 : delta * flow.current;
      uniforms.uEnergy.value = THREE.MathUtils.damp(uniforms.uEnergy.value, energy, energy > uniforms.uEnergy.value ? 12 : 4, delta);
      uniforms.uThinking.value = THREE.MathUtils.damp(uniforms.uThinking.value, look.thinking, 2.8, delta);
      uniforms.uHearing.value = THREE.MathUtils.damp(uniforms.uHearing.value, look.hearing, 3.0, delta);
      uniforms.uSpeaking.value = THREE.MathUtils.damp(uniforms.uSpeaking.value, look.speaking, 2.6, delta);
      uniforms.uError.value = THREE.MathUtils.damp(uniforms.uError.value, look.error, 2.8, delta);
    }
    blackHole.uOpacity.value = THREE.MathUtils.damp(blackHole.uOpacity.value, mode === 'BLACK_HOLE' ? 1 : 0, 4, delta);
    solar.uOpacity.value = THREE.MathUtils.damp(solar.uOpacity.value, mode === 'SOLAR_SYSTEM' ? 1 : 0, 4, delta);
  });
  return (
    <>
      <color attach="background" args={['#05070b']} />
      <Starfield mode={mode} quality={quality} stage={stage} reducedMotion={reducedMotion} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[0, 4, 5]} color="#d2e1f4" intensity={2} />
      <BlackHole uniforms={blackHole} />
      <SolarSystem uniforms={solar} />
      <OrbitalSculpture uniforms={blackHole} />
      <Environment resolution={64} frames={1}>
        <Lightformer intensity={3} position={[0, 5, -4]} scale={[8, 2, 1]} color="#d6e5fc" />
        <Lightformer intensity={2} position={[-5, 0, 1]} rotation={[0, Math.PI / 2, 0]} scale={[3, 8, 1]} color="#ab95cc" />
        <Lightformer intensity={1.5} position={[5, -2, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[3, 8, 1]} color="#ffd09a" />
      </Environment>
      <CameraRig mode={mode} reducedMotion={reducedMotion} viewRequest={viewRequest} />
      <EffectComposer multisampling={0}>
        <PointerLens reducedMotion={reducedMotion} />
        <Bloom intensity={0.85} luminanceThreshold={0.6} luminanceSmoothing={0.5} mipmapBlur />
      </EffectComposer>
    </>
  );
}

interface RenderBoundaryProps {
  children: ReactNode;
}

interface RenderBoundaryState {
  error: Error | null;
}

/** Isolates graphics-driver failures from the working voice and command UI. */
class RenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  constructor(props: RenderBoundaryProps) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): RenderBoundaryState {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('The observatory renderer failed', { error: error.message, componentStack: info.componentStack });
  }
  render(): ReactNode {
    if (this.state.error) {
      return <div className="jarvis-render-error" role="alert">The 3D scene could not render. Commands remain available.<small>{this.state.error.message}</small></div>;
    }
    return this.props.children;
  }
}

export const CosmicVisualizer = memo(function CosmicVisualizer(props: VisualizerProps) {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = (): void => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return (
    <div className="jarvis-cosmos" aria-label={`Interactive ${props.mode === 'BLACK_HOLE' ? 'black hole' : 'solar system'} visualizer`}>
      <RenderBoundary>
        <Canvas
          camera={{ fov: 43, position: [0, 1.1, 11.4], near: 0.1, far: 100 }}
          dpr={props.quality === 'high' ? [1, 1.75] : [1, 1.25]}
          gl={{ alpha: false, antialias: true, powerPreference: 'high-performance' }}
          frameloop={visible ? 'always' : 'never'}
        >
          <Scene {...props} />
        </Canvas>
      </RenderBoundary>
    </div>
  );
});
