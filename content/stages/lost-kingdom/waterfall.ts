import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  PlaneGeometry,
  RepeatWrapping,
  Sprite,
  SpriteNodeMaterial,
  type Texture,
} from 'three/webgpu';
import {
  atan,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  pow,
  positionWorld,
  sin,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
  asin,
} from 'three/tsl';
import { clearFront, colorUniform, floatUniform, noBloom, scaledCount, seeded, z, zColor, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { canopyLight, loadTexture, zCanopy, zSun, type V3 } from './env';

/**
 * A waterfall pouring from the outcrop's masonry spillway into a stone-lined pool. The falling water
 * is three layered sheets that follow the real ballistic path from the lip (horizontal speed, then
 * gravity), so every streak accelerates and stretches as it falls: a glassy, coherent tongue at the
 * lip breaks into aerated strands and threads lower down. At the foot, spray billows rise and drift,
 * fine droplets burst out on ballistic arcs, foam spreads on the pool and rings travel out across
 * water that reflects the photographed forest. Lit by the canopy-dappled sun, glowing where the
 * spray is backlit.
 */

const schema = z.object({
  /** Centre of the spillway lip (world) and the direction the water leaves it (horizontal). */
  lip: zVec3.default([30.15, 2.0, -26.0]),
  toward: z.tuple([z.number(), z.number()]).default([-1, 0]),
  /** Speed leaving the lip (m/s), widths at the lip and at the pool (m). */
  speed: z.number().positive().default(1.7),
  width: z.tuple([z.number().positive(), z.number().positive()]).default([3.2, 5.2]),
  /** Pool water level (world y) and its rectangle (x0, z0, x1, z1). */
  pool: z.number().default(-12.88),
  poolRect: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([19.0, -33.0, 31.0, -19.0]),
  water: zColor.default('#5f7a62'),
  deep: zColor.default('#14231c'),
  foam: zColor.default('#eef2ea'),
  /** Sky light on the water and spray (the photograph's surroundings). */
  sky: zColor.default('#b8c4a4'),
  panorama: z.object({ src: z.string(), elevation: z.tuple([z.number(), z.number()]), offset: z.number() }).optional(),
  canopy: zCanopy.prefault({}),
  sun: zSun.prefault({}),
  /** Flow speed multiplier (bindable as `flow`) and spray amount (bindable as `spray`). */
  flow: z.number().min(0).default(1),
  spray: z.number().min(0).default(1),
  puffs: z.number().int().min(0).max(400).default(90),
  droplets: z.number().int().min(0).max(4000).default(900),
  /** The world clear wave (SDK 1.5): the spray billows light up and lift as a front passes. */
  clearWave: z.object({ spray: z.number().min(0).default(0) }).prefault({}),
  seed: z.number().default(3),
});
type Params = z.infer<typeof schema>;

const G = 9.81;

export const jungleWaterfall: ComponentFactory<Params> = {
  type: 'jungleWaterfall',
  version: 1,
  description: 'Ballistic layered waterfall sheets breaking into strands, spray billows, droplets, foam and a reflecting pool.',
  schema,
  async create(ctx, p) {
    const root = new Group();
    const t = ctx.uniforms.time;
    const motion = ctx.quality.reducedMotion ? 0.6 : 1;
    const u = { presence: floatUniform(1), flow: floatUniform(p.flow * motion), spray: floatUniform(p.spray) };
    const mask = await loadTexture(ctx, p.canopy.src, 'data');
    const pano = p.panorama ? await loadTexture(ctx, p.panorama.src, 'color') : null;
    if (pano) pano.wrapS = RepeatWrapping;
    const sunColor = colorUniform(p.sun.color);
    const skyCol = colorUniform(p.sky);
    const L = vec3(...p.sun.direction).normalize();
    const [lx, ly, lz] = p.lip;
    const dir = Math.hypot(p.toward[0], p.toward[1]) > 0 ? [p.toward[0] / Math.hypot(...p.toward), p.toward[1] / Math.hypot(...p.toward)] : [-1, 0];
    const side = [-(dir[1] as number), dir[0] as number];
    const fall = Math.max(0.5, ly - p.pool);
    const T = Math.sqrt((2 * fall) / G);
    const impact = [lx + (dir[0] as number) * p.speed * T, p.pool, lz + (dir[1] as number) * p.speed * T];
    const materials: (MeshBasicNodeMaterial | SpriteNodeMaterial)[] = [];
    const geoms: BufferGeometry[] = [];

    // Sun and sky light at a point; `back` adds forward scattering towards a viewer looking into the sun.
    const light = (pw: V3, n: V3 | null, back: number): V3 => {
      const dapple = mask ? canopyLight(mask, p.canopy, p.sun, pw, 0.6) : float(0.3);
      const view = normalize(pw.sub(cameraPosition));
      const fwd = pow(max(dot(view, L), 0), 6).mul(back);
      const diffuse = n ? max(dot(n, L), 0).mul(0.6).add(0.4) : float(0.7);
      return skyCol.add(sunColor.mul(dapple.mul(p.sun.intensity * 0.25).mul(diffuse.add(fwd)))) as V3;
    };

    // ---- Falling sheets -------------------------------------------------------------------------
    const rows = 72;
    const cols = 28;
    const layers = [
      { depth: -0.35, scale: 1.0, seed: 0.0, alpha: 0.95 },
      { depth: 0.0, scale: 0.85, seed: 3.7, alpha: 0.8 },
      { depth: 0.4, scale: 0.7, seed: 8.1, alpha: 0.65 },
    ];
    for (const layer of layers) {
      const pos: number[] = [];
      const st: number[] = [];
      const idx: number[] = [];
      for (let r = 0; r <= rows; r++) {
        const s = r / rows;
        const tau = s * T;
        for (let c = 0; c <= cols; c++) {
          const w = c / cols - 0.5;
          const width = (p.width[0] + (p.width[1] - p.width[0]) * Math.pow(s, 1.2)) * layer.scale;
          const ox = (dir[0] as number) * (p.speed * tau + layer.depth * (0.3 + s)) + (side[0] as number) * w * width;
          const oz = (dir[1] as number) * (p.speed * tau + layer.depth * (0.3 + s)) + (side[1] as number) * w * width;
          // The tongue curls over the lip: a slight bulge at the top, a belly in the middle.
          const belly = Math.sin(Math.PI * Math.min(1, s * 1.4)) * 0.25 * (1 - 4 * w * w);
          pos.push(lx + ox + (dir[0] as number) * belly, ly - 0.5 * G * tau * tau, lz + oz + (dir[1] as number) * belly);
          st.push(w + 0.5, s);
        }
      }
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const a = r * (cols + 1) + c;
          idx.push(a, a + 1, a + cols + 1, a + 1, a + cols + 2, a + cols + 1);
        }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('fall', new BufferAttribute(new Float32Array(st), 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      geoms.push(g);
      const f = attribute<'vec2'>('fall');
      const w = f.x;
      const s = f.y;
      const tau = s.mul(T);
      // Water that left the lip at (time - tau): streak features ride down the ballistic path.
      const age = t.mul(u.flow).sub(tau).mul(1.0);
      const streak = mx_fractal_noise_float(vec3(w.mul(11.0).add(layer.seed), age.mul(2.2), layer.seed), 3, 2.0, 0.55).mul(0.5).add(0.5);
      const fine = mx_noise_float(vec3(w.mul(46.0).add(layer.seed * 3), age.mul(7.0), 2.0)).mul(0.5).add(0.5);
      const thread = streak.mul(0.7).add(fine.mul(0.3));
      // Coherent at the lip, breaking into strands lower down, thin and ragged at the edges.
      const breakup = smoothstep(0.0, 0.85, s).mul(0.55).add(0.18);
      const edge = smoothstep(0.0, 0.12, w).mul(smoothstep(1.0, 0.88, w));
      const ragged = smoothstep(breakup, breakup.add(0.22), thread.add(edge.mul(0.15)).mul(edge.mul(0.5).add(0.5)));
      const alpha = ragged.mul(layer.alpha).mul(smoothstep(1.0, 0.94, s)).mul(u.presence);
      const aerated = smoothstep(0.05, 0.6, s).mul(0.75).add(fine.mul(0.25));
      const glassy = mix(colorUniform(p.water), colorUniform(p.foam), aerated);
      const m = new MeshBasicNodeMaterial();
      m.colorNode = glassy.mul(light(positionWorld, null, 1.6)).mul(fine.mul(0.25).add(0.85));
      m.opacityNode = alpha;
      m.transparent = true;
      m.depthWrite = false;
      m.side = DoubleSide;
      m.blending = NormalBlending;
      noBloom(m);
      const mesh = new Mesh(g, m);
      mesh.renderOrder = 6;
      mesh.frustumCulled = false;
      root.add(mesh);
      materials.push(m);
    }

    // ---- Pool -----------------------------------------------------------------------------------
    const [x0, z0, x1, z1] = p.poolRect;
    const poolGeo = new PlaneGeometry(x1 - x0, z1 - z0, 1, 1);
    poolGeo.rotateX(-Math.PI / 2);
    poolGeo.translate((x0 + x1) / 2, p.pool, (z0 + z1) / 2);
    geoms.push(poolGeo);
    {
      const pw = positionWorld;
      const d = vec2(pw.x.sub(impact[0] as number), pw.z.sub(impact[2] as number));
      const r = length(d);
      // Rings travelling out from the impact, plus fine wind ripples.
      const ring = sin(r.mul(3.2).sub(t.mul(4.2).mul(u.flow))).mul(exp(r.mul(-0.22)));
      const rip = mx_noise_float(vec3(pw.x.mul(1.3), pw.z.mul(1.3), t.mul(0.6))).mul(0.5);
      const nx = d.x.div(r.max(0.1)).mul(ring.mul(0.18)).add(rip.mul(0.12));
      const nz = d.y.div(r.max(0.1)).mul(ring.mul(0.18)).add(mx_noise_float(vec3(pw.z.mul(1.3), pw.x.mul(1.3), t.mul(0.6).add(4))).mul(0.06));
      const n = normalize(vec3(nx, 1, nz));
      const view = normalize(pw.sub(cameraPosition));
      const refl = view.sub(n.mul(dot(view, n).mul(2)));
      const fres = float(0.02).add(pow(float(1).sub(max(dot(view.negate(), n), 0)), 5).mul(0.98));
      let reflCol: V3 = skyCol.mul(0.8) as V3;
      if (pano && p.panorama) {
        const [e0, e1] = p.panorama.elevation;
        const turn = atan(refl.x, refl.z.negate()).div(Math.PI * 2).add(p.panorama.offset);
        const el = asin(clamp(refl.y, -1, 1)).mul(180 / Math.PI);
        const v = clamp(el.sub(e0).div(e1 - e0), 0.0, 1.0);
        reflCol = texture(pano as Texture, vec2(turn, v)).rgb as V3;
      }
      const foamN = mx_fractal_noise_float(vec3(pw.x.mul(0.9), pw.z.mul(0.9), t.mul(0.4)), 3, 2, 0.5).mul(0.5).add(0.5);
      const foam = smoothstep(4.5, 0.5, r).mul(smoothstep(0.35, 0.7, foamN.add(smoothstep(3.0, 0.0, r).mul(0.4))));
      const body = mix(colorUniform(p.deep), colorUniform(p.water).mul(0.5), smoothstep(6.0, 0.0, r).mul(0.5));
      const lit = body.mul(light(pw, vec3(0, 1, 0), 0.3)).mul(0.6);
      const col = mix(lit, reflCol, fres.mul(0.75));
      const m = new MeshBasicNodeMaterial();
      m.colorNode = mix(col, colorUniform(p.foam).mul(light(pw, vec3(0, 1, 0), 0.4)), foam.mul(0.85));
      m.opacityNode = u.presence;
      m.alphaHash = true;
      noBloom(m);
      const mesh = new Mesh(poolGeo, m);
      mesh.renderOrder = 2;
      root.add(mesh);
      materials.push(m);
    }

    // ---- Spray billows --------------------------------------------------------------------------
    const rand = seeded(p.seed);
    const puffs = scaledCount(p.puffs, ctx.quality.detail, Math.min(1.5, ctx.quality.particles));
    if (puffs > 0) {
      const data = new Float32Array(puffs * 4);
      for (let i = 0; i < puffs; i++) {
        const a = rand() * Math.PI * 2;
        const rr = Math.sqrt(rand()) * 2.2;
        data[i * 4] = (impact[0] as number) + Math.cos(a) * rr;
        data[i * 4 + 1] = (impact[2] as number) + Math.sin(a) * rr;
        data[i * 4 + 2] = rand();
        data[i * 4 + 3] = 0.6 + rand() * 0.8;
      }
      const a = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(data, 4), 'vec4');
      const life = 4.5;
      const ph = fract(t.mul(u.flow).div(life).add(a.z));
      // Rise and drift downwind, swelling and thinning.
      const rise = ph.mul(6.0).mul(a.w);
      const drift = vec3(float(dir[0] as number).mul(ph.mul(3.0)).add(sin(ph.mul(6.0).add(a.z.mul(20))).mul(0.6)), rise, float(dir[1] as number).mul(ph.mul(3.0)));
      const center = vec3(a.x, float(p.pool + 0.3), a.y).add(drift);
      const m = new SpriteNodeMaterial();
      m.positionNode = center;
      m.scaleNode = float(1.2).add(ph.mul(4.2)).mul(a.w);
      const q = uv().sub(0.5).mul(2);
      const soft = smoothstep(1.0, 0.0, length(q)).pow(1.6);
      const wisp = mx_noise_float(vec3(q.mul(1.6), a.z.mul(30).add(ph))).mul(0.5).add(0.5);
      const fade = smoothstep(0.0, 0.12, ph).mul(smoothstep(1.0, 0.45, ph));
      // The clear front lights the spray as it passes (and lifts it a little).
      const front = p.clearWave.spray > 0 ? clearFront(center).mul(p.clearWave.spray) : float(0);
      m.colorNode = vec4(colorUniform(p.foam).mul(light(center, null, 2.2)).mul(front.mul(0.6).add(0.8)), 1);
      m.opacityNode = soft.mul(wisp.mul(0.6).add(0.4)).mul(fade).mul(0.2).mul(u.spray).mul(u.presence).mul(front.mul(0.5).add(1));
      m.transparent = true;
      m.depthWrite = false;
      m.blending = NormalBlending;
      noBloom(m);
      const sprite = new Sprite(m);
      sprite.count = puffs;
      sprite.frustumCulled = false;
      sprite.renderOrder = 8;
      root.add(sprite);
      materials.push(m);
    }

    // ---- Droplets -------------------------------------------------------------------------------
    const drops = scaledCount(p.droplets, ctx.quality.detail, Math.min(1.5, ctx.quality.particles));
    if (drops > 0) {
      const data = new Float32Array(drops * 4);
      for (let i = 0; i < drops; i++) {
        const a = rand() * Math.PI * 2;
        data[i * 4] = Math.cos(a) * (0.5 + rand() * 2.5);
        data[i * 4 + 1] = Math.sin(a) * (0.5 + rand() * 2.5);
        data[i * 4 + 2] = rand();
        data[i * 4 + 3] = 2.5 + rand() * 4.5;
      }
      const a = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(data, 4), 'vec4');
      const life = 1.3;
      const ph = fract(t.mul(u.flow).div(life).add(a.z));
      const tt = ph.mul(life);
      const center = vec3(
        float(impact[0] as number).add(a.x.mul(tt).mul(0.9)),
        float(p.pool + 0.1).add(a.w.mul(tt)).sub(tt.mul(tt).mul(G * 0.5)),
        float(impact[2] as number).add(a.y.mul(tt).mul(0.9)),
      );
      const m = new SpriteNodeMaterial();
      m.positionNode = center;
      m.scaleNode = float(0.05);
      const q = uv().sub(0.5).mul(2);
      const dot_ = smoothstep(1.0, 0.2, length(q));
      m.colorNode = vec4(colorUniform(p.foam).mul(light(center, null, 2.5)), 1);
      m.opacityNode = dot_.mul(smoothstep(1.0, 0.7, ph)).mul(0.7).mul(u.spray).mul(u.presence).mul(center.y.greaterThan(p.pool).select(float(1), float(0)));
      m.transparent = true;
      m.depthWrite = false;
      noBloom(m);
      const sprite = new Sprite(m);
      sprite.count = drops;
      sprite.frustumCulled = false;
      sprite.renderOrder = 9;
      root.add(sprite);
      materials.push(m);
    }

    return {
      object: root,
      reactive: { flow: u.flow, spray: u.spray },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        for (const g of geoms) g.dispose();
        for (const m of materials) m.dispose();
        mask?.dispose();
        pano?.dispose();
      },
    };
  },
};

