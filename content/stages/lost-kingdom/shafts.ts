import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import { attribute, cameraPosition, cross, dot, exp, float, mx_noise_float, normalize, positionWorld, smoothstep, vec3, vec4, abs, mrt } from 'three/tsl';
import { additiveFog, colorUniform, floatUniform, z, zColor, type ComponentFactory } from '@prismfall/sdk';
import { canopyTime, zSun } from './env';

/**
 * Shafts of sunlight through gaps in the canopy, slanting along the sun's direction from above the
 * frame to the ground. Each shaft is a strip that turns about its own axis to face the viewer, with
 * a soft profile, a few brighter threads inside and slow variations as leaves move across the gap;
 * dust in the beams comes from the pollen layer. Additive, fogged by distance, never in the board's
 * clear zone, and gentle with the music (the brightness can follow the section intensity).
 */

const shaftSchema = z.object({
  /** Where the shaft meets the ground (world x, y, z). */
  at: z.tuple([z.number(), z.number(), z.number()]),
  width: z.number().positive().default(3),
  length: z.number().positive().default(55),
  strength: z.number().min(0).default(1),
  seed: z.number().default(1),
});

const schema = z.object({
  shafts: z.array(shaftSchema).min(1).max(32),
  sun: zSun.prefault({}),
  color: zColor.default('#fff0cc'),
  /** Overall brightness (bindable as `intensity`). */
  intensity: z.number().min(0).default(0.09),
});
type Params = z.infer<typeof schema>;

export const sunShafts: ComponentFactory<Params> = {
  type: 'sunShafts',
  version: 1,
  description: 'Soft slanting shafts of sunlight through canopy gaps, facing the viewer about their axes.',
  schema,
  create(ctx, p) {
    const L = new Vector3(...p.sun.direction).normalize();
    const pos: number[] = [];
    const data: number[] = [];
    const idx: number[] = [];
    p.shafts.forEach((s) => {
      const a = new Vector3(...s.at);
      const b = a.clone().addScaledVector(L, s.length);
      const base = pos.length / 3;
      // Four vertices: the axis end points, each twice; the shader pushes them sideways.
      for (const [q, along] of [
        [a, 0],
        [b, 1],
      ] as const) {
        for (const sideSign of [-1, 1]) {
          pos.push(q.x, q.y, q.z);
          data.push(sideSign, along as number, s.width, s.strength);
        }
      }
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    });
    const seeds: number[] = [];
    p.shafts.forEach((s) => {
      for (let k = 0; k < 4; k++) seeds.push(s.seed);
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('shaft', new BufferAttribute(new Float32Array(data), 4));
    g.setAttribute('sseed', new BufferAttribute(new Float32Array(seeds), 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const u = { presence: floatUniform(1), intensity: floatUniform(p.intensity) };
    const sh = attribute<'vec4'>('shaft');
    const seed = attribute<'float'>('sseed');
    const axis = vec3(L.x, L.y, L.z);
    const m = new MeshBasicNodeMaterial();
    // Billboard about the axis: offset sideways, perpendicular to both the axis and the view.
    const toCam = normalize(cameraPosition.sub(attribute<'vec3'>('position')));
    const sideDir = normalize(cross(axis, toCam));
    m.positionNode = attribute<'vec3'>('position').add(sideDir.mul(sh.x.mul(sh.z).mul(0.5)));
    const across = sh.x;
    const along = sh.y;
    const profile = exp(across.mul(across).mul(-3.2));
    const threads = mx_noise_float(vec3(across.mul(3.5).add(seed.mul(7)), along.mul(2.0), canopyTime.mul(0.08).add(seed))).mul(0.5).add(0.5);
    const breathe = mx_noise_float(vec3(seed.mul(3.1), canopyTime.mul(0.12), 0.5)).mul(ctx.quality.reducedMotion ? 0.12 : 0.35).add(0.75);
    const ends = smoothstep(0.0, 0.12, along).mul(smoothstep(1.0, 0.55, along));
    // Fainter when seen along the shaft (no false brightness where beams overlap the viewer).
    const facing = float(1).sub(abs(dot(normalize(positionWorld.sub(cameraPosition)), axis)).mul(0.6));
    const glow = colorUniform(p.color).mul(profile.mul(threads.mul(0.7).add(0.3)).mul(breathe).mul(ends).mul(facing).mul(sh.w)).mul(u.intensity).mul(u.presence);
    m.colorNode = vec4(additiveFog(glow), 1);
    m.blending = AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    m.side = DoubleSide;
    m.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const mesh = new Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 12;
    return {
      object: mesh,
      reactive: { intensity: u.intensity },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        g.dispose();
        m.dispose();
      },
    };
  },
};
