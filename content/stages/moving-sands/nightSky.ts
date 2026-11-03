import { BackSide, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Node } from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  asin,
  atan,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  mx_cell_noise_float,
  mx_cell_noise_vec3,
  mx_fractal_noise_float,
  modelWorldMatrix,
  mx_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  screenCoordinate,
  screenSize,
  sign,
  sin,
  smoothstep,
  sqrt,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { colorUniform, floatUniform, noBloom, z, zColor, type ComponentFactory } from '@prismfall/sdk';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** [azimuth, elevation] in degrees: azimuth 0 = straight ahead (−z), positive to the right. */
const zDir = z.tuple([z.number(), z.number()]);

const schema = z.object({
  /**
   * Sky colours are scene radiance, as hex in the engine's colour convention (linearised twice:
   * #797a7e is about 0.03). The grade's contrast and tone-mapping toe crush everything under about
   * 0.02, so a night sky lives just above it.
   */
  zenith: zColor.default('#78797f'),
  horizon: zColor.default('#89898a'),
  /** Elevation (degrees) over which the horizon colour gives way to the zenith. */
  horizonHeight: z.number().positive().default(8),
  below: zColor.default('#797a7c'),
  /** Airglow: a faint green band a few degrees up (oxygen at 90 km), red higher, slowly drifting wave bands. */
  airglow: z
    .object({
      color: zColor.default('#37452a'),
      red: zColor.default('#331e25'),
      strength: z.number().min(0).default(1),
      waves: z.number().min(0).max(1).default(0.35),
      drift: z.number().default(0.006),
    })
    .prefault({}),
  /** A warm glow hugging the horizon in one direction (zodiacal light, a far settlement). */
  glow: z
    .object({ color: zColor.default('#564c33'), azimuth: z.number().default(-60), spread: z.number().default(70), height: z.number().positive().default(4), strength: z.number().min(0).default(1) })
    .prefault({}),
  /** A cool brightening towards the moon (off screen; it lights the dunes). */
  moonGlow: z
    .object({ direction: zDir.default([62, 10]), color: zColor.default('#273146'), width: z.number().positive().default(40), strength: z.number().min(0).default(1) })
    .prefault({}),
  milkyWay: z
    .object({
      /** The galactic centre's direction at the start. */
      center: zDir.default([-27, 7]),
      /** Angle of the band above the horizontal at the centre, rising towards positive galactic longitude. */
      tilt: z.number().default(30),
      strength: z.number().min(0).default(1),
      core: zColor.default('#f4f0e7'),
      disk: zColor.default('#c1c6d1'),
      /** Dust lanes and the Great Rift (0 = none). */
      dust: z.number().min(0).default(1),
      /** Pink emission nebulae along the plane. */
      emission: z.number().min(0).default(1),
      seed: z.number().default(3),
    })
    .prefault({}),
  /** The Large and Small Magellanic Clouds of a southern sky (they turn with the stars). */
  magellanic: z
    .object({
      large: zDir.default([27, 13]),
      small: zDir.default([40, 10]),
      /** Long-axis angle of the Large Cloud on the sky (degrees). */
      angle: z.number().default(25),
      color: zColor.default('#b6b9c2'),
      strength: z.number().min(0).default(1),
    })
    .prefault({}),
  stars: z
    .object({
      density: z.number().min(0).max(3).default(1),
      brightness: z.number().min(0).default(1),
      /** Scintillation, stronger low in the sky. */
      twinkle: z.number().min(0).max(1).default(0.5),
      /** Point size multiplier (pixels). */
      size: z.number().positive().default(1),
    })
    .prefault({}),
  /** Atmospheric extinction per airmass (stars and the Milky Way dim and redden near the horizon). */
  extinction: z.number().min(0).default(0.07),
  /** The night turning: the sky rotates about the celestial pole at `speed` × the sidereal rate, swinging within ±`range` degrees. */
  rotation: z.object({ pole: zDir.default([85, 24]), speed: z.number().default(1.5), range: z.number().min(0).default(8) }).prefault({}),
  /** Dither amplitude (scene-linear) against banding in the dark gradient. */
  dither: z.number().min(0).default(0.0007),
});

type Params = z.infer<typeof schema>;

const DEG = Math.PI / 180;
const SIDEREAL = (2 * Math.PI) / 86164.1;

function dirOf([az, el]: readonly [number, number]): Vector3 {
  return new Vector3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), -Math.cos(az * DEG) * Math.cos(el * DEG));
}

/** Star colour from a uniform random number: a few hot blue-white stars, mostly white to yellow, some orange and red giants. */
function starColor(h: F): V3 {
  let c: V3 = mix(vec3(0.66, 0.77, 1.0), vec3(0.97, 0.98, 1.0), smoothstep(0.03, 0.16, h));
  c = mix(c, vec3(1.0, 0.93, 0.83), smoothstep(0.62, 0.8, h));
  c = mix(c, vec3(1.0, 0.75, 0.52), smoothstep(0.86, 0.95, h));
  return mix(c, vec3(1.0, 0.6, 0.42), smoothstep(0.965, 1.0, h));
}

/**
 * The Moving Sands night sky, entirely generated: an airglow gradient, a Milky Way in galactic
 * coordinates (bulge, star clouds, dust lanes and the Great Rift, emission knots), three layers of
 * stars with a steep brightness distribution, real colours and pixel-sized points, and the slow turn
 * of the night about the celestial pole.
 */
export const sandsNightSky: ComponentFactory<Params> = {
  type: 'sandsNightSky',
  version: 1,
  description: 'Generated desert night sky: airglow, Milky Way with dust lanes, coloured twinkling stars, slow sky rotation.',
  schema,
  create(ctx, p) {
    const time = ctx.uniforms.time;
    const u = {
      presence: floatUniform(1),
      stars: floatUniform(p.stars.brightness),
      glow: floatUniform(1),
      milkyWay: floatUniform(p.milkyWay.strength),
      // The galactic frame (rotates with the sky): centre, +longitude and north pole.
      gc: uniform(new Vector3()),
      ge: uniform(new Vector3()),
      gn: uniform(new Vector3()),
    };

    // ---- The galactic frame at the start, and the celestial pole it turns about. ----
    const mw = p.milkyWay;
    const c0 = dirOf(mw.center);
    const az = mw.center[0] * DEG;
    const el = mw.center[1] * DEG;
    const right = new Vector3(Math.cos(az), 0, Math.sin(az));
    const upv = new Vector3(-Math.sin(az) * Math.sin(el), Math.cos(el), Math.cos(az) * Math.sin(el));
    const t0 = right.multiplyScalar(Math.cos(mw.tilt * DEG)).add(upv.multiplyScalar(Math.sin(mw.tilt * DEG))).normalize();
    const n0 = new Vector3().crossVectors(c0, t0).normalize();
    const e0 = new Vector3().crossVectors(n0, c0).normalize();
    // A direction's fixed coordinates in the galactic frame, and a tangent basis around it.
    const inFrame = (dir: readonly [number, number]): { c: Vector3; t1: Vector3; t2: Vector3 } => {
      const v = dirOf(dir);
      const c = new Vector3(v.dot(c0), v.dot(e0), v.dot(n0)).normalize();
      const t1 = new Vector3().crossVectors(new Vector3(0, 0, 1), c).normalize();
      const t2 = new Vector3().crossVectors(c, t1).normalize();
      return { c, t1, t2 };
    };
    const lmc = inFrame(p.magellanic.large);
    const smc = inFrame(p.magellanic.small);
    const pole = dirOf(p.rotation.pole);
    const range = Math.max(1e-6, p.rotation.range * DEG);
    let clock = 0;
    const setFrame = (): void => {
      // Starts at the sidereal rate and swings back within ±range over a long session.
      const angle = range * Math.sin((clock * SIDEREAL * p.rotation.speed) / range);
      u.gc.value.copy(c0).applyAxisAngle(pole, angle);
      u.ge.value.copy(e0).applyAxisAngle(pole, angle);
      u.gn.value.copy(n0).applyAxisAngle(pole, angle);
    };
    setFrame();

    const d = normalize(positionWorld.sub(cameraPosition));
    const sinE = max(d.y, 0);
    const eDeg = asin(clamp(d.y, -1, 1)).mul(1 / DEG);
    const ePos = max(eDeg, 0);

    // ---- Gradient, airglow, horizon glows. ----
    let sky: V3 = mix(colorUniform(p.zenith), colorUniform(p.horizon), exp(ePos.div(p.horizonHeight).negate()));
    {
      // Van Rhijn brightening of a thin emitting shell (0 at the zenith, 1 at the horizon), with
      // a dip in the last degrees where the low air absorbs it.
      const cos2 = float(1).sub(sinE.mul(sinE));
      const vr = float(1).div(sqrt(float(1).sub(cos2.mul(0.972)))).sub(1).div(4.98);
      const profile = vr.mul(float(1).sub(exp(ePos.div(1.6).negate()).mul(0.55)));
      // Wave bands drifting across the sky (gravity waves in the airglow layer), long and faint.
      const ag = p.airglow;
      const wx = dot(d.xz, vec2(0.83, 0.56));
      const wz = dot(d.xz, vec2(-0.56, 0.83));
      const waves = mx_noise_float(vec3(wx.mul(5.5).add(time.mul(ag.drift)), ePos.mul(0.09), wz.mul(2.2))).mul(ag.waves).add(1);
      const red = exp(eDeg.sub(24).div(11).pow2().negate());
      sky = sky.add(colorUniform(ag.color).mul(profile).add(colorUniform(ag.red).mul(red)).mul(waves).mul(ag.strength));
      // Warm glow on the horizon in one direction.
      const g = p.glow;
      const gdir = vec2(Math.sin(g.azimuth * DEG), -Math.cos(g.azimuth * DEG));
      const flat = normalize(vec2(d.x, d.z).add(vec2(1e-5, 0)));
      const cosA = dot(flat, gdir);
      const along = exp(float(1).sub(cosA).div(1 - Math.cos(g.spread * DEG)).negate());
      sky = sky.add(colorUniform(g.color).mul(along.mul(exp(ePos.div(g.height).negate())).mul(g.strength).mul(u.glow)));
      // Cool skylight towards the moon.
      const m = p.moonGlow;
      const md = dirOf(m.direction);
      const cosM = dot(d, vec3(md.x, md.y, md.z));
      sky = sky.add(colorUniform(m.color).mul(exp(float(1).sub(cosM).div(1 - Math.cos(m.width * DEG)).negate()).mul(m.strength)));
    }

    // ---- Extinction (Kasten–Young airmass) near the horizon. ----
    const airmass = float(1).div(sinE.add(exp(sinE.mul(-11)).mul(0.025)));
    const ext = exp(airmass.mul(-p.extinction));
    const redden = mix(vec3(1, 0.92, 0.8), vec3(1, 1, 1), ext);
    const above = smoothstep(-0.004, 0.012, d.y);

    // ---- Galactic coordinates. ----
    const g = vec3(dot(d, u.gc), dot(d, u.ge), dot(d, u.gn));

    // Star cube map in the galactic frame (an equal-angle cube map, one jittered star per cell).
    const a3 = abs(g);
    const isX = step(a3.y, a3.x).mul(step(a3.z, a3.x));
    const isY = float(1).sub(isX).mul(step(a3.z, a3.y));
    const isZ = float(1).sub(isX).sub(isY);
    const uvFace = vec2(g.y, g.z)
      .div(max(a3.x, 1e-4))
      .mul(isX)
      .add(vec2(g.x, g.z).div(max(a3.y, 1e-4)).mul(isY))
      .add(vec2(g.x, g.y).div(max(a3.z, 1e-4)).mul(isZ));
    const face = isX.mul(sign(g.x).add(1)).add(isY.mul(sign(g.y).add(5))).add(isZ.mul(sign(g.z).add(9)));
    const st = atan(uvFace).mul(2 / Math.PI).add(0.5);
    // One pixel's angle: projection[1][1] = 1 / tan(fov / 2).
    const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
    const pixel = float(2).div(p11.mul(screenSize.y));
    const lowSky = float(1).sub(smoothstep(0.0, 0.42, sinE));
    const twinkleAmt = lowSky.mul(0.45).add(0.12).mul(p.stars.twinkle);
    const density = p.stars.density;
    const layer = (share: F, cellsPerFace: number, sharp: number, gain: number, seed: number, twinkles: boolean, sigmaCap = 0.13, cool = 0): V3 => {
      const cells = st.mul(cellsPerFace);
      const id = floor(cells);
      const f = fract(cells);
      const h1 = mx_cell_noise_vec3(vec3(id, face.mul(97).add(seed)));
      const h2 = mx_cell_noise_vec3(vec3(id.add(vec2(311, 173)), face.mul(97).add(seed + 51)));
      const cellPx = float(Math.PI / 2 / cellsPerFace).div(pixel);
      const dpx = length(f.sub(h1.xy.mul(0.36).add(0.32))).mul(cellPx);
      const present = step(float(1).sub(share), h1.z);
      const mag = pow(h2.x, sharp);
      const sigma = min(mag.mul(0.6).add(0.48).mul(p.stars.size), cellPx.mul(sigmaCap));
      const core = exp(dpx.mul(dpx).div(sigma.mul(sigma).mul(-2)));
      const haloS = sigma.mul(2.6);
      const halo = exp(dpx.mul(dpx).div(haloS.mul(haloS).mul(-2))).mul(smoothstep(0.45, 1, mag)).mul(0.035);
      let light: F = core.add(halo).mul(mag).mul(present).mul(gain);
      if (twinkles) {
        const tw = sin(time.mul(h2.z.mul(4.5).add(2.2)).add(h2.y.mul(40))).mul(sin(time.mul(h2.x.mul(2.1).add(1.1)).add(h2.z.mul(17))));
        light = light.mul(tw.mul(twinkleAmt).add(1));
      }
      return mix(starColor(h2.y), vec3(0.86, 0.92, 1.0), cool).mul(light);
    };

    const skyColor = Fn(() => {
      const col = sky.toVar();
      // Stars crowd into the band and thin out in its dust; the grain of unresolved stars follows
      // the band's luminous structure. Away from the band both keep their base values, and the
      // Milky Way's noise is not evaluated at all.
      const starDensity = float(0.45).toVar();
      const glowShare = float(0).toVar();
      const bDeg = asin(clamp(g.z, -1, 1)).mul(1 / DEG);
      If(abs(bDeg).lessThan(30).and(d.y.greaterThan(-0.03)), () => {
        const lDeg = atan(g.y, g.x).mul(1 / DEG);
        const sd = mw.seed * 3.7;
        // The band narrows and dims away from the centre; a faint halo fades it into the sky.
        const lon = exp(lDeg.div(48).pow2().negate()).mul(0.72).add(0.28);
        const sigma = exp(lDeg.div(32).pow2().negate()).mul(2.4).add(1.7);
        const disk = lon.mul(exp(bDeg.div(sigma).pow2().mul(-0.5)));
        const halo = lon.mul(exp(bDeg.div(sigma.mul(2.4)).pow2().mul(-0.5))).mul(0.08);
        // The bulge: a broad cream-yellow glow with a brighter nucleus, elongated along the plane.
        const bulge = exp(lDeg.div(7).pow2().add(bDeg.div(4.6).pow2()).mul(-0.5)).add(exp(lDeg.div(3.5).pow2().add(bDeg.div(2.6).pow2()).mul(-0.5)).mul(0.6));
        // Unresolved star clouds at three scales, all longer along the band than across it.
        const c1 = mx_fractal_noise_float(vec3(lDeg.mul(0.13), bDeg.mul(0.2), sd), 3, 2.0, 0.5);
        const c2 = mx_noise_float(vec3(lDeg.mul(0.5), bDeg.mul(0.6), sd + 5.3));
        const c3 = mx_noise_float(vec3(lDeg.mul(1.6), bDeg.mul(1.8), sd + 9.1));
        const clouds = smoothstep(-0.35, 0.75, c1.add(c2.mul(0.35))).mul(1.1).add(0.35).mul(c3.mul(0.18).add(1));
        // The Great Rift: a dark lane along the band's axis, north of the midplane, meandering
        // slowly; towards positive longitude it splits into two branches that drift apart and
        // rejoin. Soft but defined, ragged edges; its opacity breaks up in long patches along it.
        const bc = mx_noise_float(vec3(lDeg.mul(0.035), sd + 2.1, 0.5)).mul(1.6).add(0.9);
        const split = smoothstep(-2, 25, lDeg).mul(mx_noise_float(vec3(lDeg.mul(0.06), sd + 3.3, 1.5)).mul(0.6).add(0.6)).mul(2.6).max(0);
        const rag = mx_noise_float(vec3(lDeg.mul(0.9), bDeg.mul(1.1), sd + 7.7)).mul(0.45);
        const wLane = exp(lDeg.div(30).pow2().negate()).mul(0.9).add(0.75);
        const lane1 = smoothstep(wLane, wLane.mul(0.3), abs(bDeg.sub(bc.add(split.mul(0.5))).add(rag)));
        const lane2 = smoothstep(wLane.mul(0.8), wLane.mul(0.25), abs(bDeg.sub(bc.sub(split.mul(0.5))).add(rag))).mul(smoothstep(2, 14, lDeg));
        const along = smoothstep(-0.35, 0.35, mx_fractal_noise_float(vec3(lDeg.mul(0.09), bDeg.mul(0.25), sd + 11.3), 2, 2.0, 0.5)).mul(0.75).add(0.25);
        // Dark clumps and knots in and beside the rift, so it is never a clean airbrushed lane.
        const clumpN = mx_noise_float(vec3(lDeg.mul(0.34), bDeg.mul(0.48), sd + 13.9));
        const clumps = smoothstep(0.3, 0.72, clumpN).mul(exp(bDeg.sub(bc).div(wLane.mul(2.4)).pow2().negate()));
        const tau = max(lane1, lane2).mul(along).mul(smoothstep(-0.45, 0.4, clumpN).mul(0.8).add(0.45)).mul(1.5).add(clumps.mul(0.85)).mul(lon.mul(0.6).add(0.4)).mul(mw.dust);
        // Dust dims blue most: its edges turn warm brown.
        const trans = exp(vec3(0.86, 1, 1.16).mul(tau.negate()));
        // A warm core, neutral to slightly cool arms.
        const coreMix = exp(lDeg.div(10).pow2().mul(-0.5)).mul(0.6);
        const diskCol = mix(colorUniform(mw.disk), colorUniform(mw.core), coreMix);
        let galaxy: V3 = diskCol.mul(disk.mul(clouds).add(halo)).add(colorUniform(mw.core).mul(bulge.mul(clouds.mul(0.3).add(0.7)).mul(3.6)));
        galaxy = galaxy.mul(trans);
        // A few faint pink emission nebulae close to the plane.
        const knots = smoothstep(0.72, 0.95, mx_noise_float(vec3(lDeg.mul(0.5), bDeg.mul(0.6), sd + 17.5)))
          .mul(exp(bDeg.div(2.2).pow2().negate()))
          .mul(exp(lDeg.div(40).pow2().negate()));
        galaxy = galaxy.add(vec3(1.0, 0.32, 0.45).mul(knots.mul(0.025 * mw.emission)).mul(trans.y));
        const edge = smoothstep(30, 22, abs(bDeg));
        col.addAssign(galaxy.mul(0.095).mul(u.milkyWay).mul(ext).mul(redden).mul(above).mul(edge));
        glowShare.assign(clamp(disk.mul(clouds).mul(0.55).add(bulge.mul(0.5)).mul(trans.y), 0, 0.95));
        starDensity.assign(clamp(disk.mul(clouds).mul(1.3).add(bulge.mul(1.2)).mul(trans.y).mul(1.7).add(0.45), 0.4, 2.4));
      });
      // The Magellanic Clouds: a barred, mottled glow with the pink Tarantula nebula (large), a
      // smaller cloud with its wing and the globular cluster 47 Tucanae beside it (small). Only
      // evaluated near their directions.
      const mc = p.magellanic;
      if (mc.strength > 0) {
        const cloudCol = colorUniform(mc.color);
        const pink = vec3(1.0, 0.34, 0.5);
        const ca = Math.cos(mc.angle * DEG);
        const sa = Math.sin(mc.angle * DEG);
        const cloud = (frame: { c: Vector3; t1: Vector3; t2: Vector3 }, radius: number, shape: (x: F, y: F) => { glow: F; nebula: F; cluster: F }): void => {
          const cosA = dot(g, vec3(frame.c.x, frame.c.y, frame.c.z));
          If(cosA.greaterThan(Math.cos(radius * DEG)).and(d.y.greaterThan(-0.03)), () => {
            const x = dot(g, vec3(frame.t1.x, frame.t1.y, frame.t1.z)).div(cosA).mul(1 / DEG);
            const y = dot(g, vec3(frame.t2.x, frame.t2.y, frame.t2.z)).div(cosA).mul(1 / DEG);
            const xr = x.mul(ca).sub(y.mul(sa));
            const yr = x.mul(sa).add(y.mul(ca));
            const sh = shape(xr, yr);
            const light = cloudCol.mul(sh.glow.mul(0.19)).add(pink.mul(sh.nebula.mul(0.018))).add(vec3(1, 0.95, 0.85).mul(sh.cluster.mul(0.05)));
            col.addAssign(light.mul(mc.strength).mul(ext).mul(redden).mul(above));
            glowShare.assign(max(glowShare, clamp(sh.glow.mul(0.7), 0, 0.9)));
          });
        };
        cloud(lmc, 8, (x, y) => {
          const body = exp(x.div(4.6).pow2().add(y.div(3.5).pow2()).negate());
          const bar = exp(x.div(2.4).pow2().add(y.div(0.75).pow2()).negate());
          const mottle = smoothstep(-0.5, 0.8, mx_fractal_noise_float(vec3(x.mul(0.55), y.mul(0.55), 3.1), 3, 2.0, 0.5)).mul(1.1).add(0.3);
          const dt = length(vec2(x.sub(1.9), y.sub(1.1)));
          return { glow: body.mul(0.55).add(bar.mul(0.8)).mul(mottle), nebula: exp(dt.div(0.32).pow2().negate()).mul(0.9).add(exp(dt.div(0.9).pow2().negate()).mul(0.25)), cluster: float(0) };
        });
        cloud(smc, 5, (x, y) => {
          const body = exp(x.div(1.7).pow2().add(y.div(1.0).pow2()).negate()).add(exp(x.sub(1.6).div(1.1).pow2().add(y.add(0.4).div(0.6).pow2()).negate()).mul(0.35));
          const mottle = smoothstep(-0.5, 0.8, mx_noise_float(vec3(x.mul(0.9), y.mul(0.9), 8.3))).mul(0.9).add(0.45);
          const dk = length(vec2(x.add(2.6), y.sub(1.0)));
          return { glow: body.mul(0.6).mul(mottle), nebula: exp(length(vec2(x.sub(0.5), y.add(0.2))).div(0.25).pow2().negate()).mul(0.4), cluster: exp(dk.div(0.1).pow2().negate()).mul(1.2).add(exp(dk.div(0.28).pow2().negate()).mul(0.25)) };
        });
      }
      // Faint, medium and bright field stars, plus the grain inside the Milky Way.
      const stars = layer(starDensity.mul(0.4 * density), 520, 2.6, 0.2, 1, false)
        .add(layer(starDensity.mul(0.3 * density), 250, 8, 0.9, 2, true))
        .add(layer(starDensity.mul(0.22 * density), 105, 9, 4, 3, true))
        .toVar();
      If(glowShare.greaterThan(0.002), () => {
        stars.addAssign(layer(glowShare.mul(density), 640, 1.6, 0.07, 4, false, 0.2, 0.6));
      });
      col.addAssign(stars.mul(u.stars).mul(ext).mul(redden).mul(above));
      // Below the horizon (seen only past the dunes' ends): dim ground haze.
      col.assign(mix(col, colorUniform(p.below), smoothstep(0, -0.06, d.y)));
      // Triangular dither against banding in the dark gradient.
      const n1 = mx_cell_noise_float(vec3(screenCoordinate.xy, 3));
      const n2 = mx_cell_noise_float(vec3(screenCoordinate.xy.add(vec2(17.3, 41.9)), 11));
      col.addAssign(n1.add(n2).sub(1).mul(p.dither));
      return col;
    })() as unknown as V3;

    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(skyColor, 1);
    // Drawn after the opaque world (the first transparent), at the far plane (clip z = w), so the
    // depth test skips every pixel the ground and dunes already cover; during a stage crossfade it
    // blends over the other world's sky by presence.
    material.transparent = true;
    material.opacityNode = u.presence;
    material.vertexNode = Fn(() => {
      const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(positionLocal, 1))));
      return vec4(clip.x, clip.y, clip.w, clip.w);
    })();
    material.side = BackSide;
    material.depthWrite = false;
    material.fog = false;
    noBloom(material);
    const mesh = new Mesh(new SphereGeometry(900, 64, 32), material);
    mesh.renderOrder = -20;
    mesh.frustumCulled = false;
    return {
      object: mesh,
      reactive: { stars: u.stars, glow: u.glow, milkyWay: u.milkyWay },
      update(frame) {
        clock += frame.dt;
        setFrame();
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        mesh.geometry.dispose();
        material.dispose();
      },
    };
  },
};
