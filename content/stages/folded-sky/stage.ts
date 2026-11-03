import { BufferAttribute, BufferGeometry, Color, DoubleSide, InstancedBufferAttribute, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, cos, float, instancedBufferAttribute, sin, vec3, vec4 } from 'three/tsl';
import { defineStage, floatUniform, makeRecipeEffect, seeded, z, zColor, zVec3, type ComponentFactory, type TransitionEffect } from '@prismfall/sdk';

/**
 * Folded Sky: a content-only world. Everything here goes through the public SDK: a paper-crane
 * flock component, a "fold into cranes" line clear and a paper-fold entrance.
 */

/** One folded-paper crane: body, raised neck and tail, two wings (wings tagged for flapping). */
function craneGeometry(): BufferGeometry {
  const pos: number[] = [];
  const wing: number[] = [];
  const tri = (a: number[], b: number[], c: number[], w: number): void => {
    pos.push(...a, ...b, ...c);
    wing.push(w, w, w);
  };
  // Body: a flat diamond prism.
  tri([0, 0.12, -0.5], [-0.12, 0, 0], [0, 0.12, 0.5], 0);
  tri([0, 0.12, -0.5], [0, 0.12, 0.5], [0.12, 0, 0], 0);
  tri([0, -0.05, -0.4], [0.12, 0, 0], [0, -0.05, 0.4], 0);
  tri([0, -0.05, -0.4], [0, -0.05, 0.4], [-0.12, 0, 0], 0);
  // Neck and head (forward, raised) and tail (back, raised).
  tri([0, 0.1, -0.4], [0.03, 0.55, -0.85], [-0.03, 0.55, -0.85], 0);
  tri([0.03, 0.55, -0.85], [-0.03, 0.55, -0.85], [0, 0.48, -1.05], 0);
  tri([0, 0.1, 0.4], [0.03, 0.5, 0.95], [-0.03, 0.5, 0.95], 0);
  // Wings: broad triangles, outer vertices marked 1 (left −1, right +1 by sign of x).
  tri([0, 0.12, -0.25], [0, 0.12, 0.25], [-1.1, 0.2, 0.1], -1);
  tri([0, 0.12, -0.25], [1.1, 0.2, 0.1], [0, 0.12, 0.25], 1);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  // Only the wingtip vertex flaps: weight by |x|.
  const weights = new Float32Array(wing.length);
  for (let i = 0; i < wing.length; i++) weights[i] = Math.abs(pos[i * 3]!) > 0.5 ? Math.sign(pos[i * 3]!) : 0;
  g.setAttribute('flap', new BufferAttribute(weights, 1));
  g.computeVertexNormals();
  return g;
}

const craneSchema = z.object({
  count: z.number().int().min(1).max(600).default(80),
  center: zVec3.default([0, 30, -160]),
  radius: zVec3.default([180, 30, 80]),
  size: z.tuple([z.number(), z.number()]).default([3, 5]),
  colors: z.array(zColor).min(1).default(['#f4efe6', '#e85a4a', '#4a7ad8', '#f2c14e']),
  speed: z.number().default(0.05),
  seed: z.number().default(3),
});

const paperCranes: ComponentFactory<z.infer<typeof craneSchema>> = {
  type: 'paperCranes',
  version: 1,
  description: 'A flock of folded-paper cranes drifting on slow orbits, wings beating.',
  schema: craneSchema,
  create(ctx, p) {
    const rand = seeded(p.seed * 911);
    const data = new Float32Array(p.count * 4);
    const tints = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      data.set([rand() * Math.PI * 2, 0.4 + rand() * 0.8, p.size[0] + (p.size[1] - p.size[0]) * rand(), rand()], i * 4);
      const c = new Color(p.colors[Math.floor(rand() * p.colors.length)]!);
      tints.set([c.r, c.g, c.b, 1], i * 4);
    }
    const a = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(data, 4), 'vec4');
    const tint = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(tints, 4), 'vec4');
    const u = { presence: floatUniform(1), speed: floatUniform(1) };
    const t = ctx.uniforms.time.mul(u.speed);
    // Each crane circles the centre on its own ring, rising and falling gently.
    const ang = a.x.add(t.mul(p.speed).mul(a.y));
    const ring = a.w.mul(0.6).add(0.4);
    const centre = vec3(...p.center).add(vec3(cos(ang).mul(p.radius[0]).mul(ring), sin(t.mul(0.3).add(a.x.mul(5))).mul(p.radius[1]), sin(ang).mul(p.radius[2]).mul(ring)));
    const flapW = attribute<'float'>('flap', 'float');
    const local = attribute<'vec3'>('position', 'vec3');
    const beat = sin(t.mul(3.2).add(a.x.mul(7))).mul(0.55);
    const bent = vec3(local.x.mul(cos(beat.mul(flapW.abs()))), local.y.add(local.x.abs().mul(sin(beat)).mul(flapW.abs())), local.z);
    // Face along the orbit tangent (yaw = −ang).
    const yaw = ang.negate();
    const cy = cos(yaw);
    const sy = sin(yaw);
    const s = bent.mul(a.z);
    const world = vec3(s.x.mul(cy).add(s.z.mul(sy)), s.y, s.x.negate().mul(sy).add(s.z.mul(cy))).add(centre);
    const material = new MeshStandardNodeMaterial();
    material.positionNode = world;
    material.colorNode = vec4(tint.xyz.mul(float(0.85).add(u.presence.mul(0.15))), 1);
    material.roughness = 0.92;
    material.flatShading = true;
    material.side = DoubleSide;
    const geometry = craneGeometry();
    const mesh = new Mesh(geometry, material);
    mesh.count = p.count;
    mesh.frustumCulled = false;
    return {
      object: mesh,
      reactive: { speed: u.speed },
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

/** Cleared rows fold into paper scraps that rise and turn like cranes taking off. */
const foldIntoCranes = makeRecipeEffect(
  'foldIntoCranes',
  {
    shape: 'petal',
    perCell: 6,
    motion: 'rise',
    speed: [2, 5],
    gravity: 1.4,
    drag: 0.9,
    swirl: 2.2,
    life: [1.4, 2.4],
    size: [0.22, 0.42],
    color: 'mix',
    brightness: 1.3,
    secondary: { share: 0.4, shape: 'shard', motion: 'radial', speed: [3, 7], gravity: -3, life: [0.6, 1.1], size: [0.12, 0.24], color: 'white', brightness: 1.6 },
  },
  'Rows fold into paper scraps that rise like cranes.',
);

/** Entrance: sheets of paper fall and tumble across the view. */
const paperFold: TransitionEffect = {
  id: 'paperFold',
  description: 'Sheets of coloured paper tumble in from above.',
  play(ctx) {
    const colours = ['#f4efe6', '#e85a4a', '#4a7ad8', '#f2c14e'].map((h) => new Color(h).convertSRGBToLinear());
    const n = ctx.bursts.budget(500 * ctx.intensityScale * (ctx.reducedMotion ? 0.35 : 1));
    for (let i = 0; i < n; i++) {
      const c = colours[i % colours.length]!;
      ctx.bursts.emit(
        { x: (Math.random() - 0.5) * 90, y: 14 + Math.random() * 8, z: -24 + Math.random() * 30, vx: 2 + Math.random() * 4, vy: -4 - Math.random() * 4, vz: 0, r: c.r, g: c.g, b: c.b, size: 0.3 + Math.random() * 0.4, life: 3 + Math.random() * 1.5, delay: Math.random() * ctx.duration * 0.7, drag: 0.4, swirl: 2.6, shape: 'petal' },
        ctx.time,
      );
    }
  },
};

export default defineStage({
  sdkVersion: '1.1.0',
  register(sdk) {
    sdk.components.register(paperCranes as unknown as ComponentFactory);
    sdk.lineClearEffects.register(foldIntoCranes);
    sdk.transitions.register(paperFold);
  },
});
