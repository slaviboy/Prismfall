import { AdditiveBlending, CylinderGeometry, DoubleSide, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { abs, clamp, dot, exp, float, fract, instancedBufferAttribute, mrt, normalView, positionGeometry, positionViewDirection, smoothstep, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, seeded, zColor, zVec3 } from './common';

const schema = z.object({
  count: z.number().int().min(1).max(64).default(8),
  /** Ring layout around the board (radius, y, depth offset). */
  radius: z.number().default(70),
  y: z.number().default(-14),
  z: z.number().default(-60),
  arc: z.number().default(160),
  height: z.number().default(140),
  width: z.number().default(1.4),
  color: zColor.default('#7fe9ff'),
  base: z.number().default(0.25),
  pulse: z.number().default(1.2),
  /** Beats between flashes of the same beam (sequence length). */
  sequence: z.number().int().min(1).default(4),
  tilt: zVec3.default([0, 0, 0]),
  seed: z.number().default(3),
});

/** Vertical light pillars that flash in a beat-synchronised sequence. */
export const beamsComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'beams',
  version: 1,
  description: 'Light pillars arranged in an arc that flash in sequence with the beat.',
  schema,
  create(_ctx, p) {
    const geometry = new CylinderGeometry(p.width, p.width * 0.6, p.height, 16, 1, true);
    geometry.translate(0, p.height / 2, 0);
    const phases = new Float32Array(p.count);
    const rand = seeded(p.seed);
    const matrices: Matrix4[] = [];
    for (let i = 0; i < p.count; i++) {
      const a = ((i / Math.max(1, p.count - 1)) - 0.5) * (p.arc * Math.PI / 180);
      const pos = new Vector3(Math.sin(a) * p.radius, p.y, p.z - Math.cos(a) * p.radius * 0.35 + (rand() - 0.5) * 10);
      matrices.push(new Matrix4().compose(pos, new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (rand() - 0.5) * 0.06 + p.tilt[2]), new Vector3(1, 0.8 + rand() * 0.4, 1)));
      phases[i] = (i % p.sequence) / p.sequence;
    }
    const phase = instancedBufferAttribute<'float'>(new InstancedBufferAttribute(phases, 1), 'float');
    const u = { intensity: floatUniform(1), beats: floatUniform(0), presence: floatUniform(1) };
    const local = fract(u.beats.div(p.sequence).sub(phase));
    const flash = exp(local.mul(-p.sequence * 2.2)).mul(p.pulse);
    // Geometry position: on an InstancedMesh positionLocal is already instance-transformed.
    const vertical = smoothstep(0, 0.08, positionGeometry.y.div(p.height)).mul(smoothstep(1, 0.25, positionGeometry.y.div(p.height)));
    const edge = float(1).sub(abs(dot(normalView, positionViewDirection))).pow(0.5).oneMinus().add(0.15);
    const color = colorUniform(p.color).mul(float(p.base).add(flash)).mul(vertical).mul(clamp(edge, 0, 1)).mul(u.intensity).mul(u.presence);
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color, 1);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.mrtNode = mrt({ emissive: vec4(color.mul(0.7), 1) });
    const mesh = new InstancedMesh(geometry, material, p.count);
    matrices.forEach((mm, i) => mesh.setMatrixAt(i, mm));
    mesh.frustumCulled = false;
    mesh.renderOrder = -4;
    return {
      object: mesh,
      reactive: { intensity: u.intensity },
      update(frame) {
        u.beats.value = frame.audio.beat + frame.audio.beatPhase;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
