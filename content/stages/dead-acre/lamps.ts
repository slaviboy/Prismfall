import {
  AdditiveBlending,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  Sprite,
  SpriteNodeMaterial,
  CircleGeometry,
} from 'three/webgpu';
import { abs, cameraPosition, dot, exp, float, instancedBufferAttribute, int, length, mix, mrt, normalize, normalWorld, positionLocal, positionWorld, pow, smoothstep, step, uv, vec3, vec4 } from 'three/tsl';
import { additiveFog, floatUniform, seeded, z, zColor, type ComponentFactory } from '@prismfall/sdk';
import { backdropSampler, backdropTexture, fogDepth, frontCrossing, lampLight, release, revealMask, shared, zBackdrop, zFog, MAX_LAMPS, type F, type V3, type V4 } from './shared';

const lampSchema = z.object({
  /** Ground position (world x, z) of the pole. */
  at: z.tuple([z.number(), z.number()]),
  height: z.number().positive().default(7.2),
  /** Bracket reach; the head hangs this far out from the pole, away from the playfield. */
  reach: z.number().default(1.2),
  color: zColor.default('#ff9a3c'),
  intensity: z.number().min(0).default(40),
  /** 0 = steady, 1 = a badly failing lamp (sputters, stutters, short outages). */
  flicker: z.number().min(0).max(1).default(0),
  /** Game progress (via `tension`) at which this lamp dies for good; omit for never. */
  dieAt: z.number().min(0).max(1).optional(),
});

const schema = z.object({
  ground: z.number().default(-1.05),
  lamps: z.array(lampSchema).min(1).max(MAX_LAMPS),
  pole: zColor.default('#1a1612'),
  /** Halo around the lamp head (radius in metres) and its strength. */
  glow: z.number().positive().default(1.7),
  glowStrength: z.number().min(0).default(1),
  /** Visible cone of light in the fog under the head, and the pool on the grass. */
  cone: z.number().min(0).default(0.6),
  pool: z.number().min(0).default(0.1),
  poolRadius: z.number().positive().default(6),
  bloom: z.number().min(0).default(0.35),
  backdrop: zBackdrop,
  fog: zFog,
  seed: z.number().default(5),
});

type Params = z.infer<typeof schema>;
type Lamp = z.infer<typeof lampSchema>;

/** A lamp's light over time: steady, failing (seeded sputters and outages) or dying. */
class LampState {
  level = 1;
  /** 0..1 how far a warm-up has got (sodium lamps start dim and red, then turn orange). */
  warm = 1;
  private next = 0;
  private event: { kind: 'dip' | 'stutter' | 'out'; start: number; end: number; depth: number } | null = null;
  private dead = false;
  private deathStart = -1;
  private nextAttempt = 0;
  private readonly rand: () => number;

  constructor(
    private readonly lamp: Lamp,
    seed: number,
  ) {
    this.rand = seeded(seed);
    this.next = 2 + this.rand() * 6;
  }

  update(time: number, dt: number, tension: number, flashSafe: boolean): { died: boolean } {
    const r = this.rand;
    const f = this.lamp.flicker;
    let died = false;
    const dying = this.lamp.dieAt !== undefined && tension >= this.lamp.dieAt;
    if (dying && !this.dead) {
      this.dead = true;
      this.deathStart = time;
      this.nextAttempt = time + 14 + r() * 10;
    } else if (!dying && this.dead && this.lamp.dieAt !== undefined && tension < this.lamp.dieAt - 0.05) {
      // A new run: the lamp strikes again and warms up.
      this.dead = false;
      this.warm = 0;
    }
    let target = 1;
    if (this.dead) {
      const since = time - this.deathStart;
      if (flashSafe) target = Math.max(0, 1 - since / 4);
      else if (since < 5) {
        // Its last seconds: hard stutters, longer and longer gaps.
        const k = since / 5;
        const beat = Math.sin(since * (9 + 11 * k)) * Math.sin(since * 23.7);
        target = beat > 0.15 + k * 0.6 ? 1 - 0.3 * k : 0.04;
        if (since > 4.6) target = 0;
      } else {
        target = 0;
        // Every so often the ballast tries again: a dim red glow that never catches.
        if (time >= this.nextAttempt) {
          const a = time - this.nextAttempt;
          target = a < 1.6 ? 0.12 * Math.sin((a / 1.6) * Math.PI) : 0;
          if (a >= 1.6) this.nextAttempt = time + 12 + r() * 14;
        }
        if (since > 4.9 && since < 5.1) died = true;
      }
      this.warm = Math.max(0, this.warm - dt * 0.5);
    } else {
      this.warm = Math.min(1, this.warm + dt / 6);
      if (f > 0) {
        if (flashSafe) {
          // Flash reduction: a slow, shallow waver instead of sputters.
          target = 1 - 0.22 * f * (0.5 + 0.5 * Math.sin(time * 0.8 + this.lamp.at[0]));
          this.event = null;
        } else {
          if (!this.event && time >= this.next) {
            const roll = r();
            const kind = roll < 0.55 ? 'dip' : roll < 0.85 ? 'stutter' : 'out';
            const len = kind === 'dip' ? 0.06 + r() * 0.2 : kind === 'stutter' ? 0.5 + r() * 0.7 : 1 + r() * 2.2;
            this.event = { kind, start: time, end: time + len, depth: 0.45 + r() * 0.5 };
          }
          if (this.event) {
            const e = this.event;
            const k = (time - e.start) / (e.end - e.start);
            if (e.kind === 'dip') target = 1 - e.depth * Math.sin(Math.min(1, k) * Math.PI);
            else if (e.kind === 'stutter') target = Math.sin(k * 31) > 0 ? 1 : 1 - e.depth;
            else {
              target = k < 0.7 ? 0.03 : 0.03 + (k - 0.7) / 0.3 * 0.5;
              if (k > 0.98) this.warm = 0.35;
            }
            if (time >= e.end) {
              this.event = null;
              // Failing lamps falter more as the night wears on.
              this.next = time + (3 + r() * 9) / (0.4 + f * (1 + tension));
            }
          }
        }
      }
    }
    // Sodium arcs never snap fully: a short smoothing keeps it physical (and not strobing).
    const rate = flashSafe ? 3 : 30;
    this.level += (target - this.level) * Math.min(1, dt * rate);
    return { died };
  }
}

/**
 * Sodium yard lamps on wooden poles: pole, bracket and head as dark fogged silhouettes, a hot lens,
 * a halo in the fog, a faint cone of light and a pool of light on the grass. Each lamp's live
 * intensity is shared with the horde and the ground fog (which they light). A failing lamp
 * sputters; one dies as the night goes on and now and then tries, and fails, to strike again.
 * With flash reduction on, failing and dying lamps only waver and fade slowly.
 */
export const lampsComponent: ComponentFactory<Params> = {
  type: 'deadAcreLamps',
  version: 1,
  description: 'Sodium yard lamps on poles: halos, light cones and pools; one fails as the night goes on.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const backdropTex = await backdropTexture(ctx, s, p.backdrop.src);
    const u = { presence: floatUniform(1), tension: floatUniform(0), dusk: floatUniform(0), glow: floatUniform(1) };
    const backdrop = backdropSampler(backdropTex, p.backdrop, u.dusk as unknown as F);
    const group = new Group();
    const g = p.ground;
    const lamps = p.lamps;

    // Head positions (world); the bracket points away from the playfield (outwards in x).
    const heads = lamps.map((l) => {
      const out = Math.sign(l.at[0]) || 1;
      return { x: l.at[0] + out * l.reach, y: g + l.height - 0.25, z: l.at[1], out };
    });
    lamps.forEach((l, i) => {
      const c = new Color(l.color).convertSRGBToLinear();
      s.lampColours[i]!.set(c.r, c.g, c.b, 0);
      s.lampValues[i]!.set(heads[i]!.x, heads[i]!.y, heads[i]!.z, l.intensity);
    });

    // ---- Opaque parts: pole, bracket and head (one material, fogged like everything else).
    const poleMat = new MeshBasicNodeMaterial();
    {
      const n = normalize(normalWorld);
      const view = normalize(cameraPosition.sub(positionWorld));
      const toP = normalize(positionWorld.sub(cameraPosition));
      const turn = backdrop.turnOf(toP as V3);
      const behind = backdrop.at(turn, float(2));
      const rim = behind.mul(pow(float(1).sub(abs(dot(n, view))).clamp(0, 1), 3).mul(0.3));
      const amb = backdrop.at(turn, float(15)).mul(n.y.mul(0.3).add(0.35)).mul(0.25);
      const albedo = vec3(...(new Color(p.pole).convertSRGBToLinear().toArray() as [number, number, number]));
      const lit = albedo.mul(amb.add(lampLight(s, positionWorld as V3, n as V3, 0.2))).add(rim);
      const tau = fogDepth(positionWorld as V3, g, p.fog, float(1));
      poleMat.colorNode = vec4(mix(backdrop.dir(toP as V3), lit, exp(tau.negate())), 1);
      poleMat.opacityNode = revealMask(u.presence as unknown as F);
      poleMat.alphaTest = 0.5;
      poleMat.fog = false;
      poleMat.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    }
    const geoms: BufferGeometry[] = [];
    lamps.forEach((l, i) => {
      const h = heads[i]!;
      const pole = new CylinderGeometry(0.085, 0.13, l.height, 10, 1);
      geoms.push(pole);
      const pm = new Mesh(pole, poleMat);
      pm.position.set(l.at[0], g + l.height / 2, l.at[1]);
      // A slight lean: old poles are never quite plumb.
      pm.rotation.z = (i % 2 ? 1 : -1) * 0.025;
      group.add(pm);
      const arm = new CylinderGeometry(0.035, 0.04, l.reach + 0.2, 6, 1);
      geoms.push(arm);
      const am = new Mesh(arm, poleMat);
      am.position.set((l.at[0] + h.x) / 2, h.y + 0.18, l.at[1]);
      am.rotation.z = (Math.PI / 2 - 0.18) * h.out;
      group.add(am);
      const head = new SphereGeometry(1, 14, 8);
      geoms.push(head);
      const hm = new Mesh(head, poleMat);
      hm.scale.set(0.24, 0.1, 0.17);
      hm.position.set(h.x, h.y + 0.05, h.z);
      group.add(hm);
    });

    // ---- Lens: the hot underside of each head (bloom), shown at the live intensity.
    const index = new Float32Array(lamps.length * 4);
    lamps.forEach((_, i) => index.set([heads[i]!.x, heads[i]!.y, heads[i]!.z, i], i * 4));
    const lampAttr = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(index, 4), 'vec4');
    const live = s.lampPos.element(int(lampAttr.w)) as unknown as V4;
    const lcol = s.lampCol.element(int(lampAttr.w)) as unknown as V4;
    // Warm-up and dying arcs glow redder.
    const tint = mix(vec3(1, 0.25, 0.08), lcol.rgb, smoothstep(2, 30, live.w));
    const materials: MeshBasicNodeMaterial[] = [];
    const lensGeo = new CircleGeometry(0.15, 16);
    lensGeo.rotateX(Math.PI / 2);
    lensGeo.scale(1.3, 1, 0.9);
    geoms.push(lensGeo);
    lamps.forEach((_, i) => {
      const h = heads[i]!;
      // One small mesh per lamp, reading its own intensity through a per-mesh uniform index.
      const m = new MeshBasicNodeMaterial();
      const L = s.lampPos.element(int(i)) as unknown as V4;
      const C = s.lampCol.element(int(i)) as unknown as V4;
      const tt = mix(vec3(1, 0.25, 0.08), C.rgb, smoothstep(2, 30, L.w));
      const col = tt.mul(L.w.mul(0.08));
      m.colorNode = vec4(col, 1);
      m.mrtNode = mrt({ emissive: vec4(col.mul(p.bloom), 1) });
      m.fog = false;
      m.side = DoubleSide;
      const mesh = new Mesh(lensGeo, m);
      mesh.position.set(h.x, h.y - 0.005, h.z);
      group.add(mesh);
      materials.push(m);
    });

    // ---- Halo in the fog: an additive billboard per lamp, sized and dimmed with the live level.
    const haloMat = new SpriteNodeMaterial();
    const q = uv().sub(0.5).mul(2);
    const r2 = dot(q, q);
    const core = exp(r2.mul(-90)).mul(6).add(exp(r2.mul(-25)).mul(0.8));
    const halo = exp(r2.mul(-9)).mul(0.28).add(exp(r2.mul(-2.2)).mul(0.07));
    const fogBoost = u.glow;
    const hot = mix(tint, vec3(1, 0.86, 0.62), smoothstep(0.8, 3, core));
    const haloCol = hot.mul(live.w.div(40)).mul(core.add(halo)).mul(p.glowStrength).mul(fogBoost).mul(step(r2, 1)).mul(u.presence);
    haloMat.positionNode = lampAttr.xyz;
    haloMat.scaleNode = float(p.glow * 2);
    haloMat.colorNode = vec4(additiveFog(haloCol as V3), 1);
    haloMat.transparent = true;
    haloMat.depthWrite = false;
    haloMat.blending = AdditiveBlending;
    haloMat.fog = false;
    haloMat.mrtNode = mrt({ emissive: vec4(haloCol.mul(p.bloom * 0.5), 1) });
    const sprite = new Sprite(haloMat);
    sprite.count = lamps.length;
    sprite.frustumCulled = false;
    sprite.renderOrder = -1;
    group.add(sprite);

    // ---- Cone of light under each head and the pool on the grass (additive, faint).
    lamps.forEach((l, i) => {
      const h = heads[i]!;
      const L = s.lampPos.element(int(i)) as unknown as V4;
      const C = s.lampCol.element(int(i)) as unknown as V4;
      const level = L.w.div(Math.max(1, l.intensity));
      const coneH = l.height - 0.3;
      const coneGeo = new CylinderGeometry(0.16, p.poolRadius * 0.55, coneH, 24, 1, true);
      geoms.push(coneGeo);
      const cm = new MeshBasicNodeMaterial();
      const n = normalize(normalWorld);
      const view = normalize(cameraPosition.sub(positionWorld));
      const through = pow(abs(dot(n, view)), 2);
      const along = positionLocal.y.div(coneH).add(0.5); // 0 ground .. 1 head
      const coneCol = C.rgb.mul(level).mul(through).mul(smoothstep(0, 0.35, along)).mul(along.mul(0.6).add(0.4)).mul(p.cone * 0.06).mul(u.presence).mul(u.glow);
      cm.colorNode = vec4(additiveFog(coneCol as V3), 1);
      cm.transparent = true;
      cm.depthWrite = false;
      cm.blending = AdditiveBlending;
      cm.side = DoubleSide;
      cm.fog = false;
      cm.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
      const cone = new Mesh(coneGeo, cm);
      cone.position.set(h.x, g + coneH / 2, h.z);
      cone.renderOrder = -1;
      group.add(cone);
      materials.push(cm);

      const poolGeo = new CircleGeometry(p.poolRadius, 40);
      poolGeo.rotateX(-Math.PI / 2);
      geoms.push(poolGeo);
      const pm = new MeshBasicNodeMaterial();
      const d = length(positionWorld.xz.sub(vec3(h.x, 0, h.z).xz)).div(p.poolRadius);
      const poolCol = mix(C.rgb, vec3(1, 0.8, 0.55), 0.35).mul(level).mul(exp(d.mul(d).mul(-3.2))).mul(p.pool * 0.12).mul(u.presence);
      pm.colorNode = vec4(additiveFog(poolCol as V3), 1);
      pm.transparent = true;
      pm.depthWrite = false;
      pm.blending = AdditiveBlending;
      pm.fog = false;
      pm.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
      const pool = new Mesh(poolGeo, pm);
      pool.position.set(h.x, g + 0.03, h.z);
      pool.renderOrder = -1;
      group.add(pool);
      materials.push(pm);
    });

    const states = lamps.map((l, i) => new LampState(l, p.seed * 977 + i * 131));
    // A clear's front surges through the yard's power as it passes each lamp: the arc swells and
    // settles over a second (one smooth swell, never a flicker; slower and softer with flash
    // reduction), and a dead lamp's ballast glows dimly for a moment.
    const surges = lamps.map(() => ({ at: -1e9, k: 0 }));
    let lastTime = -1;
    return {
      object: group,
      reactive: { tension: u.tension, dusk: u.dusk, glow: u.glow },
      update(frame) {
        const flashSafe = ctx.uniforms.flashLimit.value < 0.99;
        const origin = ctx.uniforms.waveOrigin.value;
        lamps.forEach((l, i) => {
          const st = states[i]!;
          const { died } = st.update(frame.time, Math.min(0.1, frame.dt), u.tension.value, flashSafe);
          if (died) {
            s.startle.at = frame.time;
            s.startle.side = Math.sign(l.at[0]);
          }
          const sg = surges[i]!;
          if (lastTime >= 0) {
            const k = frontCrossing(ctx, Math.hypot(heads[i]!.x - origin.x, heads[i]!.y - origin.y, heads[i]!.z - origin.z), lastTime, frame.time) * ctx.uniforms.waveLight.value;
            if (k > 0.02) {
              sg.at = frame.time;
              sg.k = Math.min(1, k);
            }
          }
          const age = frame.time - sg.at;
          const rise = flashSafe ? 0.6 : 0.14;
          const env = age < 0 ? 0 : sg.k * (1 - Math.exp(-age / rise)) * Math.exp(-age / (flashSafe ? 1.6 : 1.0)) * (flashSafe ? 0.5 : 1);
          // Warm-up: dim and red at first, full orange after a few seconds.
          const warm = 0.25 + 0.75 * st.warm;
          s.lampValues[i]!.w = l.intensity * (st.level * warm * (1 + 0.55 * env) + 0.12 * env * (1 - st.level)) * frame.presence;
        });
        lastTime = frame.time;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        for (const geo of geoms) geo.dispose();
        poleMat.dispose();
        haloMat.dispose();
        for (const m of materials) m.dispose();
        for (const v of s.lampValues) v.w = 0;
        release(ctx, s);
      },
    };
  },
};

