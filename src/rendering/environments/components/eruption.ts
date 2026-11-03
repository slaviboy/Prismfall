import { AdditiveBlending, BufferAttribute, BufferGeometry, DataTexture, DoubleSide, LinearFilter, RGBAFormat, Group, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, NormalBlending, Sprite, SpriteNodeMaterial, Vector3, Vector4, type Node } from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cos,
  cross,
  exp,
  float,
  fract,
  hash,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  mrt,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionWorld,
  screenSize,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uniformArray,
  uv,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory, EnvironmentComponent } from '../../../sdk/types';
import { vec4At } from '../../creatures/rig';
import { colorUniform, floatUniform, seeded, zColor } from './common';
import { EruptionClock, craterShape, sampleSummit } from './eruptionClock';
import { makeBolt } from './lightningBolt';

// Colours go through colorUniform like every component (manifest hex is linearised twice), so
// the defaults below are lighter than the light they give.
const schema = z.object({
  /** Vent centre (x, z). Its height is read from the ground, so list this layer after the terrain. */
  vent: z.tuple([z.number(), z.number()]),
  /** Rim height override (world y); by default the mean rim height on the side facing the viewer. */
  rimY: z.number().optional(),
  /** Crater radius (world units): the vents lie inside it, the visible rim is searched within it. */
  crater: z.number().positive().default(30),
  /** Where the viewer stands (x, z): the flank facing it is where landing bombs are seen. */
  viewer: z.tuple([z.number(), z.number()]).default([0, 30]),
  /**
   * Fraction of the scene fog applied (0..1). The volcano sits far out in a dense haze; the glow
   * of an eruption carries further than the haze lets the ground show.
   */
  fog: z.number().min(0).max(1).default(0.4),
  bursts: z
    .object({
      /** Seconds between bursts [shortest, longest]; irregular, never on the beat. */
      interval: z.tuple([z.number().positive(), z.number().positive()]).default([6, 18]),
      /** Lava bombs in the largest burst (scaled with quality). */
      bombs: z.number().int().min(10).max(600).default(260),
      /** Typical apex above the rim for a full-size burst (world units). */
      height: z.number().positive().default(34),
      /** World units per second²: low for a big, distant mountain (bursts hang in the air). */
      gravity: z.number().positive().default(4.5),
      /** Jet cone half-angle (radians). */
      spread: z.number().min(0).max(1.3).default(0.55),
      /** Seconds of motion each glowing trail shows. */
      trail: z.number().min(0).max(2).default(0.2),
      /** Clast size (world units) before the minimum pixel width applies. */
      size: z.number().positive().default(0.45),
      /** Incandescence from fresh (yellow-white) through orange to deep red as it cools. */
      hot: zColor.default('#fff8e5'),
      warm: zColor.default('#ffd18e'),
      cool: zColor.default('#e3935e'),
      brightness: z.number().min(0).default(1),
      /** 0..1: how much a long intense music section swells bursts. */
      music: z.number().min(0).max(1).default(0.6),
      /** QUADs and perfect clears set off a big burst after a short delay. */
      clears: z.boolean().default(true),
    })
    .prefault({}),
  plume: z
    .object({
      /** Height the plume climbs before the wind bends it over, and how far it streams downwind. */
      height: z.number().positive().default(22),
      length: z.number().positive().default(320),
      /** Wind direction (x, z). */
      wind: z.tuple([z.number(), z.number()]).default([1, -0.35]),
      /** Plume width at the vent and at its far end. */
      width: z.tuple([z.number().positive(), z.number().positive()]).default([8, 44]),
      puffs: z.number().int().min(0).max(200).default(56),
      /** Seconds for the gas to travel the whole plume. */
      rise: z.number().positive().default(90),
      /** Underside lit by the crater, and the faint red light from the lava plain on the ash. */
      lit: zColor.default('#ffcc93'),
      ambient: zColor.default('#a0938b'),
      opacity: z.number().min(0).max(1).default(0.75),
      /** Distance from the crater over which its light on the ash fades. */
      litHeight: z.number().positive().default(12),
    })
    .prefault({}),
  glow: z.object({ color: zColor.default('#ffc385'), strength: z.number().min(0).default(1), size: z.number().positive().default(30) }).prefault({}),
  lightning: z
    .object({
      enabled: z.boolean().default(true),
      /** Chance that the largest burst is followed by a discharge in its ash. */
      chance: z.number().min(0).max(1).default(0.5),
      /** Minimum seconds between discharges. */
      cooldown: z.number().min(0).default(16),
      color: zColor.default('#faf9ff'),
      glow: zColor.default('#e8e3ff'),
      brightness: z.number().min(0).default(1),
      /** With flash reduction on: no lightning at all, or a dim single stroke. */
      reducedFlash: z.enum(['off', 'dim']).default('off'),
    })
    .prefault({}),
  bloom: z.number().min(0).default(0.3),
  seed: z.number().default(1),
});

type Params = z.infer<typeof schema>;
type F = Node<'float'>;
type V3 = Node<'vec3'>;

const TAU = Math.PI * 2;
/** Bursts that can be in the air at once (a ring of burst slots). */
const SLOTS = 4;
const TRAIL_SEGS = 6;
/** Pre-built bolt shapes. */
const BOLTS = 6;
/** Ash puffs thrown up by each burst. */
const BURST_PUFFS = 8;
/** Summit height texture: resolution and half-size (world units) around the vent. */
const SUMMIT_RES = 64;
const SUMMIT_REACH = 130;
/** Samples along each bomb's descent when finding where it lands. */
const MARCH = 12;
/** Resting bombs sit this far above the analytic ground (the drawn terrain is coarser). */
const LIFT = 0.9;
/** Lightning ribbon half-width in pixels (core plus glow). */
const BOLT_HALF_PX = 3.5;

/** Plume centreline at s (0 vent .. 1 far end), relative to the vent at rim height. */
export function plumeOffset(p: Params['plume'], s: number): [number, number, number] {
  const [wx, wz] = p.wind;
  const wl = Math.hypot(wx, wz) || 1;
  const h = (p.height * (1 - Math.exp(-4 * s))) / (1 - Math.exp(-4));
  const d = p.length * Math.pow(s, 1.35);
  return [(wx / wl) * d, h, (wz / wl) * d];
}

/**
 * A living Strombolian eruption at a volcano's summit. Bursts at irregular intervals throw
 * incandescent lava bombs on ballistic arcs: each glows yellow-white, cools through orange to
 * deep red, trails a short streak of its own motion, lands on the flank facing the viewer and
 * (the larger ones) rolls a little way down before fading. A dark ash plume rises from the
 * crater and bends over downwind, lit orange from below by the crater; each burst flares that
 * light and throws up its own billow of ash. Large bursts may charge the plume: a rare, brief
 * branching discharge flickers inside it and lights the ash around it, nothing else.
 *
 * Timing lives on the CPU (a few events a minute); every bomb, puff and bolt is computed on the
 * GPU from time, the burst slots and hashed randomness. Four draw calls in all.
 */
export const eruptionComponent: ComponentFactory<Params> = {
  type: 'eruption',
  version: 1,
  description: 'Strombolian eruption: ballistic cooling lava bombs, a crater-lit bent-over ash plume, rare volcanic lightning.',
  schema,
  create(ctx, p) {
    const rand = seeded(p.seed * 6151 + 7);
    const [vx, vz] = p.vent;
    const height = (x: number, zz: number): number => ctx.ground.height(x, zz);
    const crater = craterShape(height, p.vent, p.crater, p.viewer);
    const rimY = p.rimY ?? crater.rimY;
    // The summit's heights in a small texture: bombs land on the ground the terrain draws.
    const summit = sampleSummit(height, p.vent, SUMMIT_REACH, SUMMIT_RES);
    const summitTex = new DataTexture(summit.bytes, SUMMIT_RES, SUMMIT_RES, RGBAFormat);
    summitTex.minFilter = LinearFilter;
    summitTex.magFilter = LinearFilter;
    summitTex.needsUpdate = true;
    const groundAt = (xz: Node<'vec2'>): F => {
      const q = xz.sub(vec2(vx, vz)).div(2 * SUMMIT_REACH).add(0.5);
      return texture(summitTex, q).level(float(0)).r.mul(summit.max - summit.min).add(summit.min) as F;
    };
    const reduced = ctx.quality.reducedMotion;
    const detail = ctx.quality.detail === 'low' ? 0.4 : ctx.quality.detail === 'medium' ? 0.7 : ctx.quality.detail === 'high' ? 1 : 1.3;
    const time = ctx.uniforms.time;
    const pixelAt = (dist: F): F => {
      // Projection [1][1] = 1 / tan(fov / 2): world size of one pixel at this distance.
      const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
      return dist.mul(2).div(p11.mul(screenSize.y)) as F;
    };
    // Haze: a fraction of the scene's fog (transmittance for light, mix for the dark ash).
    const haze = (): F => {
      const d = length(positionWorld.sub(cameraPosition)).mul(ctx.uniforms.fogDensity).mul(p.fog);
      return exp(d.mul(d).negate()) as F;
    };

    const slotValues = Array.from({ length: SLOTS }, () => new Vector4(-1e4, 0, 0, 0));
    const slots = uniformArray(slotValues, 'vec4');
    const u = {
      presence: floatUniform(1),
      glow: floatUniform(p.glow.strength),
      plume: floatUniform(p.plume.opacity),
      crater: floatUniform(0.6),
      boltLight: uniform(new Vector4(0, -1e4, 0, 0)),
      strokes: uniform(new Vector3(0, 0, 0)),
      boltIndex: floatUniform(-1),
      boltSeed: floatUniform(0),
      boltOrigin: uniform(new Vector3()),
      boltX: uniform(new Vector3(1, 0, 0)),
      boltY: uniform(new Vector3(0, 1, 0)),
      boltZ: uniform(new Vector3(0, 0, 1)),
      boltIntensity: floatUniform(0),
    };
    // The plume leaves the vent below the rim and is first seen as it clears it.
    const vent0 = vec3(vx, rimY - 6, vz);
    const g = p.bursts.gravity;

    // ---------------------------------------------------------------- Lava bombs.
    const perBurst = Math.max(12, Math.round(p.bursts.bombs * detail));
    const bombCount = perBurst * SLOTS;
    const vertsPer = (TRAIL_SEGS + 1) * 2;
    const bPos = new Float32Array(bombCount * vertsPer * 3);
    const bData = new Float32Array(bombCount * vertsPer * 4);
    const bIndex: number[] = [];
    for (let b = 0; b < bombCount; b++) {
      const slot = b % SLOTS;
      const local = Math.floor(b / SLOTS);
      // Static per bomb: its rank in the burst (small bursts use the first ranks) and its bulk.
      const rank = rand();
      const bulk = Math.pow(rand(), 2.2);
      const extra = rand();
      for (let i = 0; i <= TRAIL_SEGS; i++) {
        for (let s = 0; s < 2; s++) {
          const v = (b * vertsPer + i * 2 + s) as number;
          bPos.set([i / TRAIL_SEGS, s === 0 ? -1 : 1, slot], v * 3);
          bData.set([local, rank, bulk, extra], v * 4);
        }
      }
      const base = b * vertsPer;
      for (let i = 0; i < TRAIL_SEGS; i++) {
        const a = base + i * 2;
        bIndex.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const bombGeo = new BufferGeometry();
    bombGeo.setAttribute('position', new BufferAttribute(bPos, 3));
    bombGeo.setAttribute('bomb', new BufferAttribute(bData, 4));
    bombGeo.setIndex(bIndex);

    const pg = positionGeometry;
    const bomb = attribute<'vec4'>('bomb', 'vec4');
    const vHeat = varyingProperty('float', 'vBombHeat');
    const vCover = varyingProperty('float', 'vBombCover');
    const vLive = varyingProperty('float', 'vBombLive');
    const vBulk = varyingProperty('float', 'vBombBulk');
    const bombPosition = Fn(() => {
      const t = time as unknown as F;
      const st = vec4At(slots, pg.z.toInt());
      const start = st.x;
      const size = st.y;
      const id = st.z;
      // Hashes per bomb per burst (integer-valued seeds below 2^24).
      const key = bomb.x.add(id.mul(787)).mul(13);
      const h = (k: number): F => hash(key.add(k)) as F;
      const bk = id.mul(31);
      const hb = (k: number): F => hash(bk.add(k)) as F;
      const live = step(bomb.y, mix(float(0.22), float(1), size));
      const bulk = bomb.z;
      // Ejection is spread over the burst, most of it early.
      const t0 = start.add(h(1).pow(2).mul(size.mul(2.6).add(0.5)));
      const tau = t.sub(t0);
      const vmax = float(Math.sqrt(2 * g * p.bursts.height)).mul(size.mul(0.4).add(0.7));
      const speed = vmax.mul(h(2).pow(0.6).mul(0.72).add(0.28)).mul(float(1).sub(bulk.mul(0.25)));
      // Each burst has its own vent in the crater and its own slightly tilted jet.
      const axisAz = hb(7).mul(TAU);
      const axisTilt = hb(8).mul(0.32);
      const coneA = sqrt(h(3)).mul(p.bursts.spread);
      const phi = h(4).mul(TAU);
      const dir = normalize(vec3(sin(coneA).mul(cos(phi)).add(axisTilt.mul(cos(axisAz))), cos(coneA), sin(coneA).mul(sin(phi)).add(axisTilt.mul(sin(axisAz)))));
      const horiz = max(length(dir.xz), 1e-4);
      const dirH = dir.xz.div(horiz);
      const vh = speed.mul(horiz);
      const vy = speed.mul(dir.y);
      const ventOff = vec2(hb(9).sub(0.5), hb(10).sub(0.5)).mul(p.crater * 0.5);
      const y0 = float(crater.floorY + 1.5);
      const p0xz = vec2(vx, vz).add(ventOff);
      const yAt = (tt: F): F => y0.add(vy.mul(tt)).sub(tt.mul(tt).mul(0.5 * g)) as F;
      const xzAt = (tt: F): Node<'vec2'> => p0xz.add(dirH.mul(vh.mul(tt)));
      // Landing: march the descending half of the arc over the summit's height texture, then
      // interpolate the crossing.
      const tApex = max(vy.div(g), 0) as F;
      const tFall = vy.add(sqrt(max(vy.mul(vy).add(float(2 * g).mul(y0.sub(summit.min - 5))), 0))).div(g) as F;
      let prevT: F = tApex;
      let prevGap: F = yAt(tApex).sub(groundAt(xzAt(tApex))) as F;
      let found: F = step(prevGap, 0) as F;
      let tLand: F = select(found.greaterThan(0.5), tApex, tFall) as F;
      for (let i = 1; i <= MARCH; i++) {
        const ti = tApex.add(tFall.sub(tApex).mul(i / MARCH)) as F;
        const gi = yAt(ti).sub(groundAt(xzAt(ti))) as F;
        const hit = float(1).sub(found).mul(step(gi, 0));
        const tc = prevT.add(ti.sub(prevT).mul(prevGap.div(max(prevGap.sub(gi), 1e-4))));
        tLand = select(hit.greaterThan(0.5), tc, tLand) as F;
        found = max(found, hit) as F;
        prevT = ti;
        prevGap = gi;
      }
      const landXZ = xzAt(tLand);
      // Bombs falling back into the crater are hidden by the rim and simply go out.
      const inCrater = step(length(landXZ.sub(vec2(vx, vz))), p.crater * 0.9);
      // The bulkier ones roll a short way down the slope after landing (if it falls away).
      const downhill = step(groundAt(landXZ.add(dirH.mul(3))), groundAt(landXZ).sub(0.4));
      const rollLen = float(1).sub(inCrater).mul(downhill).mul(bulk.mul(bulk).mul(14).add(bulk.mul(2)));
      const at = (ts: F): V3 => {
        const tf = min(ts, tLand) as F;
        const fxz = xzAt(tf);
        const flight = vec3(fxz.x, yAt(tf), fxz.y);
        const tr = max(ts.sub(tLand), 0);
        const roll = rollLen.mul(float(1).sub(exp(tr.div(-1.1))));
        const rxz = landXZ.add(dirH.mul(roll));
        return select(ts.lessThan(tLand), flight, vec3(rxz.x, groundAt(rxz).add(LIFT), rxz.y)) as V3;
      };
      // Cooling: small spatter dims within a couple of seconds, big bombs glow on the slope.
      const tc = mix(float(1.4), float(8.5), bulk);
      const heatAt = (ts: F): F => exp(ts.div(tc).negate()).mul(float(1).sub(inCrater.mul(smoothstep(0, 0.5, ts.sub(tLand))))) as F;
      const along = pg.x;
      const side = pg.y;
      const ts = max(tau.sub(along.mul(p.bursts.trail)), 0) as F;
      const pos = at(ts);
      const prev = at(max(ts.sub(0.03), 0) as F);
      const step3 = pos.sub(prev);
      const sl = length(step3);
      const tdir = select(sl.greaterThan(1e-5), step3.div(max(sl, 1e-5)), vec3(0, 1, 0)) as V3;
      const toCam = cameraPosition.sub(pos);
      const pixel = pixelAt(length(toCam));
      const trueW = float(p.bursts.size).mul(bulk.mul(1.6).add(0.45));
      const drawW = max(trueW, pixel.mul(1.6));
      const across = normalize(cross(tdir, toCam));
      // Round the ends: the head reaches forward and the tail back by half a width.
      const cap = select(along.lessThan(0.001), float(0.5), select(along.greaterThan(0.999), float(-0.5), float(0)));
      const alive = live.mul(step(0, tau)).mul(u.presence);
      vHeat.assign(heatAt(ts));
      vCover.assign(trueW.div(drawW));
      vLive.assign(alive);
      vBulk.assign(bulk);
      return pos.add(across.mul(side.mul(drawW).mul(0.5).mul(alive))).add(tdir.mul(cap.mul(drawW).mul(alive)));
    })();
    const hot = colorUniform(p.bursts.hot);
    const warm = colorUniform(p.bursts.warm);
    const cool = colorUniform(p.bursts.cool);
    const heat = vHeat.clamp(0, 1);
    const incandescence = mix(mix(cool, warm, smoothstep(0.12, 0.5, heat)), hot, smoothstep(0.5, 0.95, heat));
    // A bright head with a fading streak behind it; the bulky clasts are much brighter than spatter.
    const tail = exp(pg.x.mul(-3)).mul(0.8).add(0.2);
    const bulkLight = vBulk.mul(2.4).add(0.35);
    const crossSection = exp(pg.y.mul(pg.y).mul(-3.5));
    const bombLight = incandescence
      .mul(heat.pow(2.2).mul(7 * p.bursts.brightness))
      .mul(vCover)
      .mul(bulkLight)
      .mul(tail)
      .mul(crossSection)
      .mul(vLive)
      .mul(haze()) as V3;
    const bombMat = new MeshBasicNodeMaterial();
    bombMat.positionNode = bombPosition;
    bombMat.colorNode = vec4(bombLight, 1);
    bombMat.mrtNode = mrt({ emissive: vec4(bombLight.mul(p.bloom), 1) });
    bombMat.transparent = true;
    bombMat.depthWrite = false;
    bombMat.blending = AdditiveBlending;
    bombMat.side = DoubleSide;
    bombMat.fog = false;
    const bombs = new Mesh(bombGeo, bombMat);
    bombs.frustumCulled = false;
    bombs.renderOrder = -2;

    // ---------------------------------------------------------------- Ash plume.
    const [wx, wz] = p.plume.wind;
    const wl = Math.hypot(wx, wz) || 1;
    const wind = vec3(wx / wl, 0, wz / wl);
    const perp = vec3(-wz / wl, 0, wx / wl);
    const litC = colorUniform(p.plume.lit);
    const ambient = colorUniform(p.plume.ambient);
    const fogC = colorUniform(ctx.palette.fog);
    const boltGlowC = colorUniform(p.lightning.glow);
    const plumeH = p.plume.height;
    const plumeL = p.plume.length;
    const [w0, w1] = p.plume.width;
    /** Shading shared by steady and burst puffs: noisy soft billows lit from below. */
    const puffMaterial = (centre: V3, diameter: F, alpha: F, seed: F, spin: F): SpriteNodeMaterial => {
      const q = uv().sub(0.5);
      const ca = cos(spin);
      const sa = sin(spin);
      const rq = vec2(q.x.mul(ca).sub(q.y.mul(sa)), q.x.mul(sa).add(q.y.mul(ca)));
      const evolve = time.mul(0.025).add(seed.mul(17.3));
      const n1 = mx_noise_float(vec3(rq.mul(3.4), evolve));
      const n2 = mx_noise_float(vec3(rq.mul(8.1).add(4.1), evolve.mul(1.7)));
      const n3 = mx_noise_float(vec3(rq.mul(17.0).add(9.7), evolve.mul(2.3)));
      const r = length(q);
      // Cauliflower billows: the edge is eaten by noise, the inside varies in density.
      const blob = smoothstep(0.5, 0.18, r.add(n1.mul(0.16)).add(n2.mul(0.07)).add(n3.mul(0.03)));
      const billow = n1.mul(0.6).add(n2.mul(0.3)).add(n3.mul(0.15)).add(0.7).clamp(0.1, 1.4);
      const fromCrater = length(centre.sub(vec3(vx, rimY - 2, vz)));
      // Light from the crater falls on the underside of each billow and fades fast with distance.
      const under = smoothstep(0.9, 0.0, uv().y).pow(1.5).mul(0.85).add(0.15);
      const craterLight = litC.mul(u.crater.mul(u.glow)).mul(exp(fromCrater.div(-p.plume.litHeight))).mul(under).mul(billow.mul(billow));
      const toBolt = length(centre.sub(u.boltLight.xyz));
      const boltLit = boltGlowC.mul(u.boltLight.w).mul(exp(toBolt.div(20).pow(2).negate())).mul(billow).mul(0.6);
      const lit = ambient.mul(billow).mul(under.mul(0.5).add(0.55)).add(craterLight).add(boltLit);
      const tHaze = haze();
      const material = new SpriteNodeMaterial();
      material.positionNode = centre;
      material.scaleNode = diameter;
      material.colorNode = vec4(mix(fogC, lit, tHaze), blob.mul(alpha).mul(u.presence).clamp(0, 1));
      material.mrtNode = mrt({ emissive: vec4(craterLight.add(boltLit).mul(0.15).mul(tHaze), blob.mul(alpha).mul(u.presence).clamp(0, 1)) });
      material.transparent = true;
      material.depthWrite = false;
      material.blending = NormalBlending;
      material.fog = false;
      return material;
    };
    const group = new Group();
    const disposables: { dispose(): void }[] = [bombGeo, bombMat, summitTex];
    const puffCount = Math.round(p.plume.puffs * (detail > 1 ? 1.15 : detail));
    if (puffCount > 0) {
      const seeds = new Float32Array(puffCount * 4);
      for (let i = 0; i < puffCount; i++) seeds.set([(i + rand() * 0.6) / puffCount, rand(), rand(), rand()], i * 4);
      const sA = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(seeds, 4), 'vec4');
      const riseT = reduced ? ctx.uniforms.time.mul(0.6) : ctx.uniforms.time;
      const age = fract(riseT.div(p.plume.rise).add(sA.x));
      const s = age;
      const ch = float(plumeH).mul(float(1).sub(exp(s.mul(-4)))).div(1 - Math.exp(-4));
      const cd = float(plumeL).mul(s.pow(1.35));
      const radius = float(w0).add(float(w1 - w0).mul(sqrt(s)));
      const wob = sin(time.mul(0.06).add(sA.w.mul(40)));
      const off = perp
        .mul(sA.y.sub(0.5).mul(radius).mul(1.1))
        .add(vec3(0, 1, 0).mul(sA.z.sub(0.5).mul(radius).mul(0.7)))
        .add(wind.mul(wob.mul(radius).mul(0.15)));
      const centre = vent0.add(vec3(0, 1, 0).mul(ch)).add(wind.mul(cd)).add(off) as V3;
      const diameter = radius.mul(sA.w.mul(0.6).add(1.25)) as F;
      // Dense at the vent, thinning as it spreads; born and lost softly.
      const alpha = smoothstep(0, 0.05, age).mul(float(1).sub(smoothstep(0.55, 1, age))).mul(mix(float(1), float(0.4), s)).mul(u.plume) as F;
      const mat = puffMaterial(centre, diameter, alpha, sA.w, sA.y.mul(TAU).add(time.mul(0.01)));
      const sprite = new Sprite(mat);
      sprite.count = puffCount;
      sprite.frustumCulled = false;
      sprite.renderOrder = -11;
      group.add(sprite);
      disposables.push(mat, sprite.geometry);
    }
    {
      // Billows thrown up by each burst, rising fast, slowing, then joining the plume.
      const n = SLOTS * BURST_PUFFS;
      const seeds = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) seeds.set([i % SLOTS, Math.floor(i / SLOTS) / BURST_PUFFS, rand(), rand()], i * 4);
      const sB = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(seeds, 4), 'vec4');
      const st = vec4At(slots, sB.x.toInt());
      const size = st.y;
      const tau = time.sub(st.x).sub(sB.y.mul(1.6));
      const life = 22;
      const rise = float(plumeH * 0.85).mul(size.mul(0.6).add(0.4)).mul(float(1).sub(exp(tau.div(-3.2))));
      const drift = wind.mul(tau.mul(tau).div(tau.add(9)).mul(plumeL / p.plume.rise));
      const radius = float(4).add(float(w0 * 1.6).mul(float(1).sub(exp(tau.div(-5)))).mul(size.mul(0.5).add(0.5)));
      const off = perp.mul(sB.z.sub(0.5).mul(radius)).add(vec3(0, sB.w.sub(0.5).mul(radius).mul(0.8), 0));
      const centre = vent0.add(vec3(0, 1, 0).mul(rise)).add(drift).add(off) as V3;
      const alpha = smoothstep(0, 0.6, tau).mul(float(1).sub(smoothstep(life * 0.35, life, tau))).mul(size.mul(0.5).add(0.3)).mul(u.plume).mul(step(tau, life)) as F;
      const mat = puffMaterial(centre, radius.mul(1.9) as F, alpha, sB.z.add(sB.x), sB.w.mul(TAU));
      const sprite = new Sprite(mat);
      sprite.count = n;
      sprite.frustumCulled = false;
      sprite.renderOrder = -11;
      group.add(sprite);
      disposables.push(mat, sprite.geometry);
    }

    // ---------------------------------------------------------------- Crater glow.
    {
      const glowMat = new SpriteNodeMaterial();
      const q = uv().sub(0.5).mul(vec2(1, 1.7));
      const r = length(q).mul(2);
      const shape = exp(r.mul(r).mul(-4.5));
      const light = colorUniform(p.glow.color).mul(shape).mul(u.crater).mul(u.glow).mul(0.55).mul(u.presence).mul(haze()) as V3;
      glowMat.positionNode = vec3(vx, rimY + 1, vz);
      glowMat.scaleNode = vec2(p.glow.size * 2, p.glow.size * 2 / 1.7);
      glowMat.colorNode = vec4(light, 1);
      glowMat.mrtNode = mrt({ emissive: vec4(light.mul(0.2), 1) });
      glowMat.transparent = true;
      glowMat.depthWrite = false;
      glowMat.blending = AdditiveBlending;
      glowMat.fog = false;
      const glow = new Sprite(glowMat);
      glow.frustumCulled = false;
      glow.renderOrder = -10;
      group.add(glow);
      disposables.push(glowMat, glow.geometry);
    }
    group.add(bombs);

    // ---------------------------------------------------------------- Lightning.
    const lightningOn = p.lightning.enabled && p.lightning.brightness > 0;
    if (lightningOn) {
      const lPos: number[] = [];
      const lA: number[] = [];
      const lB: number[] = [];
      const lIndex: number[] = [];
      for (let k = 0; k < BOLTS; k++) {
        for (const seg of makeBolt(rand)) {
          const base = lPos.length / 3;
          for (const [end, side] of [
            [0, -1],
            [0, 1],
            [1, -1],
            [1, 1],
          ] as const) {
            lPos.push(end, side, k);
            lA.push(...seg.a, seg.level);
            lB.push(...seg.b, seg.branch);
          }
          lIndex.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
      const boltGeo = new BufferGeometry();
      boltGeo.setAttribute('position', new BufferAttribute(new Float32Array(lPos), 3));
      boltGeo.setAttribute('segA', new BufferAttribute(new Float32Array(lA), 4));
      boltGeo.setAttribute('segB', new BufferAttribute(new Float32Array(lB), 4));
      boltGeo.setIndex(lIndex);
      const segA = attribute<'vec4'>('segA', 'vec4');
      const segB = attribute<'vec4'>('segB', 'vec4');
      const vHalfPx = varyingProperty('float', 'vBoltHalfPx');
      const vBolt = varyingProperty('float', 'vBoltLight');
      const boltPosition = Fn(() => {
        const toWorld = (v: V3): V3 => u.boltOrigin.add(u.boltX.mul(v.x)).add(u.boltY.mul(v.y)).add(u.boltZ.mul(v.z)) as V3;
        const a = toWorld(segA.xyz as V3);
        const b = toWorld(segB.xyz as V3);
        const end = pg.x;
        const side = pg.y;
        const shown = step(abs(pg.z.sub(u.boltIndex)), 0.5);
        const level = segA.w;
        const branch = segB.w;
        // Each return stroke re-lights the main channel; branches come and go between strokes.
        const vis = (k: number): F => select(level.lessThan(0.5), float(1), step(hash(branch.add(u.boltSeed.mul(17)).add(k * 101)), 0.62)) as F;
        const strength = u.strokes.x.mul(vis(0)).add(u.strokes.y.mul(vis(1))).add(u.strokes.z.mul(vis(2)));
        const levelK = select(level.lessThan(0.5), float(1), select(level.lessThan(1.5), float(0.5), float(0.3)));
        const P = mix(a, b, end);
        const dir = normalize(b.sub(a));
        const toCam = cameraPosition.sub(P);
        const pixel = pixelAt(length(toCam));
        const halfW = pixel.mul(BOLT_HALF_PX).mul(shown);
        const across = normalize(cross(dir, toCam));
        vHalfPx.assign(float(BOLT_HALF_PX));
        vBolt.assign(strength.mul(levelK).mul(shown));
        return P.add(across.mul(side.mul(halfW))).add(dir.mul(end.sub(0.5).mul(2).mul(pixel).mul(shown)));
      })();
      const x = abs(pg.y).mul(vHalfPx);
      const coreC = colorUniform(p.lightning.color);
      // A crisp channel about a pixel wide in a faint, tight glow.
      const profileI = coreC.mul(exp(x.div(0.65).pow(2).negate()).mul(2.6)).add(boltGlowC.mul(exp(x.div(1.7).pow(2).negate()).mul(0.22)));
      const boltLight = profileI.mul(vBolt).mul(u.boltIntensity).mul(u.presence).mul(haze()) as V3;
      const boltMat = new MeshBasicNodeMaterial();
      boltMat.positionNode = boltPosition;
      boltMat.colorNode = vec4(boltLight, 1);
      boltMat.mrtNode = mrt({ emissive: vec4(boltLight.mul(0.25), 1) });
      boltMat.transparent = true;
      boltMat.depthWrite = false;
      boltMat.blending = AdditiveBlending;
      boltMat.side = DoubleSide;
      boltMat.fog = false;
      const bolts = new Mesh(boltGeo, boltMat);
      bolts.frustumCulled = false;
      bolts.renderOrder = -2;
      group.add(bolts);
      disposables.push(boltGeo, boltMat);
    }

    // ---------------------------------------------------------------- Timing (CPU, per event).
    const clock = new EruptionClock(seeded(p.seed * 7919 + 3), {
      interval: reduced ? [p.bursts.interval[0] * 1.5, p.bursts.interval[1] * 1.5] : p.bursts.interval,
      music: p.bursts.music,
      lightningChance: lightningOn ? p.lightning.chance : 0,
      cooldown: p.lightning.cooldown,
    });
    const eventRand = seeded(p.seed * 104729 + 1);
    let cursor = 0;
    let burstId = 1;
    let bolt: { start: number; strokes: number[]; size: number; centre: Vector3 } | null = null;
    const place = (size: number, start: number): void => {
      const slot = slotValues[cursor++ % SLOTS] as Vector4;
      slot.set(start, Math.min(1, Math.max(0.1, size * (reduced ? 0.7 : 1))), burstId, 0);
      burstId = (burstId % 996) + 1;
    };
    const strike = (size: number, strokes: number, start: number): void => {
      // Inside the lower plume: just above the crater or a little way downwind in the ash.
      const s = 0.02 + eventRand() * 0.16;
      const o = plumeOffset(p.plume, s);
      const span = 10 + eventRand() * 16 * (0.5 + size * 0.5);
      const centre = new Vector3(vx + o[0] + (eventRand() - 0.5) * 12, rimY + o[1] + 2 + eventRand() * 10, vz + o[2] + (eventRand() - 0.5) * 8);
      // A random orientation, from steep to nearly horizontal (discharges inside the ash cloud).
      const yaw = eventRand() * TAU;
      const tilt = (0.25 + eventRand() * 1.0) * (eventRand() < 0.5 ? -1 : 1);
      const down = new Vector3(Math.sin(tilt) * Math.cos(yaw), -Math.cos(tilt), Math.sin(tilt) * Math.sin(yaw)).normalize();
      const side = new Vector3(0, 1, 0).cross(down);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const fwd = new Vector3().crossVectors(down, side).normalize();
      // The unit bolt runs along -y: map its y to -down, so it grows from the origin along `down`.
      u.boltX.value.copy(side).multiplyScalar(span);
      u.boltY.value.copy(down).multiplyScalar(-span);
      u.boltZ.value.copy(fwd).multiplyScalar(span);
      u.boltOrigin.value.copy(centre).addScaledVector(down, -span * 0.5);
      u.boltIndex.value = Math.floor(eventRand() * BOLTS);
      u.boltSeed.value = Math.floor(eventRand() * 1000);
      const times = [0];
      if (strokes > 1) times.push(0.06 + eventRand() * 0.06);
      if (strokes > 2) times.push(0.17 + eventRand() * 0.12);
      bolt = { start, strokes: times, size, centre };
    };
    return {
      object: group,
      reactive: { glow: u.glow, plume: u.plume },
      update(frame) {
        const now = frame.time;
        const flashReduced = ctx.uniforms.flashLimit.value < 0.99;
        const allowBolt = lightningOn && (!flashReduced || p.lightning.reducedFlash === 'dim');
        for (const e of clock.update(now, frame.dt, frame.audio.sectionIntensity, allowBolt)) {
          if (e.kind === 'burst') place(e.size, e.time);
          else strike(e.size, flashReduced ? 1 : e.strokes, e.time);
        }
        // Crater light: a slow, uneven breathing of the lava lake, flared by each burst.
        let flare = 0;
        for (const s of slotValues) {
          const dt = now - s.x;
          if (dt > 0 && dt < 14) flare += s.y * Math.min(1, dt / 0.25) * Math.exp(-dt / 2.4);
        }
        const breath = 0.3 + 0.05 * Math.sin(now * 0.37) + 0.035 * Math.sin(now * 1.13 + 1.7) + 0.02 * Math.sin(now * 2.9 + 0.4);
        u.crater.value = breath + Math.min(1.6, flare * 1.2);
        // Lightning strokes: each a sharp onset and a fast decay (tens of milliseconds).
        let total = 0;
        const st = [0, 0, 0];
        if (bolt) {
          const dt = now - bolt.start;
          bolt.strokes.forEach((t0, k) => {
            const d = dt - t0;
            st[k] = d >= 0 ? Math.exp(-d / 0.04) : 0;
            total += st[k] as number;
          });
          if (dt > 0.6) bolt = null;
        }
        const dim = flashReduced ? 0.3 : 1;
        u.strokes.value.set(st[0] as number, st[1] as number, st[2] as number);
        u.boltIntensity.value = p.lightning.brightness * dim * (bolt ? 0.6 + 0.4 * bolt.size : 0);
        if (bolt) u.boltLight.value.set(bolt.centre.x, bolt.centre.y, bolt.centre.z, Math.min(1.5, total) * 1.4 * dim * p.lightning.brightness);
        else u.boltLight.value.w = 0;
      },
      onGameEvent(e) {
        if (p.bursts.clears && e.kind === 'clear' && (e.lines >= 4 || e.perfectClear)) clock.bigClear(ctx.uniforms.time.value);
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        for (const d of disposables) d.dispose();
      },
      // Previews and captures: set off a burst or a discharge now.
      trigger(kind: 'burst' | 'lightning', size = 1) {
        clock.trigger(kind, ctx.uniforms.time.value, size);
      },
    } satisfies EnvironmentComponent & { trigger(kind: 'burst' | 'lightning', size?: number): void };
  },
};
