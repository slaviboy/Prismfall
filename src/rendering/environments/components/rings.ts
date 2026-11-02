import { AdditiveBlending, DoubleSide, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, RingGeometry, Vector3 } from 'three/webgpu';
import { exp, float, fract, instancedBufferAttribute, mrt, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, zColor } from './common';

const schema = z.object({
  count: z.number().int().min(1).max(64).default(14),
  radius: z.number().default(16),
  growth: z.number().default(1.18),
  spacing: z.number().default(14),
  startZ: z.number().default(-8),
  thickness: z.number().default(0.12),
  color: zColor.default('#6e8bff'),
  colorB: zColor.optional(),
  base: z.number().default(0.12),
  pulse: z.number().default(1),
  /** Ring travel speed toward the camera (units per second, wraps). */
  speed: z.number().default(2),
  segments: z.number().int().default(128),
});

/** A tunnel of glowing rings receding behind the board; a light pulse travels outward each beat. */
export const ringsComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'rings',
  version: 1,
  description: 'Receding ring tunnel with beat-travelling light pulses.',
  schema,
  create(ctx, p) {
    const geometry = new RingGeometry(1 - p.thickness, 1, p.segments, 1);
    const idx = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) idx[i] = i / p.count;
    const index = instancedBufferAttribute<'float'>(new InstancedBufferAttribute(idx, 1), 'float');
    const u = { intensity: floatUniform(1), beats: floatUniform(0), presence: floatUniform(1) };
    const local = fract(u.beats.mul(0.5).sub(index));
    const pulse = exp(local.mul(-9)).mul(p.pulse);
    const fade = float(1).sub(index).pow(1.5);
    const tint = colorUniform(p.color);
    const color = tint.mul(float(p.base).add(pulse)).mul(fade).mul(u.intensity).mul(u.presence);
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color, 1);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.mrtNode = mrt({ emissive: vec4(color.mul(0.9), 1) });
    const mesh = new InstancedMesh(geometry, material, p.count);
    mesh.frustumCulled = false;
    mesh.renderOrder = -3;
    const m = new Matrix4();
    const q = new Quaternion();
    const s = new Vector3();
    const v = new Vector3();
    let offset = 0;
    const depth = p.count * p.spacing;
    const place = (): void => {
      for (let i = 0; i < p.count; i++) {
        const d = (((i * p.spacing - offset) % depth) + depth) % depth;
        const r = p.radius * Math.pow(p.growth, d / p.spacing);
        m.compose(v.set(0, 0, p.startZ - d), q.identity(), s.set(r, r, 1));
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    place();
    return {
      object: mesh,
      reactive: { intensity: u.intensity },
      update(frame) {
        u.beats.value = frame.audio.beat + frame.audio.beatPhase;
        if (!ctx.quality.reducedMotion && p.speed !== 0) {
          offset += frame.dt * p.speed;
          place();
        }
      },
      setPresence(v2) {
        u.presence.value = v2;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
