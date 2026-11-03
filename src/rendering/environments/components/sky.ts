import { BackSide, LinearMipmapLinearFilter, Mesh, MeshBasicNodeMaterial, RepeatWrapping, SphereGeometry, SRGBColorSpace, TextureLoader, Vector3, type Node, type Texture } from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  max,
  mix,
  mx_fractal_noise_float,
  normalize,
  positionWorldDirection,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
  viewZToPerspectiveDepth,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { noBloom } from '../../shaders/uniforms';
import { colorUniform, floatUniform, zColor, zVec3 } from './common';

const schema = z.object({
  top: zColor.default('#05071a'),
  horizon: zColor.default('#1b1440'),
  bottom: zColor.default('#020208'),
  /** Optional middle colour stop (dusk and dawn skies), reached at `midHeight` above the horizon. */
  mid: zColor.optional(),
  midHeight: z.number().min(0.02).max(0.8).default(0.22),
  horizonGlow: z.number().default(0.6),
  horizonWidth: z.number().default(0.18),
  stars: z.number().min(0).max(1).default(0.5),
  starSize: z.number().default(1),
  nebula: z.number().min(0).default(0),
  nebulaA: zColor.default('#4a2aa0'),
  nebulaB: zColor.default('#1aa0c8'),
  nebulaScale: z.number().default(2.2),
  nebulaDrift: z.number().default(0.004),
  disc: z
    .object({ direction: zVec3, color: zColor, size: z.number(), halo: z.number(), intensity: z.number().default(1) })
    .optional(),
  /** A faint galactic band: dusty glow along a great circle (normal = the band's pole). */
  milkyWay: z
    .object({ strength: z.number().min(0).default(0.5), pole: zVec3.default([0.55, 0.35, 0.75]), width: z.number().default(0.16), color: zColor.default('#8a9ab8') })
    .optional(),
  bloom: z.boolean().default(false),
  /**
   * A photographic horizon band (an equirectangular panorama cropped to `elevation`, in degrees),
   * blended into the gradient above it. `offset` turns it (0..1 of a full turn).
   */
  panorama: z
    .object({
      src: z.string(),
      elevation: z.tuple([z.number(), z.number()]).default([-6, 40]),
      offset: z.number().default(0),
      exposure: z.number().min(0).default(1),
      /** Degrees over which the top of the band fades into the gradient. */
      fade: z.number().positive().default(8),
      /**
       * The photo's land hides distant 3D sky effects (aurora, clouds) farther than this many
       * units: land pixels write depth at this distance. 0 = off.
       */
      occlude: z.number().min(0).default(0),
      /**
       * A high-resolution crop of the visible directions (same elevations), used inside `uRange`
       * (fractions of the full panorama width); the band covers everything else.
       */
      detail: z.object({ src: z.string(), uRange: z.tuple([z.number(), z.number()]) }).optional(),
      /**
       * 'landscape': a horizon photo (stars only over its sky). 'space': an all-sky photo (use
       * elevation [-90, 90]); stars cover the whole sphere, denser where the photo is bright
       * (the Milky Way), and do not twinkle.
       */
      kind: z.enum(['landscape', 'space']).default('landscape'),
    })
    .optional(),
  /**
   * Night colours the sky blends to as `dusk` (a bindable 0..1) rises, and how dark the panorama
   * gets; bind dusk to game progress for a day that turns to night as you play.
   */
  dusk: z
    .object({ top: zColor.default('#05070f'), mid: zColor.default('#0b1222'), horizon: zColor.default('#1a2436'), exposure: z.number().min(0).default(0.18) })
    .optional(),
});

export type SkyParams = z.infer<typeof schema>;

/** Procedural sky dome: gradient, horizon glow, hashed stars, drifting fBm nebula, optional sun/moon disc. */
export const skyComponent: ComponentFactory<SkyParams> = {
  type: 'sky',
  version: 1,
  description: 'Gradient sky dome with stars, nebula and an optional sun or moon disc.',
  schema,
  async create(ctx, p) {
    const load = async (src: string, wrap: boolean): Promise<Texture | null> => {
      const url = ctx.assets.url(src);
      if (!url) {
        console.warn(`[sky] panorama ${src} not found`);
        return null;
      }
      const tex = await new TextureLoader().loadAsync(url);
      tex.colorSpace = SRGBColorSpace;
      if (wrap) tex.wrapS = RepeatWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.anisotropy = 8;
      return tex;
    };
    const photo = p.panorama ? await load(p.panorama.src, true) : null;
    // The detail crop costs about 170 MB of video memory; low detail settings skip it.
    const detailTex = p.panorama?.detail && ctx.quality.detail !== 'low' ? await load(p.panorama.detail.src, false) : null;
    const u = {
      top: colorUniform(p.top),
      horizon: colorUniform(p.horizon),
      bottom: colorUniform(p.bottom),
      glow: floatUniform(p.horizonGlow),
      stars: floatUniform(p.stars),
      nebula: floatUniform(p.nebula),
      nebulaA: colorUniform(p.nebulaA),
      nebulaB: colorUniform(p.nebulaB),
      discIntensity: floatUniform(p.disc?.intensity ?? 0),
      presence: floatUniform(1),
      dusk: floatUniform(0),
    };
    const dir = normalize(positionWorldDirection);
    const y = dir.y;
    const up = smoothstep(0, 0.9, y);
    const down = smoothstep(0, -0.6, y);
    const upper = p.mid
      ? mix(mix(u.horizon, colorUniform(p.mid), smoothstep(0, p.midHeight, y)), u.top, smoothstep(p.midHeight, 0.9, y))
      : mix(u.horizon, u.top, up);
    let color = mix(upper, u.bottom, down);
    const band = exp(abs(y).div(p.horizonWidth).negate()).mul(u.glow);
    color = color.add(u.horizon.mul(band));
    if (p.dusk) {
      const night = mix(mix(colorUniform(p.dusk.horizon), colorUniform(p.dusk.mid), smoothstep(0, 0.25, y)), colorUniform(p.dusk.top), smoothstep(0.25, 0.9, y));
      color = mix(color, night, u.dusk);
    }

    // Where stars may show: everywhere, except over the panorama's land (only its sky).
    let starMask: Node<'float'> = float(1);
    const space = p.panorama?.kind === 'space';
    let starDensityMod: Node<'float'> = float(1);
    let landDepth: Node<'float'> | null = null;
    if (photo && p.panorama) {
      const pano = p.panorama;
      const deg = 180 / Math.PI;
      const elev = asin(clamp(y, -1, 1)).mul(deg);
      const turn = atan(dir.x, dir.z.negate()).div(Math.PI * 2).add(pano.offset);
      const v = elev.sub(pano.elevation[0]).div(pano.elevation[1] - pano.elevation[0]);
      const darken = p.dusk ? mix(float(1), float(p.dusk.exposure), u.dusk) : float(1);
      let base: Node<'vec3'> = texture(photo, vec2(turn, v)).rgb;
      if (detailTex && pano.detail) {
        const [u0, u1] = pano.detail.uRange;
        const du = fract(turn).sub(u0).div(u1 - u0);
        const inDetail = smoothstep(0, 0.012, du).mul(smoothstep(1, 0.988, du));
        base = mix(base, texture(detailTex, vec2(du.clamp(0, 1), v)).rgb, inDetail);
      }
      const sample = base.mul(pano.exposure).mul(darken);
      const inBand = smoothstep(pano.elevation[1], pano.elevation[1] - pano.fade, elev).mul(step(pano.elevation[0], elev));
      color = mix(color, sample, inBand);
      if (space) {
        // More stars where the galaxy is bright, fewer in its dark lanes and the empty sky.
        starDensityMod = clamp(dot(base, vec3(0.2126, 0.7152, 0.0722)).mul(5).add(0.45), 0.45, 2.2);
      }
      // The photo's sky is bluer than its snow and rock; stars appear only there.
      const raw = texture(photo, vec2(turn, v)).rgb;
      const skyLike = smoothstep(0.04, 0.12, raw.b.sub(raw.r)).mul(smoothstep(0.25, 0.45, raw.g));
      if (!space) starMask = mix(float(1), skyLike, inBand);
      if (pano.occlude > 0 && !space) {
        const land = step(0.5, inBand.mul(skyLike.oneMinus()));
        const viewZ = cameraViewMatrix.mul(vec4(cameraPosition.add(dir.mul(pano.occlude)), 1)).z;
        landDepth = mix(float(1), viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar), land);
      }
    }

    if (p.nebula > 0) {
      const t = ctx.uniforms.time.mul(p.nebulaDrift);
      const n1 = mx_fractal_noise_float(dir.mul(p.nebulaScale).add(vec3(t, 0, t.mul(0.5))), 4, 2.0, 0.5).mul(0.5).add(0.5);
      const n2 = mx_fractal_noise_float(dir.mul(p.nebulaScale * 2.3).add(vec3(0, t.mul(1.3), 0)), 3, 2.0, 0.5).mul(0.5).add(0.5);
      const cloud = smoothstep(0.42, 0.95, n1).mul(smoothstep(0.3, 0.8, n2));
      color = color.add(mix(u.nebulaA, u.nebulaB, n2).mul(cloud.mul(u.nebula)));
    }

    if (p.milkyWay) {
      const mw = p.milkyWay;
      const pole = normalize(vec3(...mw.pole));
      const d = dot(dir, pole);
      const band = exp(d.mul(d).div(mw.width * mw.width).negate());
      const dust = mx_fractal_noise_float(dir.mul(5.5), 5, 2.1, 0.55).mul(0.5).add(0.5);
      const lanes = smoothstep(0.38, 0.62, mx_fractal_noise_float(dir.mul(9).add(vec3(3.1, 0, 1.7)), 4, 2, 0.5).mul(0.5).add(0.5));
      const glowMw = band.mul(dust.mul(0.7).add(0.3)).mul(lanes.mul(0.75).add(0.25)).mul(mw.strength).mul(0.16).mul(smoothstep(0, 0.12, y));
      color = color.add(colorUniform(mw.color).mul(glowMw));
    }

    // Worlds with a dusk compile the stars even when they start at zero (bound to progress).
    const starDensity = p.stars > 0 ? p.stars : p.dusk ? 1 : 0;
    if (starDensity > 0) {
      // Two layers with a steep brightness distribution (many faint stars, few bright ones),
      // jittered inside their cells so no grid shows; slight colour temperature variation.
      const layer = (density: number, cellsPerRad: number, gain: number, sharp: number) => {
        const cells = dir.mul(cellsPerRad / p.starSize);
        const id = floor(cells);
        const r = fract(sin(vec3(dot(id, vec3(127.1, 311.7, 74.7)), dot(id, vec3(269.5, 183.3, 246.1)), dot(id, vec3(113.5, 271.9, 124.6)))).mul(43758.5453));
        const local = fract(cells).sub(r.mul(0.6).add(0.2));
        const dd = local.length();
        const present = step(float(1).sub(starDensityMod.mul(starDensity * density)), r.x);
        const mag = r.y.pow(sharp);
        const tint = mix(vec3(0.75, 0.85, 1.15), vec3(1.15, 0.95, 0.75), r.z);
        const twinkle = space ? float(1) : sin(ctx.uniforms.time.mul(r.z.mul(2).add(0.8)).add(r.y.mul(40))).mul(0.12).add(0.88);
        // The brightest stars get a faint soft glow around their point.
        const glow = space ? exp(dd.mul(dd).mul(-60)).mul(smoothstep(0.55, 1, mag)).mul(0.05) : float(0);
        return tint.mul(present.mul(mag.mul(smoothstep(0.16, 0.0, dd)).add(glow)).mul(twinkle).mul(gain));
      };
      const above = space ? float(1) : smoothstep(-0.02, 0.08, y);
      const gain = p.stars > 0 ? u.stars.div(p.stars) : u.stars;
      const stars = layer(0.22, 420, 1.6, 5).add(layer(0.05, 150, 4.5, 3)).mul(above).mul(gain).mul(starMask);
      color = color.add(stars);
    }

    if (p.disc) {
      // size and halo are angular radii in degrees.
      const dDir = new Vector3(...p.disc.direction).normalize();
      const sd = uniform(dDir);
      const cosA = max(dot(dir, sd), 0);
      const r = (p.disc.size * Math.PI) / 180;
      const disc = smoothstep(Math.cos(r * 1.06), Math.cos(r), cosA);
      const haloR = (Math.max(0.1, p.disc.halo) * Math.PI) / 180;
      const halo = exp(cosA.oneMinus().mul(-2 / (haloR * haloR))).mul(0.45);
      const discColor = colorUniform(p.disc.color);
      color = color.add(discColor.mul(disc.mul(2.2).add(halo)).mul(u.discIntensity));
    }

    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color.mul(u.presence), 1);
    material.side = BackSide;
    material.depthWrite = landDepth !== null;
    if (landDepth) material.depthNode = landDepth;
    material.fog = false;
    if (!p.bloom) noBloom(material);
    const mesh = new Mesh(new SphereGeometry(900, 64, 32), material);
    mesh.renderOrder = -20;
    mesh.frustumCulled = false;
    return {
      object: mesh,
      reactive: { glow: u.glow, stars: u.stars, nebula: u.nebula, disc: u.discIntensity, dusk: u.dusk },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        mesh.geometry.dispose();
        material.dispose();
        photo?.dispose();
        detailTex?.dispose();
      },
    };
  },
};
