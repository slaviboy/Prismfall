import { BackSide, Mesh, MeshBasicNodeMaterial, SphereGeometry } from 'three/webgpu';
import { Break, Fn, If, Loop, atan, cameraPosition, exp, float, fract, int, length, max, min, mix, normalize, positionWorld, pow, screenCoordinate, sin, smoothstep, texture3D, vec3, vec4 } from 'three/tsl';
import { noBloom, z, type ComponentFactory } from '@prismfall/sdk';
import { CLOUD_BASE, CLOUD_TOP, FLASH_COLOR, GLOW_AZIMUTH, MAX_FLASH, cast, noiseVolume, releaseStorm, skyRadiance, storm, tickStorm, type F, type V3, type V4 } from './shared';

const schema = z.object({
  /** Dome radius (inside the camera's far plane). */
  radius: z.number().positive().default(2100),
  /** Ray-march steps through the cloud deck at Ultra detail (fewer below). */
  steps: z.number().int().min(4).max(32).default(16),
  /** How much of the sky the deck covers (0..1). */
  coverage: z.number().min(0).max(1).default(0.7),
  /** Overall cloud density (extinction scale). */
  density: z.number().positive().default(1),
});

type Params = z.infer<typeof schema>;

/**
 * The storm sky: an enormous, near-black cloud deck ray-marched through a slab from its lumpy,
 * hanging base to its top, with a faint break in the storm low on the horizon to the right where
 * distant thunderheads stand in silhouette. The deck has almost no light of its own: lightning
 * lights it from within, around each flash's glow centre, so the shapes of the clouds appear only
 * when the storm flashes. Flash brightness comes from the shared storm (comfort-scaled there).
 */
export const skyComponent: ComponentFactory<Params> = {
  type: 'stormSky',
  version: 1,
  description: 'Dark Storm: a ray-marched storm cloud deck lit from within by lightning, distant thunderheads and a faint horizon break.',
  schema,
  create(ctx, p) {
    const s = storm(ctx);
    const noise = noiseVolume(s);
    const detail = ctx.quality.detail;
    const steps = Math.max(4, Math.round(p.steps * (detail === 'low' ? 0.4 : detail === 'medium' ? 0.6 : detail === 'high' ? 0.8 : 1)));
    const scudSteps = detail === 'low' ? 2 : detail === 'medium' ? 3 : 5;
    const u = s.u;
    const material = new MeshBasicNodeMaterial();
    // Explicit level 0: the volume has no mipmaps, and the samples sit inside a loop.
    const tex = (q: V3): V4 => cast<V4>(texture3D(noise, q, float(0)));
    material.colorNode = Fn(() => {
      const dir = cast<V3>(normalize(positionWorld.sub(cameraPosition)));
      const el = cast<F>(dir.y);
      let sky = skyRadiance(s, dir);
      // Distant thunderheads on the horizon in the break, in silhouette (lit only by far flashes).
      const az = cast<F>(atan(dir.x, dir.z.negate()));
      const glowAz = (GLOW_AZIMUTH * Math.PI) / 180;
      const near = cast<F>(exp(az.sub(glowAz).pow(2).mul(-1.6)));
      const towers = cast<F>(
        sin(az.mul(3.1).add(1.3))
          .mul(0.5)
          .add(sin(az.mul(7.7).add(0.4)).mul(0.3))
          .add(sin(az.mul(17.3)).mul(0.12))
          .mul(0.5)
          .add(0.5),
      );
      const top = cast<F>(towers.pow(2).mul(0.11).add(0.012).mul(near.mul(0.8).add(0.2)));
      const inTower = cast<F>(smoothstep(top.add(0.006), top.sub(0.004), el).mul(smoothstep(-0.02, 0.004, el)));
      sky = cast<V3>(mix(sky, sky.mul(0.45).add(vec3(0.004, 0.0048, 0.006)), inTower));

      // The cloud deck: march from its lowest lumps into it. Light seldom gets back out from more
      // than a kilometre or so inside the deck, so the march stops there (or as soon as the deck is
      // opaque) and its steps stay short. Rays below the horizon, or so low that the deck melts into
      // the horizon air, skip it.
      const dy = cast<F>(max(el, 0.012));
      const lowest = float(CLOUD_BASE - 70);
      const t0 = cast<F>(lowest.sub(cameraPosition.y).div(dy));
      const t1 = cast<F>(min(float(CLOUD_TOP).sub(cameraPosition.y).div(dy), t0.add(1700)));
      const ds = cast<F>(t1.sub(t0).div(steps));
      const jitter = cast<F>(fract(sin(screenCoordinate.x.mul(12.9898).add(screenCoordinate.y.mul(78.233))).mul(43758.5453)));
      const acc = vec3(0, 0, 0).toVar();
      const T = float(1).toVar();
      const scud = vec3(0, 0, 0).toVar();
      const ST = float(1).toVar();
      const offset = u.cloudOffset;
      const coverage = float(p.coverage);
      If(t0.lessThan(15000).and(el.greaterThan(0.004)), () => {
        // The deck's big cells barely change along one ray's short march: sampled once.
        const q0 = cast<V3>(cameraPosition.add(dir.mul(t0)).add(offset));
        const bigR = cast<F>(tex(cast<V3>(vec3(q0.x.div(11000), 0.31, q0.z.div(11000)))).r);
        /** Deck density at a point (0..1) from its big cells, billows and hanging lumps. */
        const deck = (pos: V3, q: V3, lumpsB: F): F => {
          const shape = tex(cast<V3>(q.div(vec3(2600, 1500, 2600))));
          // The base hangs in rounded lobes (heavy, mammatus-like) and rises into the deck.
          const bottom = float(CLOUD_BASE).sub(lumpsB.mul(120)).add(shape.r.sub(0.5).mul(90));
          const inDeck = smoothstep(bottom, bottom.add(60), pos.y).mul(float(1).sub(smoothstep(CLOUD_TOP - 500, CLOUD_TOP, pos.y)));
          // The break: far out towards the right the deck thins so the horizon's light shows.
          const breakUp = smoothstep(5500, 13000, length(pos.xz.sub(cameraPosition.xz))).mul(near).mul(0.55);
          const cov = bigR.mul(0.55).add(shape.r.mul(0.45)).add(coverage.sub(0.5)).sub(breakUp);
          return cast<F>(smoothstep(0.32, 0.6, cov.add(lumpsB.mul(0.3))).mul(inDeck).mul(p.density));
        };
        Loop({ start: int(0), end: int(steps) }, ({ i }) => {
          If(T.lessThan(0.03), () => {
            Break();
          });
          const t = t0.add(float(i).add(jitter).mul(ds));
          const pos = cast<V3>(cameraPosition.add(dir.mul(t)));
          const q = cast<V3>(pos.add(offset));
          const h = pos.y.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE);
          const lumps = tex(cast<V3>(q.div(vec3(900, 700, 900))));
          const dens = deck(pos, q, cast<F>(lumps.b));
          const sigma = dens.mul(0.0095);
          // Light: a faint glow from below and from the horizon's break, and every flash inside.
          // Mottled: lumps hanging low are darker, thinner edges catch a little more of the night.
          const mottle = float(1.25).sub(lumps.b.mul(0.9)).add(lumps.a.sub(0.5).mul(0.12));
          const ambient = vec3(0.012, 0.0142, 0.0188).mul(h.mul(0.5).add(0.5)).mul(mottle).add(vec3(0.01, 0.012, 0.014).mul(near).mul(smoothstep(3000, 11000, t)));
          let light: V3 = cast<V3>(ambient);
          for (let k = 0; k < MAX_FLASH; k++) {
            const fp = cast<V4>(u.flashPos.element(int(k)));
            const gp = cast<V4>(u.flashGlow.element(int(k)));
            const d = length(pos.sub(gp.xyz));
            // Light scattered through the cloud from the channel: bright near it, deep and soft beyond.
            const scatter = exp(d.div(gp.w).negate()).mul(1.3).add(exp(d.div(gp.w.mul(3)).negate()).mul(0.1));
            // The lowest lumps catch the channel's light from below.
            const under = exp(length(pos.sub(fp.xyz)).div(gp.w.mul(1.4)).negate()).mul(0.5);
            let lit: F = cast<F>(scatter.add(under));
            if (k === 0) {
              // Self-shadowing towards the brightest flash: cloud between a lump and the light darkens
              // its far side, so the flash shows the deck's billows and hanging lobes in relief.
              const toL = cast<V3>(normalize(gp.xyz.sub(pos)));
              const probe = cast<V3>(pos.add(toL.mul(110)));
              const pq = cast<V3>(probe.add(offset));
              const pl = tex(cast<V3>(pq.div(vec3(900, 700, 900))));
              const shade = deck(probe, pq, cast<F>(pl.b));
              lit = cast<F>(lit.mul(exp(shade.mul(-2.6)).mul(0.8).add(0.2)));
            }
            // Clouds glow visibly even for small, distant flashes; the brightest ones compress.
            light = cast<V3>(light.add(vec3(...FLASH_COLOR).mul(fp.w.max(0).pow(0.75).mul(1.25).mul(lit))));
          }
          const absorb = exp(sigma.mul(ds).negate());
          acc.addAssign(light.mul(T).mul(float(1).sub(absorb)));
          T.mulAssign(absorb);
        });
        // Scud: ragged low cloud under the deck, darker and faster, that stands out against the lit
        // deck when lightning flashes behind it.
        const s0 = cast<F>(float(170).sub(cameraPosition.y).div(dy));
        const s1 = cast<F>(min(float(330).sub(cameraPosition.y).div(dy), s0.add(1400)));
        const sds = cast<F>(s1.sub(s0).div(scudSteps));
        Loop({ start: int(0), end: int(scudSteps) }, ({ i }) => {
          const t = s0.add(float(i).add(jitter).mul(sds));
          If(ST.lessThan(0.05).or(t.greaterThan(3200)), () => {
            Break();
          });
          const pos = cast<V3>(cameraPosition.add(dir.mul(t)));
          const q = cast<V3>(pos.add(offset.mul(1.7)));
          const a = tex(cast<V3>(q.div(vec3(700, 260, 700))));
          const b = tex(cast<V3>(q.div(vec3(210, 120, 210))));
          const hh = pos.y.sub(170).div(160);
          const band = smoothstep(0, 0.3, hh).mul(smoothstep(1, 0.6, hh));
          // Scud is local: it thins out a few kilometres away so the horizon stays clean.
          const dens = smoothstep(0.58, 0.78, a.r.mul(0.7).add(b.b.mul(0.45))).mul(band).mul(smoothstep(3200, 1600, t));
          const sigma = dens.mul(0.012);
          let light: V3 = cast<V3>(vec3(0.006, 0.007, 0.009));
          for (let k = 0; k < MAX_FLASH; k++) {
            const fp = cast<V4>(u.flashPos.element(int(k)));
            light = cast<V3>(light.add(vec3(...FLASH_COLOR).mul(fp.w.mul(exp(length(pos.sub(fp.xyz)).div(-700)).mul(0.3)))));
          }
          const absorb = exp(sigma.mul(sds).negate());
          scud.addAssign(light.mul(ST).mul(float(1).sub(absorb)));
          ST.mulAssign(absorb);
        });
      });
      const above = cast<F>(smoothstep(0.004, 0.03, el));
      // Aerial perspective: the far deck fades into the horizon air.
      // Near the horizon the deck is many kilometres away: it melts into the horizon air entirely
      // (its noise would only alias there).
      const far = cast<F>(smoothstep(3500, 15000, t0));
      const horizonAir = cast<V3>(skyRadiance(s, cast<V3>(normalize(vec3(dir.x, 0.02, dir.z))), 1));
      // Far away the deck's own noise is replaced by a smooth cover (it would only alias there).
      const Teff = cast<F>(mix(T, float(0.12), far));
      const clouds = cast<V3>(mix(acc, horizonAir.mul(float(1).sub(Teff)), far));
      const deckColor = cast<V3>(mix(sky, sky.mul(Teff).add(clouds), above));
      const color = cast<V3>(mix(deckColor, scud.add(deckColor.mul(ST)), above));
      return vec4(color.mul(u.presence), 1);
    })();
    material.side = BackSide;
    // Drawn after the opaque world with the depth test on, so every pixel the land, the props or
    // the playfield cover skips the cloud march entirely.
    material.depthWrite = false;
    material.depthTest = true;
    material.fog = false;
    noBloom(material);
    const mesh = new Mesh(new SphereGeometry(p.radius, 64, 32), material);
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    void pow;
    return {
      object: mesh,
      update(frame) {
        tickStorm(s, ctx, frame);
        mesh.position.set(0, 0, 0);
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        mesh.geometry.dispose();
        material.dispose();
        releaseStorm(ctx, s);
      },
    };
  },
};
