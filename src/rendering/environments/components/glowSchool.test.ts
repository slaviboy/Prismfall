import { describe, expect, it } from 'vitest';
import { AdditiveBlending, Scene, Vector3, type Mesh, type MeshBasicNodeMaterial } from 'three/webgpu';
import type { EnvFrame, EnvironmentContext } from '../../../sdk/types';
import { frameUniforms } from '../../shaders/uniforms';
import { fishSeeds, glowSchoolComponent, swimPoint } from './glowSchool';

function context(): EnvironmentContext {
  return {
    stageId: 'test',
    scene: new Scene(),
    quality: { detail: 'high', particles: 1, reflections: 'off', reducedMotion: false },
    uniforms: frameUniforms,
    assets: {} as EnvironmentContext['assets'],
    bursts: {} as EnvironmentContext['bursts'],
    palette: {} as EnvironmentContext['palette'],
    ground: { height: () => 0, provide: () => undefined, surface: () => 0, setWaterLevel: () => undefined },
    sounds: { emit: () => undefined },
  };
}

const frame = (time: number, progress: number, dt = 1 / 60): EnvFrame =>
  ({ time, dt, audio: {} as EnvFrame['audio'], game: { danger: 0, combo: -1, backToBack: 0, level: 1, clearPulse: 0, progress }, presence: 1 }) as EnvFrame;

describe('glow school paths', () => {
  it('keeps a vortex outside its inner ring at all times (the board stays clear)', () => {
    const m = glowSchoolComponent.schema.parse({ motion: { kind: 'vortex', center: [0, 1, -50], radius: [33, 68], squash: 0.62 } }).motion;
    const p = new Vector3();
    const dir = new Vector3();
    for (let i = 0; i < 300; i++) {
      const s = fishSeeds((i * 0.618034) % 1);
      for (const t of [0, 3.7, 41, 250]) {
        swimPoint(m, s, t, p, dir);
        // In the ring's own (unsquashed) plane every fish is at least 95% of the inner radius out.
        const r = Math.hypot(p.x, (p.y - 1) / 0.62);
        expect(r).toBeGreaterThan(33 * 0.94);
        expect(r).toBeLessThan(68 * 1.06);
        expect(dir.length()).toBeCloseTo(1, 5);
      }
    }
  });

  it('keeps a school near its loop, swimming along it', () => {
    const m = glowSchoolComponent.schema.parse({ motion: { kind: 'school', center: [-58, 4, -58], radius: [20, 3, 12], spread: [6, 2.5, 4] } }).motion;
    const p = new Vector3();
    const dir = new Vector3();
    for (let i = 0; i < 100; i++) {
      swimPoint(m, fishSeeds((i * 0.381966) % 1), i * 1.3, p, dir);
      expect(Math.abs(p.x + 58)).toBeLessThan(20 + 6.01);
      expect(Math.abs(p.y - 4)).toBeLessThan(1.5 + 2.51);
      expect(Math.abs(p.z + 58)).toBeLessThan(12 + 4.01);
    }
  });
});

describe('glow school component', () => {
  it('draws one additive, fog-free streak per fish', async () => {
    const c = await glowSchoolComponent.create(context(), glowSchoolComponent.schema.parse({ count: 50, motion: { kind: 'school', center: [0, 0, -40] } }));
    const mesh = c.object as Mesh;
    expect(mesh.geometry.getAttribute('corner').count).toBe(50 * 4);
    const material = mesh.material as MeshBasicNodeMaterial;
    expect(material.blending).toBe(AdditiveBlending);
    expect(material.fog).toBe(false);
    expect(material.depthWrite).toBe(false);
    c.dispose();
  });

  it('updates and takes big clears without a reveal plan', async () => {
    const c = await glowSchoolComponent.create(context(), glowSchoolComponent.schema.parse({ count: 10, motion: { kind: 'vortex', center: [0, 0, -50] } }));
    c.update!(frame(1, 0));
    c.onGameEvent!({ kind: 'clear', lines: 4, perfectClear: false } as never);
    c.update!(frame(2, 0.5));
    c.dispose();
  });
});
