import { BackSide, CustomBlending, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial, OneFactor, OneMinusSrcAlphaFactor, SphereGeometry, Vector3 } from 'three/webgpu';
import type { vec2} from 'three/tsl';
import { cameraPosition, float, instancedBufferAttribute, mrt, normalize, positionGeometry, positionWorld, vec3, vec4 } from 'three/tsl';
import { floatUniform, z, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { Director, KINDS, type Comfort, type EventKind } from './director';
import { createFogModel, fogQuality, type FogModel } from './fogModel';
import { backdropTexture, cast, MAX_POCKETS, moonDirection, noiseVolume, release, shared, type F, type V3, type VeilShared } from './shared';
import { ShadowMaps } from './shadow';
import { EYE, terrainHeight } from './terrain';

const zLight = z.object({
  /** Azimuth (degrees), distance from the eye and height above the ground there. */
  at: z.tuple([z.number(), z.number(), z.number()]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  intensity: z.number().min(0),
  /** Slow, irregular breathing (0..1); never a flicker. */
  breathe: z.number().min(0).max(1).default(0.15),
});

const schema = z.object({
  /** Sky layer's panorama exposure (the fog takes its colour from the photo). */
  exposure: z.number().min(0).default(0.4),
  density: z.number().min(0).default(1),
  /** Share of the fog's light that is moonlight (what the shadows remove). */
  moon: z.number().min(0).max(1).default(0.7),
  /** Wind (m/s, x and z) for the banks; the fine mist moves faster. */
  wind: z.tuple([z.number(), z.number()]).default([1.6, 0.5]),
  lights: z.array(zLight).max(4).default([]),
  /** Static pockets: [x, y, z, radius, amount] (amount > 0 thicker, < 0 clearer). */
  pockets: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])).max(4).default([]),
  /** Where the director's set pieces happen. */
  places: z
    .object({
      gate: z.tuple([z.number(), z.number(), z.number()]).default([420, 40, -560]),
      closing: z.tuple([z.number(), z.number(), z.number()]).default([95, -5, -60]),
    })
    .prefault({}),
  seed: z.number().default(0),
});

type Params = z.infer<typeof schema>;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** World-events comfort level from the accessibility setting (generic, SDK-exposed) and reduced motion. */
export function comfortOf(ctx: EnvironmentContext): Comfort {
  const u = (ctx.uniforms as unknown as Record<string, { value: number } | undefined>).worldEvents;
  const v = u ? u.value : 1;
  if (v < 0.25) return 'off';
  if (v < 0.75 || ctx.quality.reducedMotion) return 'calm';
  return 'full';
}

/** The fog model every Veil surface uses; built once per environment by the atmosphere. */
export const fogModels = new WeakMap<VeilShared, Promise<FogModel>>();

export function fogModelFor(ctx: EnvironmentContext, s: VeilShared, exposure: number): Promise<FogModel> {
  let p = fogModels.get(s);
  if (!p) {
    p = (async () => {
      const tex = await backdropTexture(ctx, s);
      const noise = noiseVolume(s);
      if (!s.shadows) s.shadows = createShadows(ctx);
      return createFogModel(s, noise, tex, exposure, s.shadows, fogQuality(ctx.quality.detail));
    })();
    fogModels.set(s, p);
  }
  return p;
}

function createShadows(ctx: EnvironmentContext): ShadowMaps {
  const low = ctx.quality.detail === 'low';
  const maps = new ShadowMaps(moonDirection(), [
    { centre: new Vector3(-40, -10, -110), halfWidth: 270, halfHeight: 190, size: low ? 512 : 1024 },
    { centre: new Vector3(-200, 0, -650), halfWidth: 1250, halfHeight: 700, size: low ? 512 : 1024 },
  ]);
  maps.attach(ctx.scene);
  return maps;
}

/**
 * The fog volume (nested shells around the camera, each marching its stretch of every view ray),
 * the moon's shadow maps, the fog lights, the wind, and the event director that schedules what
 * happens out in the mist. Other Veil components read the director and draw into the shadows.
 */
export const atmosphereComponent: ComponentFactory<Params> = {
  type: 'veilAtmosphere',
  version: 1,
  description: 'Layered, ray-marched fog with moon shadows, fog lights and the event director.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const model = await fogModelFor(ctx, s, p.exposure);
    const q = model.q;
    const seed = p.seed || Math.floor(Math.random() * 1e9);
    const director = new Director(seed);
    s.director = director;
    const debug = typeof __PRISMFALL_HOOKS__ !== 'undefined' && __PRISMFALL_HOOKS__;
    const handle = { director, fog: s.fog, densityScale: 1, shared: s, force: (k: EventKind) => director.force(k) };
    if (debug) (globalThis as unknown as { __veil?: unknown }).__veil = handle;

    // Reactive targets (bound in the manifest, so the player's reactivity settings apply): the bass
    // drives the banks' drift, the treble the fine mist, the mids the lights.
    const u = { presence: floatUniform(1), density: floatUniform(p.density), drift: floatUniform(1), fineDrift: floatUniform(1), lights: floatUniform(1) };
    s.fog.moon.value = p.moon;

    // Shells: instance i is the stretch between radius(i-1) and radius(i); drawn far to near.
    const n = q.shells;
    const geo = new SphereGeometry(1, 64, 32);
    const radii = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const i = n - 1 - k;
      radii[k * 2] = i === 0 ? 0 : model.radius(i - 1);
      radii[k * 2 + 1] = model.radius(i);
    }
    const rAttr = new InstancedBufferAttribute(radii, 2);
    const r = cast<ReturnType<typeof vec2>>(instancedBufferAttribute(rAttr));
    const material = new MeshBasicNodeMaterial();
    material.positionNode = cast<V3>(positionGeometry.mul(r.y).add(cameraPosition));
    const rel = cast<V3>(positionWorld.sub(cameraPosition));
    const dir = cast<V3>(normalize(rel));
    const base = model.base(dir);
    const seg = model.integrate(cameraPosition as unknown as V3, dir, cast<F>(r.x), cast<F>(r.y), q.steps, base);
    const alpha = cast<F>(float(1).sub(seg.trans).mul(u.presence));
    material.colorNode = vec4(seg.color.mul(u.presence), alpha);
    material.transparent = true;
    material.depthWrite = false;
    material.side = BackSide;
    material.blending = CustomBlending;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = OneFactor;
    material.blendDstAlpha = OneMinusSrcAlphaFactor;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(vec3(0, 0, 0), alpha) });
    const mesh = new InstancedMesh(geo, material, n);
    mesh.frustumCulled = false;
    mesh.renderOrder = -6;
    mesh.name = 'veil-fog';

    // Static pockets first; the director owns the last slots.
    const pv = s.fog.pocketValues;
    const pa = s.fog.pocketAmounts;
    p.pockets.forEach((k, i) => {
      pv[i]!.set(k[0], k[1], k[2], k[3]);
      pa[i]!.set(k[4], 0.35, 1, 0);
    });
    const firstDynamic = p.pockets.length;
    // The static pockets breathe: they drift a little and swell or thin over a minute or two, so
    // the banks and clearings are never quite where they were.
    const breathing = p.pockets.map((k, i) => ({ x: k[0], y: k[1], z: k[2], r: k[3], amt: k[4], ph: i * 2.1 + 0.7 }));
    // One more: a clearing that wanders through the mid-distance, opening and closing (the slot
    // between the director's and the creatures').
    const PARTING = MAX_POCKETS - 3;
    const lights = p.lights.map((l) => {
      const a = (l.at[0] * Math.PI) / 180;
      const x = EYE.x + Math.sin(a) * l.at[1];
      const zz = EYE.z - Math.cos(a) * l.at[1];
      return { ...l, base: new Vector3(x, terrainHeight(x, zz) + l.at[2], zz), phase: Math.random() * 100 };
    });
    lights.forEach((l, i) => {
      const c = s.fog.lightColours[i]!;
      const col = parseInt(l.color.slice(1), 16);
      c.set(((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, 0);
    });
    let flare = 0;
    const windV = new Vector3(p.wind[0], 0, p.wind[1]);
    const fineV = new Vector3(p.wind[0] * 2.2, 0.15, p.wind[1] * 2.6);

    const setPocket = (slot: number, x: number, y: number, zz: number, radius: number, amount: number, softness = 0.35, stretch = 1) => {
      const i = firstDynamic + slot;
      if (i >= pv.length) return;
      pv[i]!.set(x, y, zz, radius);
      pa[i]!.set(amount, softness, stretch, 0);
    };

    return {
      object: mesh,
      reactive: { density: u.density, drift: u.drift, fineDrift: u.fineDrift, lights: u.lights },
      update(frame) {
        const dt = Math.min(0.1, frame.dt);
        const comfort = comfortOf(ctx);
        director.comfort = comfort;
        director.update(dt * s.timeScale, frame.audio.sectionIntensity);
        const calm = ctx.quality.reducedMotion ? 0.45 : 1;
        s.fog.wind.value.addScaledVector(windV, dt * u.drift.value * calm);
        s.fog.windFine.value.addScaledVector(fineV, dt * u.fineDrift.value * calm);
        s.fog.shimmer.value = Math.max(0, u.fineDrift.value - 1);
        s.fog.time.value += dt * calm * s.timeScale;
        const T = s.fog.time.value;
        breathing.forEach((b, i) => {
          const swell = 0.5 + 0.5 * Math.sin(T * 0.021 + b.ph) * Math.cos(T * 0.0083 + b.ph * 1.7);
          pv[i]!.set(b.x + 28 * Math.sin(T * 0.011 + b.ph), b.y, b.z + 22 * Math.cos(T * 0.009 + b.ph * 1.3), b.r * (0.85 + 0.3 * swell));
          pa[i]!.set(b.amt * (0.35 + 0.95 * swell), 0.35, 1.2, 0);
        });
        if (PARTING >= firstDynamic + 3) {
          const az = (-58 + 116 * (0.5 + 0.5 * Math.sin(T * 0.0047 + 0.4))) * (Math.PI / 180);
          const pd = 120 + 55 * Math.sin(T * 0.0071 + 1.9);
          const px = EYE.x + Math.sin(az) * pd;
          const pz = EYE.z - Math.cos(az) * pd;
          const opening = smooth(0.15, 0.85, 0.5 + 0.5 * Math.sin(T * 0.019 + 2.6));
          pv[PARTING]!.set(px, terrainHeight(px, pz) + 6, pz, 58);
          pa[PARTING]!.set(-0.92 * opening, 0.3, 1.5, 0);
        }
        // Comfort: a calmer world is also a clearer one.
        const comfortDensity = comfort === 'off' ? 0.7 : comfort === 'calm' ? 0.82 : 1;
        let density = u.density.value * comfortDensity * handle.densityScale;
        // Director fog events.
        for (let slot = 0; slot < 3; slot++) setPocket(slot, 0, -9999, 0, 1, 0);
        const bank = director.find('bankRoll');
        if (bank) {
          const side = bank.event.variant < 0.5 ? -1 : 1;
          const x = side * (-520 + 1040 * bank.progress);
          const zz = -200 - 160 * bank.event.variant;
          const amt = 2.6 * smooth(0, 0.15, bank.progress) * smooth(1, 0.82, bank.progress);
          setPocket(0, x, 10, zz, 150, amt, 0.25, 2.6);
        }
        // The far architecture stays veiled in a thick bank, except while the mist clears.
        const reveal = director.find('reveal');
        const open = reveal ? smooth(0, 0.3, reveal.progress) * smooth(1, 0.7, reveal.progress) : 0;
        const g = p.places.gate;
        setPocket(1, g[0], g[1], g[2], 330, 1.5 - 2.45 * open, 0.25, 1.3);
        density *= 1 - 0.28 * open;
        const closing = director.find('closing');
        if (closing) {
          const thick = smooth(0, 0.35, closing.progress) * smooth(1, 0.75, closing.progress);
          const c = p.places.closing;
          const side = closing.event.variant < 0.5 ? 1 : -1;
          setPocket(2, side * c[0], c[1], c[2], 120, 6 * thick, 0.15, 2.2);
        }
        s.fog.density.value = density;
        // Lights: slow breathing, lifted a little by the mids; flash reduction keeps them steady.
        const steady = ctx.uniforms.flashLimit.value < 0.99;
        lights.forEach((l, i) => {
          const t = frame.time * 0.31 + l.phase;
          const breathe = steady ? 0 : l.breathe * (0.5 * Math.sin(t) + 0.3 * Math.sin(t * 2.37 + 1.1) + 0.2 * Math.sin(t * 0.53 + 2.3));
          s.fog.lightValues[i]!.set(l.base.x, l.base.y, l.base.z, l.intensity * (1 + breathe) * u.lights.value * frame.presence);
        });
        // The QUAD's distant illumination: a slow swell, capped by flash reduction and screen effects.
        flare = Math.max(0, flare - dt * 0.35);
        const se = (ctx.uniforms as unknown as Record<string, { value: number } | undefined>).screenEffects?.value ?? 1;
        s.fog.flare.value = Math.min(1, flare) * (steady ? 0.35 : 1) * (0.4 + 0.6 * se) * 0.5;
        const backlit = director.find('silhouette');
        s.fog.backlight.value = 1 + (backlit ? 0.5 * smooth(0, 0.2, backlit.progress) * smooth(1, 0.8, backlit.progress) : 0);
        if (s.shadows) s.shadows.strength.value = comfort === 'off' ? 0.6 : 1;
      },
      onGameEvent(e) {
        if (e.kind === 'clear' && e.lines >= 4) flare = Math.min(1.4, flare + 1.1);
        else if (e.kind === 'clear' && e.lines >= 2) flare = Math.min(1.4, flare + 0.25);
      },
      onCall(call) {
        // Manifest call-ins (a drop, a QUAD, a break): the director starts one of the asked events
        // if its own rules allow it now (comfort, cooldowns, creatures never overlapping).
        if (call.action !== 'show' && call.action !== 'reveal') return;
        const kinds = Array.isArray(call.params.kinds) ? call.params.kinds.filter((k): k is EventKind => typeof k === 'string' && k in KINDS) : [];
        director.comfort = comfortOf(ctx);
        director.call(kinds);
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geo.dispose();
        material.dispose();
        if (debug) delete (globalThis as unknown as { __veil?: unknown }).__veil;
        fogModels.delete(s);
        release(ctx, s);
      },
    };
  },
};

