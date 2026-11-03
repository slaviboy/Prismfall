import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  max,
  mix,
  normalize,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  select,
  frontFacing,
  sin,
  smoothstep,
  step,
  vec3,
} from 'three/tsl';
import { colorUniform, floatUniform, noBloom, seeded, z, zColor, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { canopyLight, canopyTime, loadTexture, zCanopy, zSun, type F, type V3 } from './env';

/**
 * Lianas: woody vines that hang from the canopy above the frame or drape between two branches in a
 * catenary, some as two stems twisted round each other, carrying heart-shaped leaves along their
 * length and, where asked, a hanging lobster-claw (heliconia-like) flower spike at the end, red
 * bracts tipped yellow. Bark with green algae, lit by the sky with a rim and by the same
 * canopy-dappled sun as everything else, leaves translucent against the light. They sway slowly in
 * the breeze, most at their free ends; the leaves flutter a little on top.
 */

const strandSchema = z.object({
  /** Where the vine hangs from (above the frame). */
  top: zVec3,
  /** Length (m); a hanging strand stops at the ground. */
  length: z.number().positive(),
  /** Second anchor: the vine drapes between `top` and `to` in a catenary instead of hanging free. */
  to: zVec3.optional(),
  radius: z.number().positive().default(0.07),
  /** Two stems twisted round each other. */
  twist: z.boolean().default(false),
  /** Sideways wander of a hanging line (m). */
  wander: z.number().min(0).default(0.6),
  /** Leaves per metre and their length range (m). */
  leaves: z.number().min(0).max(6).default(1.2),
  leafSize: z.tuple([z.number().positive(), z.number().positive()]).default([0.22, 0.42]),
  /** A flower spike at the end (bract length in m; 0 = none). */
  flower: z.number().min(0).default(0),
  /** This vine's share of the breeze (a perch or a feeding flower moves less). */
  sway: z.number().min(0).default(1),
  seed: z.number().default(1),
});

const schema = z.object({
  strands: z.array(strandSchema).min(1).max(48),
  ground: z.number().default(-13),
  bark: zColor.default('#8a7552'),
  algae: zColor.default('#6f7c44'),
  leaf: zColor.default('#3f6a24'),
  leafB: zColor.default('#6e8c2e'),
  bract: zColor.default('#c8261c'),
  bractTip: zColor.default('#f2c22e'),
  sky: zColor.default('#c4cfac'),
  canopy: zCanopy.prefault({}),
  sun: zSun.prefault({}),
  /** Sway at the free end (m). Bindable as `sway`. */
  sway: z.number().min(0).default(0.3),
});
type Params = z.infer<typeof schema>;

const UP = new Vector3(0, 1, 0);

function strandPath(s: z.infer<typeof strandSchema>, ground: number, rand: () => number): Vector3[] {
  const top = new Vector3(...s.top);
  const pts: Vector3[] = [];
  if (s.to) {
    const end = new Vector3(...s.to);
    const span = top.distanceTo(end);
    // Catenary through both anchors with the given length (sag solved roughly for the slack).
    const slack = Math.max(0.05, s.length / span - 1);
    const sag = span * Math.sqrt((3 * slack) / 8);
    const n = Math.max(16, Math.round(s.length * 3));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const q = top.clone().lerp(end, t);
      const c = Math.cosh((t - 0.5) * 2.2) - Math.cosh(1.1);
      q.y += (c / (1 - Math.cosh(1.1))) * -sag;
      pts.push(q);
    }
  } else {
    const ph = rand() * 6.28;
    const dx = rand() - 0.5;
    const dz = rand() - 0.5;
    const n = Math.max(16, Math.round(s.length * 3));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const yy = Math.max(ground + 0.1, top.y - t * s.length);
      const w = (Math.sin(t * 2.2 + ph) * t + Math.sin(t * 6.3 + ph * 2) * 0.12) * s.wander;
      pts.push(new Vector3(top.x + dx * w, yy, top.z + dz * w));
      if (yy <= ground + 0.1) break;
    }
  }
  return pts;
}

export const lianas: ComponentFactory<Params> = {
  type: 'lianas',
  version: 2,
  description: 'Hanging and draped lianas (twisted stems, heart-shaped leaves, flower spikes), canopy-dappled, swaying.',
  schema,
  async create(ctx, p) {
    const mask = await loadTexture(ctx, p.canopy.src, 'data');
    const sides = ctx.quality.detail === 'low' ? 6 : 9;
    // Stems.
    const pos: number[] = [];
    const nor: number[] = [];
    const vine: number[] = [];
    const idx: number[] = [];
    // Leaves and bracts: quads with a shape coordinate.
    const lpos: number[] = [];
    const lnor: number[] = [];
    const lvine: number[] = [];
    const lshape: number[] = [];
    const lidx: number[] = [];
    const quad = (c: Vector3, along: Vector3, side: Vector3, len: number, wid: number, free: number, seed: number, kind: number): void => {
      const n = new Vector3().crossVectors(side, along).normalize();
      const b = lpos.length / 3;
      for (const [u, v] of [
        [-1, 0],
        [1, 0],
        [1, 1],
        [-1, 1],
      ] as const) {
        const q = c.clone().addScaledVector(side, u * wid * 0.5).addScaledVector(along, v * len);
        lpos.push(q.x, q.y, q.z);
        lnor.push(n.x, n.y, n.z);
        lvine.push(free, seed, v, kind);
        lshape.push(u, v);
      }
      lidx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    for (const s of p.strands) {
      const rand = seeded(s.seed * 7919 + 13);
      const path = strandPath(s, p.ground, rand);
      const len = path.length;
      const stems = s.twist ? 2 : 1;
      const frees: number[] = path.map((_, i) => (s.to ? 0.4 * Math.sin((i / (len - 1)) * Math.PI) : Math.pow(i / (len - 1), 1.3)) * s.sway);
      for (let stem = 0; stem < stems; stem++) {
        const base = pos.length / 3;
        for (let i = 0; i < len; i++) {
          const a = path[Math.max(0, i - 1)] as Vector3;
          const b = path[Math.min(len - 1, i + 1)] as Vector3;
          const tdir = b.clone().sub(a).normalize();
          const ref = Math.abs(tdir.y) > 0.9 ? new Vector3(1, 0, 0) : UP;
          const e1 = new Vector3().crossVectors(tdir, ref).normalize();
          const e2 = new Vector3().crossVectors(tdir, e1).normalize();
          const arc = (i / len) * s.length;
          let center = (path[i] as Vector3).clone();
          let radius = s.radius * (1 - 0.3 * (i / len)) * (1 + 0.12 * Math.sin(i * 1.3 + s.seed));
          if (stems === 2) {
            // Two stems wound round each other, a turn every 1.3 m.
            const ang = arc * ((Math.PI * 2) / 1.3) + stem * Math.PI;
            center = center.addScaledVector(e1, Math.cos(ang) * s.radius * 0.75).addScaledVector(e2, Math.sin(ang) * s.radius * 0.75);
            radius *= 0.62;
          }
          for (let k = 0; k < sides; k++) {
            const ang = (k / sides) * Math.PI * 2;
            const nn = e1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(e2, Math.sin(ang));
            pos.push(center.x + nn.x * radius, center.y + nn.y * radius, center.z + nn.z * radius);
            nor.push(nn.x, nn.y, nn.z);
            vine.push(frees[i] as number, s.seed, i / len, 0);
          }
        }
        for (let i = 0; i < len - 1; i++)
          for (let k = 0; k < sides; k++) {
            const a = base + i * sides + k;
            const b = base + i * sides + ((k + 1) % sides);
            idx.push(a, a + sides, b, b, a + sides, b + sides);
          }
      }
      // Leaves on short stalks, turned every way about the vine, hanging a little.
      const total = Math.round(s.leaves * s.length * (ctx.quality.detail === 'low' ? 0.5 : 1));
      for (let k = 0; k < total; k++) {
        const t = 0.04 + rand() * 0.92;
        const i = Math.min(len - 2, Math.floor(t * (len - 1)));
        const at = (path[i] as Vector3).clone().lerp(path[i + 1] as Vector3, t * (len - 1) - i);
        const tdir = (path[i + 1] as Vector3).clone().sub(path[i] as Vector3).normalize();
        const ref = Math.abs(tdir.y) > 0.9 ? new Vector3(1, 0, 0) : UP;
        const e1 = new Vector3().crossVectors(tdir, ref).normalize();
        const e2 = new Vector3().crossVectors(tdir, e1).normalize();
        const ang = rand() * Math.PI * 2;
        const out = e1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(e2, Math.sin(ang));
        const size = s.leafSize[0] + (s.leafSize[1] - s.leafSize[0]) * rand();
        // The blade points outward and droops; its plane tilts about the blade's axis.
        const along = out.clone().multiplyScalar(0.55).add(new Vector3(0, -0.75 - rand() * 0.3, 0)).normalize();
        const side = new Vector3().crossVectors(along, tdir).normalize().applyAxisAngle(along, (rand() - 0.5) * 1.1);
        const start = at.clone().addScaledVector(out, s.radius + 0.03 + size * 0.08);
        const free = (s.to ? 0.4 * Math.sin(t * Math.PI) : Math.pow(t, 1.3)) * s.sway;
        quad(start, along, side, size, size * 0.72, free, s.seed + k * 0.37, 1);
      }
      // Flower spike: alternating boat-shaped bracts on a zigzag hanging rachis.
      if (s.flower > 0 && !s.to) {
        const end = (path[len - 1] as Vector3).clone();
        const bracts = 8;
        for (let b = 0; b < bracts; b++) {
          const side = b % 2 === 0 ? 1 : -1;
          const c = end.clone().add(new Vector3(side * s.flower * 0.12, -b * s.flower * 0.34, 0));
          const along = new Vector3(side * 0.85, 0.5, 0.12).normalize();
          const sd = new Vector3(0, 0, 1);
          const scale = 1 - b * 0.06;
          quad(c, along, sd, s.flower * scale, s.flower * 0.42 * scale, s.sway, s.seed + b, 2);
        }
      }
    }

    const u = { presence: floatUniform(1), sway: floatUniform(ctx.quality.reducedMotion ? p.sway * 0.3 : p.sway) };
    const L = vec3(...p.sun.direction).normalize();
    const t = canopyTime;
    const swing = (v: ReturnType<typeof attribute<'vec4'>>) => {
      const ph = v.y.mul(1.7);
      return vec3(sin(t.mul(0.55).add(ph)).mul(0.8).add(sin(t.mul(1.3).add(ph.mul(2))).mul(0.25)), 0, cos(t.mul(0.47).add(ph)).mul(0.6)).mul(v.x).mul(u.sway);
    };
    const lightAt = (n: V3, back: number): V3 => {
      const dapple: F = mask ? canopyLight(mask, p.canopy, p.sun, positionWorld, 1) : float(0.4);
      const view = normalize(cameraPosition.sub(positionWorld));
      const rim = pow(float(1).sub(abs(dot(n, view))), 2.5).mul(0.35);
      const sky = colorUniform(p.sky).mul(n.y.mul(0.25).add(0.75)).mul(float(1.35).add(rim));
      const direct = max(dot(n, L), 0).add(max(dot(n, L).negate(), 0).mul(back));
      return sky.add(colorUniform(p.sun.color).mul(direct.mul(dapple).mul(p.sun.intensity * 0.55))) as V3;
    };

    const group = new Group();
    const materials: MeshBasicNodeMaterial[] = [];
    const geoms: BufferGeometry[] = [];
    {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
      g.setAttribute('vine', new BufferAttribute(new Float32Array(vine), 4));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const v = attribute<'vec4'>('vine');
      const m = new MeshBasicNodeMaterial();
      m.positionNode = positionLocal.add(swing(v));
      const n = normalize(normalWorld) as V3;
      const col = mix(colorUniform(p.bark), colorUniform(p.algae), smoothstep(0.25, 0.9, v.z).mul(0.55));
      m.colorNode = col.mul(lightAt(n, 0));
      m.opacityNode = u.presence;
      m.alphaHash = true;
      noBloom(m);
      const mesh = new Mesh(g, m);
      mesh.frustumCulled = false;
      group.add(mesh);
      geoms.push(g);
      materials.push(m);
    }
    if (lpos.length > 0) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(lpos), 3));
      g.setAttribute('normal', new BufferAttribute(new Float32Array(lnor), 3));
      g.setAttribute('vine', new BufferAttribute(new Float32Array(lvine), 4));
      g.setAttribute('shape', new BufferAttribute(new Float32Array(lshape), 2));
      g.setIndex(lidx);
      g.computeBoundingSphere();
      const v = attribute<'vec4'>('vine');
      const sh = attribute<'vec2'>('shape');
      const isFlower = step(1.5, v.w);
      // Heart-shaped blade (lobes at the base, drip tip) or a boat-shaped bract.
      const y = sh.y;
      const blade = pow(sin(y.min(0.97).mul(Math.PI)), 0.75).mul(float(1).sub(y.mul(0.3))).add(exp(y.sub(0.1).div(0.07).pow(2).negate()).mul(0.25));
      const boat = pow(sin(y.mul(Math.PI)), 0.55).mul(0.95);
      const width = mix(blade, boat, isFlower);
      const inside = step(abs(sh.x), width);
      const flutter = sin(t.mul(4.2).add(v.y.mul(13))).mul(0.025).mul(y).mul(float(1).sub(isFlower));
      const m = new MeshBasicNodeMaterial();
      m.positionNode = positionLocal.add(swing(v)).add(vec3(flutter, flutter.mul(0.6), flutter.negate()));
      const n = normalize(select(frontFacing, normalWorld, normalWorld.negate())) as V3;
      const midrib = smoothstep(0.06, 0.0, abs(sh.x)).mul(float(1).sub(isFlower));
      const veins = smoothstep(0.85, 1.0, sin(y.mul(22).sub(abs(sh.x).mul(9))).mul(0.5).add(0.5)).mul(0.25).mul(float(1).sub(isFlower));
      const leafCol = mix(colorUniform(p.leaf), colorUniform(p.leafB), sin(v.y.mul(5.3)).mul(0.5).add(0.5)).mul(float(1).sub(veins)).add(colorUniform(p.leafB).mul(midrib.mul(0.4)));
      const bractCol = mix(colorUniform(p.bract), colorUniform(p.bractTip), smoothstep(0.62, 0.92, y).max(smoothstep(0.7, 0.95, abs(sh.x).div(width.max(0.01)))));
      // Leaves seen against the bright canopy glow with the skylight they let through.
      const view = normalize(cameraPosition.sub(positionWorld));
      const through = pow(float(1).sub(abs(dot(n, view))), 1.5).mul(0.5).add(0.45).mul(float(1).sub(isFlower));
      const lit = mix(leafCol, bractCol, isFlower).mul(lightAt(n, 0.55));
      m.colorNode = lit.add(colorUniform(p.leafB).mul(colorUniform(p.sky)).mul(through));
      m.opacityNode = inside.mul(u.presence);
      m.alphaHash = true;
      m.side = DoubleSide;
      noBloom(m);
      const mesh = new Mesh(g, m);
      mesh.frustumCulled = false;
      group.add(mesh);
      geoms.push(g);
      materials.push(m);
    }
    return {
      object: group,
      reactive: { sway: u.sway },
      update(frame) {
        canopyTime.value = frame.time;
      },
      setPresence(val) {
        u.presence.value = val;
      },
      dispose() {
        for (const g of geoms) g.dispose();
        for (const m of materials) m.dispose();
        mask?.dispose();
      },
    };
  },
};
