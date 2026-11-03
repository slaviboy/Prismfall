import { AdditiveBlending, BufferAttribute, BufferGeometry, CustomBlending, CylinderGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, OneFactor, OneMinusSrcAlphaFactor, Quaternion, Vector3, Vector4 } from 'three/webgpu';
import { abs, attribute, cameraPosition, cross, dot, exp, float, instancedBufferAttribute, length, max, mrt, normalize, normalWorld, positionWorld, pow, smoothstep, step, texture, uniform, uniformArray, uv, vec2, vec3, vec4 } from 'three/tsl';
import { floatUniform, z, type ComponentFactory } from '@prismfall/sdk';
import { comfortOf, fogModelFor } from './atmosphere';
import { cast, MAX_LIGHTS, moonDirection, noisePlane, release, rng, shared, type F, type V2, type V3, type V4 } from './shared';
import { EYE, WATER, terrainHeight } from './terrain';

/**
 * The mist's own life, on top of the fog volume:
 *  - wisps curling around tree trunks and the tower's legs (soft bands of moving mist, lit like
 *    the fog, silvered when the moon is behind them);
 *  - moon shafts: pale beams slanting down from the moon through the gaps, visible only where
 *    there is mist for them to light, slowly opening and closing;
 *  - will-o'-wisps: a few soft lights deep in the fog that drift, breathe and fade, two of them
 *    lighting the mist around them;
 *  - the cabin's and the tower's windows: a faint warm glow at the fog lights.
 * Nothing flashes: every change takes seconds, and flash reduction holds the lights steady.
 */

const schema = z.object({
  exposure: z.number().min(0).default(0.4),
  trunks: z.object({ count: z.number().int().min(0).max(80).default(36), strength: z.number().min(0).default(1.6) }).prefault({}),
  shafts: z.object({ count: z.number().int().min(0).max(16).default(9), strength: z.number().min(0).default(2) }).prefault({}),
  wisps: z.object({ count: z.number().int().min(0).max(6).default(5), intensity: z.number().min(0).default(1) }).prefault({}),
  windows: z.number().min(0).default(0.6),
  seed: z.number().default(9),
});

type Params = z.infer<typeof schema>;

const MAX_GLOWS = 8;
const DEG = Math.PI / 180;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Keeps the effects off the board's clear zone. */
function clearOfBoard(x: number, zz: number, margin = 26, until = 130): boolean {
  const dx = x - EYE.x;
  const dz = EYE.z - zz;
  const az = (Math.atan2(dx, dz) * 180) / Math.PI;
  return Math.abs(az) > margin || Math.hypot(dx, dz) > until;
}

interface Wisp {
  bx: number;
  bz: number;
  y: number;
  ph: number;
  t: number;
  dur: number;
  gap: number;
  on: boolean;
  col: [number, number, number];
  size: number;
  alpha: number;
  pos: Vector3;
}

export const mistComponent: ComponentFactory<Params> = {
  type: 'veilMist',
  version: 1,
  description: 'Wisps around trunks, moon shafts, drifting will-o\'-wisps and warm window glows in the mist.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const fog = await fogModelFor(ctx, s, p.exposure);
    const f = s.fog;
    const noise = noisePlane(s);
    const group = new Group();
    group.name = 'veil-mist';
    const r = rng(p.seed * 4099 + 17);
    const detail = ctx.quality.detail;
    const scaleCount = detail === 'low' ? 0.45 : detail === 'medium' ? 0.7 : 1;
    const presence = floatUniform(1);
    const u = { shafts: floatUniform(1), glow: floatUniform(1) };
    const moon = moonDirection();
    const moonU = uniform(moon);
    const disposables: { dispose(): void }[] = [];

    // --- Wisps around trunks and the tower's legs --------------------------------------------
    const anchors = s.anchors.filter((a) => {
      const d = Math.hypot(a.x - EYE.x, a.z - EYE.z);
      return d > 13 && d < 170 && clearOfBoard(a.x, a.z, 24, 70);
    });
    const towers = anchors.filter((a) => a.kind === 'tower');
    const trunks = anchors.filter((a) => a.kind === 'trunk').sort(() => r() - 0.5);
    const chosen = [...towers, ...trunks.slice(0, Math.round(p.trunks.count * scaleCount))];
    if (chosen.length > 0 && p.trunks.strength > 0) {
      const geo = new CylinderGeometry(1, 1, 1, 32, 6, true);
      geo.translate(0, 0.5, 0);
      // Wider at the foot, where the mist pools.
      const pos = geo.attributes.position!;
      for (let i = 0; i < pos.count; i++) {
        const k = 1.22 - 0.38 * pos.getY(i);
        pos.setX(i, pos.getX(i) * k);
        pos.setZ(i, pos.getZ(i) * k);
      }
      const n = chosen.length;
      const phases = new InstancedBufferAttribute(new Float32Array(n * 2), 2);
      const mat4 = new Matrix4();
      const mesh = new InstancedMesh(geo, new MeshBasicNodeMaterial(), n);
      chosen.forEach((a, i) => {
        const tower = a.kind === 'tower';
        const radius = tower ? a.r * 1.5 : a.r * 2 + 0.7;
        const height = tower ? 9 : 3 + r() * 3;
        mat4.compose(new Vector3(a.x, a.y - 0.25, a.z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), r() * Math.PI * 2), new Vector3(radius, height, radius));
        mesh.setMatrixAt(i, mat4);
        phases.setXY(i, r() * 10, tower ? 1 : 0.6 + 0.4 * r());
      });
      mesh.instanceMatrix.needsUpdate = true;
      const ph = cast<V2>(instancedBufferAttribute(phases));
      const t = cast<F>(f.time);
      const uvN = uv();
      const turn = cast<F>(step(5, ph.x).mul(2).sub(1));
      // Curling: the pattern turns around the trunk and rises, with a helical twist.
      const around = cast<F>(uvN.x.add(uvN.y.mul(0.35)).add(t.mul(0.04).mul(turn)).add(ph.x));
      const rise = cast<F>(uvN.y.mul(0.38).sub(t.mul(0.026)).add(ph.x.mul(1.7)));
      const n1 = cast<F>(texture(noise, vec2(around, rise)).r);
      const n2 = cast<F>(texture(noise, vec2(around.mul(2).sub(t.mul(0.017)), rise.mul(2.1).add(0.37))).r);
      const wisp = cast<F>(smoothstep(0.44, 0.78, n1.mul(0.62).add(n2.mul(0.38))));
      const profile = cast<F>(smoothstep(0, 0.3, uvN.y).mul(pow(float(1).sub(uvN.y), 1.4)));
      const toEye = cast<V3>(normalize(cameraPosition.sub(positionWorld)));
      // Soft silhouettes: a band seen edge-on fades out instead of drawing a line.
      const facing = cast<F>(smoothstep(0.08, 0.62, abs(dot(normalize(normalWorld), toEye))));
      const dist = cast<F>(length(positionWorld.sub(cameraPosition)));
      const near = cast<F>(smoothstep(10, 24, dist));
      const alpha = cast<F>(wisp.mul(profile).mul(facing).mul(near).mul(ph.y).mul(p.trunks.strength).mul(fog.transmittanceTo(cast<V3>(positionWorld))).mul(presence).min(0.85));
      const view = cast<V3>(toEye.negate());
      const lit = fog.radiance(cast<V3>(positionWorld), view, fog.base(view), cast<F>(float(0.9)), dist, cast<F>(float(0)), 0.35);
      const m = mesh.material as MeshBasicNodeMaterial;
      m.colorNode = vec4(lit.mul(1.25).mul(alpha), alpha);
      m.transparent = true;
      m.depthWrite = false;
      m.side = DoubleSide;
      m.fog = false;
      m.blending = CustomBlending;
      m.blendSrc = OneFactor;
      m.blendDst = OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = OneFactor;
      m.blendDstAlpha = OneMinusSrcAlphaFactor;
      m.mrtNode = mrt({ emissive: vec4(vec3(0, 0, 0), alpha) });
      mesh.renderOrder = -5;
      mesh.frustumCulled = false;
      mesh.name = 'veil-wisps';
      group.add(mesh);
      disposables.push(geo, m);
    }

    // --- Moon shafts ----------------------------------------------------------------------------
    const nShafts = Math.round(p.shafts.count * scaleCount);
    if (nShafts > 0 && p.shafts.strength > 0) {
      const axis = moon.clone().negate();
      const SEG = 10;
      const corner: number[] = [];
      const beamA: number[] = [];
      const beamB: number[] = [];
      const index: number[] = [];
      let made = 0;
      for (let tries = 0; made < nShafts && tries < nShafts * 30; tries++) {
        // Mostly in view on the moon's side, so the shafts fan out from it.
        const az = (r() < 0.8 ? -50 + 40 * r() : -85 + 35 * r()) * DEG;
        const d = 70 + 300 * r() * r();
        const sx = EYE.x + Math.sin(az) * d;
        const sz = EYE.z - Math.cos(az) * d;
        const start = new Vector3(sx, terrainHeight(sx, sz) + 25 + 35 * r(), sz);
        let len = 100 + 120 * r();
        // Stop well before passing the viewer, and keep out of the board's clear zone.
        const tc = new Vector3(EYE.x, EYE.y, EYE.z).sub(start).dot(axis);
        if (tc > 0) len = Math.min(len, tc - 45);
        if (len < 40) continue;
        const end = start.clone().addScaledVector(axis, len);
        // Entirely on the moon's side of the board, at any distance.
        const azOf = (v: Vector3) => (Math.atan2(v.x - EYE.x, EYE.z - v.z) * 180) / Math.PI;
        const mid = start.clone().addScaledVector(axis, len * 0.5);
        if (azOf(start) > -16 || azOf(end) > -16 || azOf(mid) > -16) continue;
        if (end.y < Math.max(terrainHeight(end.x, end.z), WATER) - 6) len *= 0.8;
        // Narrow near the viewer, broad far off (about 2 to 4 degrees across).
        const width = (0.035 + 0.035 * r()) * d;
        const phase = r() * 10;
        const base = corner.length / 2;
        for (let k = 0; k <= SEG; k++) {
          for (const c of [0, 1]) {
            corner.push(c, k / SEG);
            beamA.push(start.x, start.y, start.z, len);
            beamB.push(width, phase, 0.6 + 0.4 * r(), 0);
          }
          if (k < SEG) {
            const a0 = base + k * 2;
            index.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
          }
        }
        made++;
      }
      if (made > 0) {
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(new Float32Array(corner.length * 1.5), 3));
        geo.setAttribute('corner', new BufferAttribute(new Float32Array(corner), 2));
        geo.setAttribute('beamA', new BufferAttribute(new Float32Array(beamA), 4));
        geo.setAttribute('beamB', new BufferAttribute(new Float32Array(beamB), 4));
        geo.setIndex(index);
        const A = cast<V4>(attribute('beamA', 'vec4'));
        const B = cast<V4>(attribute('beamB', 'vec4'));
        const c = cast<V2>(attribute('corner', 'vec2'));
        const ax = vec3(axis.x, axis.y, axis.z);
        const along = cast<V3>(A.xyz.add(ax.mul(A.w.mul(c.y))));
        const side = cast<V3>(normalize(cross(ax, normalize(cameraPosition.sub(along)))));
        const m = new MeshBasicNodeMaterial();
        m.positionNode = cast<V3>(along.add(side.mul(B.x.mul(c.x.sub(0.5)))));
        const t = cast<F>(f.time);
        const across = cast<F>(c.x.sub(0.5));
        const profile = cast<F>(exp(across.mul(across).mul(-16)));
        const ends = cast<F>(smoothstep(0, 0.25, c.y).mul(smoothstep(1, 0.45, c.y)));
        const dust = cast<F>(texture(noise, vec2(c.y.mul(A.w).div(70).sub(t.mul(0.006)).add(B.y), across.mul(0.5).add(B.y.mul(0.31)))).r.mul(1.1).add(0.35));
        // Gaps in the mist open and close: each shaft comes and goes over a minute or two.
        const open = cast<F>(smoothstep(0.36, 0.58, texture(noise, vec2(B.y.mul(0.137).add(t.mul(0.0026)), B.y.mul(0.0731).add(0.5))).r));
        const w = cast<V3>(positionWorld);
        const mist = cast<F>(smoothstep(0.0004, 0.005, fog.density(w)).mul(0.5).add(0.5));
        const view = cast<V3>(normalize(w.sub(cameraPosition)));
        const phase = cast<F>(pow(max(dot(view, moonU), 0), 4).mul(1.4).add(0.3));
        const shade = s.shadows ? cast<F>(float(1).sub(s.shadows.sampleFog(w, 1.6).mul(0.85))) : cast<F>(float(1));
        const k = cast<F>(profile.mul(ends).mul(dust).mul(open).mul(mist).mul(phase).mul(shade).mul(B.z).mul(fog.transmittanceTo(w)).mul(u.shafts).mul(presence).mul(p.shafts.strength));
        m.colorNode = vec4(fog.base(view).mul(vec3(0.95, 1.0, 1.12)).mul(f.moon).mul(k).mul(3), 1);
        m.transparent = true;
        m.depthWrite = false;
        m.side = DoubleSide;
        m.fog = false;
        m.blending = AdditiveBlending;
        m.mrtNode = mrt({ emissive: vec4(0, 0, 0, 0) });
        const mesh = new Mesh(geo, m);
        mesh.frustumCulled = false;
        mesh.renderOrder = -4;
        mesh.name = 'veil-shafts';
        group.add(mesh);
        disposables.push(geo, m);
      }
    }

    // --- Will-o'-wisps and window glows (camera-facing sprites driven by uniforms) -----------
    const nWisps = Math.max(0, Math.min(6, Math.round(p.wisps.count * scaleCount)));
    const glowPos = Array.from({ length: MAX_GLOWS }, () => new Vector4(0, -9999, 0, 1));
    const glowCol = Array.from({ length: MAX_GLOWS }, () => new Vector4(0, 0, 0, 0));
    const glowPosU = uniformArray(glowPos, 'vec4');
    const glowColU = uniformArray(glowCol, 'vec4');
    {
      const corner: number[] = [];
      const slot: number[] = [];
      const index: number[] = [];
      for (let g = 0; g < MAX_GLOWS; g++) {
        const b = corner.length / 2;
        corner.push(0, 0, 1, 0, 0, 1, 1, 1);
        slot.push(g, g, g, g);
        index.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(corner.length * 1.5), 3));
      geo.setAttribute('corner', new BufferAttribute(new Float32Array(corner), 2));
      geo.setAttribute('slot', new BufferAttribute(new Float32Array(slot), 1));
      geo.setIndex(index);
      const id = cast<F>(attribute('slot', 'float')).toInt();
      const P = cast<V4>(glowPosU.element(id));
      const C = cast<V4>(glowColU.element(id));
      const c = cast<V2>(attribute('corner', 'vec2'));
      const toEye = cast<V3>(normalize(cameraPosition.sub(P.xyz)));
      const sideV = cast<V3>(normalize(cross(vec3(0, 1, 0), toEye)));
      const upV = cast<V3>(cross(toEye, sideV));
      const m = new MeshBasicNodeMaterial();
      m.positionNode = cast<V3>(P.xyz.add(sideV.mul(c.x.sub(0.5)).add(upV.mul(c.y.sub(0.5))).mul(P.w)));
      const q = cast<F>(length(c.sub(0.5)).mul(2));
      const core = cast<F>(exp(q.div(0.085).pow(2).negate()));
      const halo = cast<F>(exp(q.div(0.3).pow(2).negate()).mul(0.32).add(exp(q.mul(5).negate()).mul(0.1)).mul(smoothstep(1, 0.75, q)));
      const k = cast<F>(core.mul(1.3).add(halo).mul(C.w).mul(fog.transmittanceTo(cast<V3>(P.xyz))).mul(presence));
      m.colorNode = vec4(C.xyz.mul(k), 1);
      m.transparent = true;
      m.depthWrite = false;
      m.fog = false;
      m.blending = AdditiveBlending;
      m.mrtNode = mrt({ emissive: vec4(C.xyz.mul(core.mul(C.w).mul(0.25)), 0) });
      const mesh = new Mesh(geo, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = -3;
      mesh.name = 'veil-glows';
      group.add(mesh);
      disposables.push(geo, m);
    }

    const COOL: [number, number, number][] = [
      [0.55, 0.84, 1.0],
      [0.66, 0.78, 1.0],
      [0.6, 0.92, 0.95],
    ];
    const WARM: [number, number, number] = [1.0, 0.78, 0.52];
    const spawn = (w: Wisp, first: boolean) => {
      for (let tries = 0; tries < 40; tries++) {
        const side = r() < 0.5 ? -1 : 1;
        // Mostly where the player can see them; now and then out to the sides (VR, wide views).
        const az = side * (r() < 0.8 ? 25 + 20 * r() : 45 + 40 * r()) * DEG;
        const d = 45 + 330 * r() * r();
        const x = EYE.x + Math.sin(az) * d;
        const zz = EYE.z - Math.cos(az) * d;
        if (!clearOfBoard(x, zz, 26, 140)) continue;
        w.bx = x;
        w.bz = zz;
        w.y = Math.max(terrainHeight(x, zz), WATER) + 0.8 + 1.8 * r();
        break;
      }
      w.ph = r() * 100;
      w.t = first ? -r() * 30 : 0;
      w.dur = 18 + 24 * r();
      w.gap = 6 + 34 * r();
      w.col = r() < 0.18 ? WARM : COOL[Math.floor(r() * COOL.length)]!;
      w.size = 7 + 5 * r();
    };
    const wisps: Wisp[] = Array.from({ length: nWisps }, () => {
      const w: Wisp = { bx: 0, bz: 0, y: 0, ph: 0, t: 0, dur: 1, gap: 1, on: true, col: COOL[0]!, size: 8, alpha: 0, pos: new Vector3() };
      spawn(w, true);
      return w;
    });
    const WISP_LIGHTS = [MAX_LIGHTS - 2, MAX_LIGHTS - 1];
    if (typeof __PRISMFALL_HOOKS__ !== 'undefined' && __PRISMFALL_HOOKS__) (s as unknown as { mist?: unknown }).mist = { u, wisps, glowPos, glowCol };

    return {
      object: group,
      reactive: { shafts: u.shafts, glow: u.glow },
      update(frame) {
        const dt = Math.min(0.1, frame.dt) * s.timeScale;
        const calm = ctx.quality.reducedMotion ? 0.5 : 1;
        const steady = ctx.uniforms.flashLimit.value < 0.99;
        const comfort = comfortOf(ctx);
        const glow = u.glow.value * p.wisps.intensity * (comfort === 'off' ? 0.6 : 1);
        for (let i = 0; i < wisps.length; i++) {
          const w = wisps[i]!;
          w.t += dt * calm;
          if (w.t > w.dur + w.gap) spawn(w, false);
          const life = w.t < 0 ? 0 : smooth(0, 6, w.t) * smooth(w.dur, w.dur - 8, w.t);
          const breathe = steady ? 1 : 0.78 + 0.22 * Math.sin(w.t * 0.55 + w.ph) * Math.sin(w.t * 0.23 + w.ph * 0.7);
          const T = w.t + w.ph;
          w.pos.set(w.bx + 6 * Math.sin(T * 0.045) + 2.5 * Math.sin(T * 0.12 + 1.3), w.y + 0.45 * Math.sin(T * 0.21), w.bz + 6 * Math.cos(T * 0.038) + 2.5 * Math.sin(T * 0.1 + 0.4));
          w.alpha = life * breathe * glow;
          glowPos[i]!.set(w.pos.x, w.pos.y, w.pos.z, w.size);
          glowCol[i]!.set(w.col[0], w.col[1], w.col[2], w.alpha * 1.3);
        }
        for (let i = wisps.length; i < 6; i++) glowCol[i]!.set(0, 0, 0, 0);
        // The two brightest wisps light the mist around them.
        const lit = [...wisps].sort((a, b) => b.alpha - a.alpha).slice(0, 2);
        WISP_LIGHTS.forEach((slot, k) => {
          const w = lit[k];
          const v = f.lightValues[slot]!;
          if (!w || w.alpha <= 0.01) {
            v.set(0, -9999, 0, 0);
            return;
          }
          v.set(w.pos.x, w.pos.y, w.pos.z, 26 * w.alpha);
          f.lightColours[slot]!.set(w.col[0], w.col[1], w.col[2], 0);
        });
        // Windows: a faint, steady warm glow at the cabin's and the tower's lights.
        [0, 1].forEach((i) => {
          const l = f.lightValues[i]!;
          const c = f.lightColours[i]!;
          glowPos[6 + i]!.set(l.x, l.y, l.z, i === 0 ? 3.2 : 4.5);
          glowCol[6 + i]!.set(c.x, c.y * 0.92, c.z * 0.8, l.w > 0 ? p.windows : 0);
        });
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        disposables.forEach((d) => d.dispose());
        for (const slot of WISP_LIGHTS) f.lightValues[slot]!.set(0, -9999, 0, 0);
        release(ctx, s);
      },
    };
  },
};
