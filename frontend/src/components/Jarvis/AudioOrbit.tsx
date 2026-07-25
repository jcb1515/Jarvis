import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

interface BarsProps {
  active: boolean;
  getFrequencyData: () => Uint8Array | null;
  count: number;
}

function SpectrumBars({ active, getFrequencyData, count }: BarsProps) {
  const baseRadius = 2.18;
  const barHeight = 0.9;
  const refs = useRef<Array<THREE.Mesh | null>>([]);
  const values = useMemo(() => new Array<number>(count).fill(0), [count]);

  useFrame(({ clock }) => {
    const frequency = getFrequencyData();
    const activeFrequency =
      frequency?.some((sample) => sample > 2) ? frequency : null;
    refs.current.forEach((bar, index) => {
      if (!bar) return;
      const sourceIndex = activeFrequency
        ? Math.floor((index / count) * activeFrequency.length)
        : 0;
      const liveValue = activeFrequency
        ? activeFrequency[sourceIndex] / 255
        : 0;
      const previewValue =
        0.06 +
        Math.abs(
          Math.sin(index * 0.47 + clock.elapsedTime * 2.2),
        ) ** 4 *
          0.78 +
        Math.abs(
          Math.sin(index * 0.17 - clock.elapsedTime * 1.4),
        ) ** 3 *
          0.18;
      const idleValue =
        0.08 + Math.sin(index * 0.73 + clock.elapsedTime * 0.45) * 0.018;
      const target = active
        ? 0.08 + (activeFrequency ? liveValue : previewValue) * 0.92
        : idleValue;
      values[index] += (target - values[index]) * 0.26;
      const scale = Math.max(0.04, values[index]);
      const angle = (index / count) * Math.PI * 2;
      const radius = baseRadius + (barHeight * scale) / 2;
      bar.scale.y = scale;
      bar.position.set(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        0,
      );
    });
  });

  return (
    <group>
      {values.map((_, index) => {
        const angle = (index / count) * Math.PI * 2;
        return (
          <mesh
            key={index}
            ref={(mesh) => {
              refs.current[index] = mesh;
            }}
            position={[
              Math.cos(angle) * baseRadius,
              Math.sin(angle) * baseRadius,
              0,
            ]}
            rotation={[0, 0, angle - Math.PI / 2]}
          >
            <boxGeometry args={[0.055, barHeight, 0.075]} />
            <meshBasicMaterial
              color={active ? '#ff2d38' : '#8c111a'}
              transparent
              opacity={active ? 0.96 : 0.58}
            />
          </mesh>
        );
      })}
      <mesh>
        <torusGeometry args={[2.16, 0.022, 8, 160]} />
        <meshBasicMaterial color="#ff2935" transparent opacity={0.72} />
      </mesh>
      <mesh>
        <torusGeometry args={[1.78, 0.008, 8, 160]} />
        <meshBasicMaterial color="#7b1a20" transparent opacity={0.75} />
      </mesh>
      <mesh>
        <torusGeometry args={[1.48, 0.006, 8, 160]} />
        <meshBasicMaterial color="#ff3843" transparent opacity={0.4} />
      </mesh>
      <mesh>
        <torusGeometry args={[1.18, 0.005, 8, 160]} />
        <meshBasicMaterial color="#78151c" transparent opacity={0.62} />
      </mesh>
      <mesh rotation={[0, 0, -0.42]}>
        <torusGeometry args={[2.34, 0.035, 8, 160, 1.4]} />
        <meshBasicMaterial color="#ff5961" />
      </mesh>
    </group>
  );
}

interface AudioOrbitProps {
  active: boolean;
  compact: boolean;
  getFrequencyData: () => Uint8Array | null;
  label: string;
}

export function AudioOrbit({
  active,
  compact,
  getFrequencyData,
  label,
}: AudioOrbitProps) {
  return (
    <div
      className={`jarvis-orbit ${compact ? 'jarvis-orbit--compact' : ''}`}
      aria-label={label}
    >
      <Canvas
        camera={{ position: [0, 0, 7.3], fov: 48 }}
        dpr={[1, 1.5]}
        gl={{ alpha: true, antialias: true }}
      >
        <SpectrumBars
          active={active}
          getFrequencyData={getFrequencyData}
          count={compact ? 52 : 96}
        />
        <EffectComposer>
          <Bloom intensity={1.15} luminanceThreshold={0.22} mipmapBlur />
        </EffectComposer>
      </Canvas>
      <span className="jarvis-orbit__core">{compact ? 'MIC' : 'JARVIS'}</span>
    </div>
  );
}
