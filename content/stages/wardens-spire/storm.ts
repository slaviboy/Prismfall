import { AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  attribute,
  cameraPosition,
  clamp,
  cross,
  dot,
  exp,
  float,
  fract,
  mix,
  mrt,
  normalize,
  positionLocal,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { additiveFog, colorUniform, seeded, z, zColor, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { COLORS, DEG, EYE, beamField, clearMask, noise3D, release, shared, type V3 } from './shared';

/**
 * The storm over the Warden's Spire: a deck of heavy cloud raymarched through tileable 3D noise
 * (billowing undersides, slow drift, depth), lit from below by the lava-red land, by the Warden's
 * core (a glowing pool over the summit that spreads when it wakes), by its beam where it passes
 * and by lightning inside the clouds. Rare cloud-to-ground bolts strike far out on either side,
 * never inside the clear zone around the board. With flash reduction there are no bolts and the
 * flashes swell slowly and stay dim; the light is always local, never the whole screen.
 */

const schema = z.object({
  /** Cloud base (m above the board) and the deck's thickness. */
  base: z.number().default(420),
  thickness: z.number().default(900),
  /** 0..1 how much of the sky the deck covers. */
  coverage: z.number().min(0).max(1).default(0.72),
  density: z.number().default(1),
  /** Wind (m/s, x and z). */
  wind: z.tuple([z.number(), z.number()]).default([5, -2]),
  /** Colours: the clouds' own dark tone, the red light from the land, the far haze. */
  ambient: zColor.default('#0a0707'),
  under: zColor.default('#ff3a12'),
  haze: zColor.default('#4a1c12'),
  underGlow: z.number().default(0.3),
  /** How much the far clouds' undersides catch the horizon's glow. */
  horizonLight: z.number().default(1.4),
  /** Where the deck thins near the horizon (m): brighter gaps show the far land. */
  fade: z.tuple([z.number(), z.number()]).default([9000, 24000]),
  lightning: z
    .object({
      /** Mean seconds between strikes (calm and intense storm). */
      every: z.tuple([z.number(), z.number()]).default([22, 9]),
      /** View azimuth bands (degrees) where strikes may happen (mirrored left). */
      azimuth: z.tuple([z.number(), z.number()]).default([25, 46]),
      distance: z.tuple([z.number(), z.number()]).default([1800, 6000]),
      /** Share of strikes that show a bolt to the ground. */
      bolts: z.number().min(0).max(1).default(0.45),
      brightness: z.number().default(1),
    })
    .prefault({}),
  seed: z.number().default(31),
});

type Params = z.infer<typeof schema>;

const MAX_BOLT_SEGMENTS = 220;

export const stormComponent: ComponentFactory<Params> = {
  type: 'wardenSpireStorm',
  version: 1,
  description: 'Massive raymarched storm clouds lit red from below, by the Warden and by distant lightning (flash-reduction aware).',
  schema,
  async create(ctx: EnvironmentContext, p: Params) {
    const s = shared(ctx);
    const noise = await noise3D(s);
    const group = new Group();
    group.name = 'wardens-spire-storm';
    const presence = uniform(1);
    const storm = uniform(0.5);
    const time = ctx.uniforms.time;
    const steps = ctx.quality.detail === 'low' ? 10 : ctx.quality.detail === 'medium' ? 14 : ctx.quality.detail === 'high' ? 20 : 28;
    const ambient = colorUniform(p.ambient);
    const under = colorUniform(p.under);
    const haze = colorUniform(p.haze);
    const disposables: { dispose(): void }[] = [];

    const clouds = Fn(() => {
      const o = cameraPosition;
      const v = normalize(positionWorld.sub(o));
      const col = vec3(0, 0, 0).toVar();
      const T = float(1).toVar();
      const tFirst = float(0).toVar();
      If(v.y.greaterThan(0.004), () => {
        const t0 = float(p.base - 240).sub(o.y).div(v.y).max(0);
        const t1 = float(p.base + p.thickness).sub(o.y).div(v.y).min(t0.add(3400)).min(30000);
        tFirst.assign(t0);
        const dt = t1.sub(t0).div(steps);
        const ign = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));
        const wind = vec3(time.mul(p.wind[0]), 0, time.mul(p.wind[1]));
        const coreLift = float(1).add(s.u.awaken.mul(4.5));
        const coreR2 = float(160 * 160).mul(float(1).add(s.u.awaken.mul(22)));
        const mask = clearMask(o.add(v.mul(t0.add(dt.mul(steps / 2)))));
        const horizon = exp(v.y.div(-0.09));
        Loop(steps, ({ i }) => {
          const t = t0.add(dt.mul(float(i).add(ign.mul(0.7).add(0.15))));
          const P = o.add(v.mul(t));
          const q = P.add(wind);
          const big = texture3D(noise, q.div(3800)).r;
          const midN = texture3D(noise, q.div(1300).add(vec3(0.31, 0.17, 0.53))).r;
          const det = texture3D(noise, q.div(380).add(vec3(time.mul(0.0006), 0, 0))).g;
          // A heavy, lumpy base: big rolls, smaller pouches hanging under them.
          const baseY = float(p.base).add(big.sub(0.5).mul(320)).add(midN.sub(0.5).mul(150)).sub(det.sub(0.5).mul(50));
          const hf = P.y.sub(baseY).div(p.thickness);
          const prof = smoothstep(0, 0.05, hf).mul(smoothstep(1, 0.3, hf));
          const shape = big.mul(0.45).add(midN.mul(0.55));
          const cov = float(p.coverage).add(storm.mul(0.12)).add(smoothstep(3000, 9000, t).mul(0.12));
          const d0 = clamp(shape.sub(float(1).sub(cov)).div(cov.mul(0.55).max(0.05)), 0, 1).mul(prof);
          // Edges eroded by the finer noise; the inside stays solid.
          const dens = clamp(d0.sub(float(1).sub(d0).mul(det).mul(0.45)), 0, 1).mul(p.density);
          If(dens.greaterThan(0.002), () => {
            const depthIn = P.y.sub(baseY).max(0);
            // Light from below reaches only the underside; the lower pouches catch the most.
            const fromBelow = exp(depthIn.div(-70)).mul(exp(P.y.sub(p.base - 220).max(0).div(-420)));
            // Red light from the land below, patchy like the lava fields under it.
            const field = texture3D(noise, vec3(P.x.div(2600), P.z.div(2600), 0.41)).a;
            const patch = smoothstep(0.35, 0.8, field).mul(1.1).add(0.25);
            let light: V3 = under.mul(fromBelow.mul(patch).mul(p.underGlow).mul(s.u.lavaHeat)) as unknown as V3;
            // The Warden's core: a pool of fire-light on the deck above the summit.
            const lc = s.u.core.sub(P);
            const coreAmt = s.u.coreGlow.mul(coreLift).mul(float(90000)).div(dot(lc, lc).add(coreR2)).mul(fromBelow.mul(0.8).add(0.2));
            light = light.add(COLORS.core.mul(coreAmt)) as V3;
            // The beam where it passes through or under the deck.
            light = light.add(COLORS.beam.mul(beamField(s, P).mul(1.6)).mul(mask)) as V3;
            // Lightning inside the cloud.
            const lb = s.u.boltPos.sub(P);
            const boltAmt = s.u.boltPower.mul(float(3.4e5)).div(dot(lb, lb).add(2.2e5));
            light = light.add(COLORS.bolt.mul(boltAmt.mul(mask))) as V3;
            // Far clouds catch the glow along the horizon on their undersides.
            const rim = smoothstep(2000, 9000, t).mul(fromBelow.mul(0.7).add(0.3)).mul(horizon);
            light = light.add(haze.mul(rim.mul(p.horizonLight))) as V3;
            light = light.add(ambient) as V3;
            const sigma = dens.mul(0.0055);
            const Ts = exp(sigma.mul(dt).negate());
            col.addAssign(light.mul(T.mul(float(1).sub(Ts))));
            T.mulAssign(Ts);
          });
          If(T.lessThan(0.015), () => {
            Break();
          });
        });
      });
      // Aerial perspective: the far deck fades into the red haze, and thins near the horizon
      // (gaps show the land beyond).
      const air = smoothstep(1500, 7500, tFirst);
      const far = smoothstep(p.fade[0], p.fade[1], tFirst);
      const alpha = float(1).sub(T).mul(float(1).sub(far.mul(0.7)));
      const outCol = mix(col, haze.mul(float(1).sub(T)), air.mul(0.85));
      return vec4(outCol.mul(presence), alpha.mul(presence));
    });

    const domeMat = new MeshBasicNodeMaterial();
    domeMat.colorNode = clouds();
    domeMat.transparent = true;
    domeMat.premultipliedAlpha = true;
    domeMat.depthWrite = false;
    domeMat.depthTest = true;
    domeMat.side = BackSide;
    domeMat.fog = false;
    domeMat.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const dome = new Mesh(new SphereGeometry(2000, 48, 24), domeMat);
    dome.name = 'spire-storm-dome';
    dome.position.set(EYE[0], 0, EYE[2]);
    dome.frustumCulled = false;
    dome.renderOrder = -10;
    group.add(dome);
    disposables.push(dome.geometry, domeMat);

    // --- Lightning bolts: a ribbon rebuilt per strike, facing the camera.
    const segs = MAX_BOLT_SEGMENTS;
    const bPos = new Float32Array(segs * 4 * 3);
    const bDir = new Float32Array(segs * 4 * 3);
    const bSide = new Float32Array(segs * 4 * 2);
    const bIdx = new Uint32Array(segs * 6);
    for (let i = 0; i < segs; i++) {
      for (let k = 0; k < 4; k++) {
        bSide[(i * 4 + k) * 2] = k % 2 === 0 ? -1 : 1;
        bSide[(i * 4 + k) * 2 + 1] = 1;
      }
      bIdx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    }
    const boltGeo = new BufferGeometry();
    const posAttr = new BufferAttribute(bPos, 3);
    const dirAttr = new BufferAttribute(bDir, 3);
    const sideAttr = new BufferAttribute(bSide, 2);
    posAttr.setUsage(DynamicDrawUsage);
    dirAttr.setUsage(DynamicDrawUsage);
    sideAttr.setUsage(DynamicDrawUsage);
    boltGeo.setAttribute('position', posAttr);
    boltGeo.setAttribute('boltDir', dirAttr);
    boltGeo.setAttribute('boltSide', sideAttr);
    boltGeo.setIndex(new BufferAttribute(bIdx, 1));
    boltGeo.setDrawRange(0, 0);
    const boltGlow = uniform(0);
    const side = attribute<'vec2'>('boltSide', 'vec2');
    const tangent = attribute<'vec3'>('boltDir', 'vec3');
    const toCam = normalize(cameraPosition.sub(positionLocal));
    const across = normalize(cross(tangent, toCam));
    const boltMat = new MeshBasicNodeMaterial();
    // side.y carries the branch's width factor (main channel 1, branches thinner).
    boltMat.positionNode = positionLocal.add(across.mul(side.x).mul(side.y).mul(5.5));
    const core = float(1).sub(side.x.mul(side.x)).max(0).pow(1.5);
    const boltE = COLORS.bolt.mul(boltGlow.mul(side.y.sqrt()).mul(core).mul(3.2 * p.lightning.brightness)).mul(presence);
    boltMat.colorNode = vec4(additiveFog(boltE), 1);
    boltMat.blending = AdditiveBlending;
    boltMat.transparent = true;
    boltMat.depthWrite = false;
    boltMat.fog = false;
    boltMat.mrtNode = mrt({ emissive: vec4(boltE.mul(0.25), 1) });
    const bolt = new Mesh(boltGeo, boltMat);
    bolt.frustumCulled = false;
    bolt.renderOrder = -9;
    group.add(bolt);
    disposables.push(boltGeo, boltMat);

    const rand = seeded(p.seed * 131);
    const writeBolt = (top: Vector3, bottom: Vector3) => {
      let n = 0;
      const pushSeg = (a: Vector3, b: Vector3, width: number) => {
        if (n >= segs) return;
        const d = new Vector3().subVectors(b, a).normalize();
        for (let k = 0; k < 4; k++) {
          const pnt = k < 2 ? a : b;
          bPos.set([pnt.x, pnt.y, pnt.z], (n * 4 + k) * 3);
          bDir.set([d.x, d.y, d.z], (n * 4 + k) * 3);
          bSide[(n * 4 + k) * 2 + 1] = width;
        }
        n++;
      };
      // Midpoint displacement: a jagged main channel with a few forks.
      const channel = (a: Vector3, b: Vector3, depth: number, rough: number, width: number, forks: number) => {
        let pts = [a.clone(), b.clone()];
        for (let d = 0; d < depth; d++) {
          const next: Vector3[] = [pts[0]!];
          for (let i = 0; i < pts.length - 1; i++) {
            const pa = pts[i]!;
            const pb = pts[i + 1]!;
            const len = pa.distanceTo(pb);
            const mid = pa.clone().lerp(pb, 0.5 + (rand() - 0.5) * 0.2);
            mid.x += (rand() - 0.5) * len * rough;
            mid.z += (rand() - 0.5) * len * rough;
            mid.y += (rand() - 0.5) * len * rough * 0.3;
            next.push(mid, pb);
          }
          pts = next;
        }
        for (let i = 0; i < pts.length - 1; i++) pushSeg(pts[i]!, pts[i + 1]!, width);
        for (let f = 0; f < forks; f++) {
          const i = Math.floor(rand() * pts.length * 0.7);
          const from = pts[i]!;
          const len = a.distanceTo(b) * (0.15 + rand() * 0.25);
          const to = from.clone().add(new Vector3((rand() - 0.5) * len, -len * (0.5 + rand() * 0.5), (rand() - 0.5) * len));
          channel(from, to, depth - 2, rough * 1.1, width * 0.45, 0);
        }
      };
      channel(top, bottom, 6, 0.42, 1, 3 + Math.floor(rand() * 3));
      posAttr.needsUpdate = true;
      dirAttr.needsUpdate = true;
      sideAttr.needsUpdate = true;
      boltGeo.setDrawRange(0, n * 6);
    };

    // --- Lightning timing: a Poisson process, more often in intense music, never on the beat.
    let clock = 0;
    let next = 6 + rand() * 8;
    let strokes: { at: number; peak: number; decay: number }[] = [];
    let glowStart = -1e9;
    let glowPeak = 0;
    let boltUntil = -1e9;
    const pos = new Vector3();
    let intensity = 0.5;

    return {
      object: group,
      update(frame) {
        const dt = Math.min(0.1, frame.dt);
        clock += dt;
        intensity += (Math.min(1, frame.audio.sectionIntensity) - intensity) * (1 - Math.exp(-dt / 6));
        storm.value = intensity;
        const flashSafe = ctx.uniforms.flashLimit.value < 0.99;
        if (clock >= next) {
          const mean = p.lightning.every[0] + (p.lightning.every[1] - p.lightning.every[0]) * intensity;
          next = clock + -Math.log(1 - rand() * 0.98) * mean * (flashSafe ? 1.6 : 1) + 1.5;
          const sideSign = rand() < 0.62 ? 1 : -1;
          const az = (p.lightning.azimuth[0] + (p.lightning.azimuth[1] - p.lightning.azimuth[0]) * rand()) * sideSign;
          const dist = p.lightning.distance[0] + (p.lightning.distance[1] - p.lightning.distance[0]) * Math.pow(rand(), 0.8);
          const a = az * DEG;
          pos.set(EYE[0] + Math.sin(a) * dist, p.base + 80 + rand() * 260, EYE[2] - Math.cos(a) * dist);
          s.u.boltPos.value.copy(pos);
          const strength = 0.55 + rand() * 0.45;
          strokes = [];
          if (flashSafe) {
            // One soft swell, dim; no bolt.
            glowStart = clock;
            glowPeak = strength * 0.3;
          } else {
            const nStrokes = 1 + Math.floor(rand() * 3.5);
            let t = clock;
            for (let i = 0; i < nStrokes; i++) {
              strokes.push({ at: t, peak: strength * (i === 0 ? 1 : 0.55 + rand() * 0.4), decay: 0.07 + rand() * 0.09 });
              t += 0.06 + rand() * 0.16;
            }
            glowStart = clock;
            glowPeak = strength * 0.25;
            if (rand() < p.lightning.bolts) {
              const ground = ctx.ground.height(pos.x, pos.z);
              writeBolt(pos.clone().setY(p.base - 30), new Vector3(pos.x + (rand() - 0.5) * 300, ground, pos.z + (rand() - 0.5) * 300));
              boltUntil = t + 0.05;
            }
          }
        }
        // Envelope: sharp strokes plus a slower in-cloud afterglow.
        let power = 0;
        for (const st of strokes) {
          const t = clock - st.at;
          if (t < 0) continue;
          power += st.peak * Math.min(1, t / 0.015) * Math.exp(-t / st.decay);
        }
        const g = clock - glowStart;
        if (g >= 0) power += flashSafe ? glowPeak * Math.min(1, g / 0.35) * Math.exp(-Math.max(0, g - 0.35) / 0.9) : glowPeak * Math.exp(-g / 0.6);
        s.u.boltPower.value = power * p.lightning.brightness * presence.value;
        boltGlow.value = clock < boltUntil + 0.25 && !flashSafe ? power : 0;
        bolt.visible = boltGlow.value > 0.002;
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const d of disposables) d.dispose();
        release(ctx, s);
      },
    };
  },
};
