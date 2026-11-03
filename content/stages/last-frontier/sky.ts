import { BackSide, LinearMipmapLinearFilter, Mesh, MeshBasicNodeMaterial, RepeatWrapping, SphereGeometry, SRGBColorSpace, TextureLoader, Vector3, type Texture } from 'three/webgpu';
import { abs, asin, atan, clamp, dot, exp, float, floor, fract, max, mix, normalize, positionWorldDirection, sin, smoothstep, step, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { colorUniform, floatUniform, noBloom, z, zColor, type ComponentFactory } from '@prismfall/sdk';
import { frontier, releaseFrontier, tickFrontier, skyDirection, type F, type V3 } from './shared';

const schema = z.object({
  panorama: z.object({
    src: z.string(),
    elevation: z.tuple([z.number(), z.number()]).default([-6, 40]),
    offset: z.number().default(0),
    fade: z.number().positive().default(8),
    detail: z.object({ src: z.string(), uRange: z.tuple([z.number(), z.number()]) }).optional(),
  }),
  /** Gradient above the photo (continues its top colour). */
  top: zColor.default('#3d6ca8'),
  mid: zColor.default('#85a9ce'),
  /** Night gradient. */
  nightTop: zColor.default('#03050c'),
  nightHorizon: zColor.default('#0d1424'),
  /** Afterglow colour along the horizon towards the sun at sunset and blue hour. */
  afterglow: zColor.default('#ff8a4a'),
  moon: z
    .object({
      azimuth: z.number().default(-52),
      elevation: z.number().default(38),
      size: z.number().default(0.28),
      color: zColor.default('#e8eefc'),
    })
    .prefault({}),
  stars: z.number().min(0).max(1).default(0.7),
});

type Params = z.infer<typeof schema>;

/**
 * The photographic sky with a day that turns: the Goegap Road panorama graded from golden
 * afternoon through sunset and blue hour to a moonlit night with stars over the photo's sky only.
 */
export const frontierSky: ComponentFactory<Params> = {
  type: 'frontierSky',
  version: 1,
  description: 'Photographic sky graded through golden afternoon, sunset, blue hour and night (stars, moon), driven by game progress.',
  schema,
  async create(ctx, p) {
    const s = frontier(ctx);
    const load = async (src: string, wrap: boolean): Promise<Texture | null> => {
      const url = ctx.assets.url(src);
      if (!url) return null;
      const tex = await new TextureLoader().loadAsync(url);
      tex.colorSpace = SRGBColorSpace;
      if (wrap) tex.wrapS = RepeatWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.anisotropy = 8;
      return tex;
    };
    const photo = await load(p.panorama.src, true);
    const detailTex = p.panorama.detail && ctx.quality.detail !== 'low' ? await load(p.panorama.detail.src, false) : null;
    const presence = floatUniform(1);
    const u = s.u;

    const dir = normalize(positionWorldDirection);
    const y = dir.y;
    const deg = 180 / Math.PI;
    const elev = asin(clamp(y, -1, 1)).mul(deg);
    const pano = p.panorama;
    const turn = atan(dir.x, dir.z.negate())
      .div(Math.PI * 2)
      .add(pano.offset);
    const v = elev.sub(pano.elevation[0]).div(pano.elevation[1] - pano.elevation[0]);
    let base: V3 = (photo ? texture(photo, vec2(turn, v)).rgb : vec3(0.5, 0.6, 0.7)) as V3;
    if (detailTex && pano.detail) {
      const [u0, u1] = pano.detail.uRange;
      const du = fract(turn)
        .sub(u0)
        .div(u1 - u0);
      const inDetail = smoothstep(0, 0.012, du).mul(smoothstep(1, 0.988, du));
      base = mix(base, texture(detailTex, vec2(du.clamp(0, 1), v)).rgb, inDetail) as V3;
    }
    // Sky pixels are bluer than the land; the grade treats them differently (afterglow, stars).
    const raw = (photo ? texture(photo, vec2(turn, v)).rgb : vec3(0.5, 0.6, 0.8)) as V3;
    const skyLike = smoothstep(0.03, 0.1, raw.b.sub(raw.r)).mul(smoothstep(0.2, 0.4, raw.g)) as F;
    const inBand = smoothstep(pano.elevation[1], pano.elevation[1] - pano.fade, elev).mul(step(pano.elevation[0], elev)) as F;

    // Day gradient above the photo, the night gradient it turns into.
    const dayGrad = mix(colorUniform(p.mid), colorUniform(p.top), smoothstep(0.35, 0.95, y)) as V3;
    const nightGrad = mix(colorUniform(p.nightHorizon), colorUniform(p.nightTop), smoothstep(0.0, 0.7, y)) as V3;
    const luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
    // Grade: tint and exposure from the time of day; at night the land goes nearly black and the
    // sky deep blue, desaturated as the eye sees it.
    const desat = mix(
      base,
      vec3(luma, luma, luma).mul(vec3(0.85, 0.92, 1.1)),
      u.night
        .mul(0.55)
        .add(smoothstep(0.45, 0.66, u.tod).mul(skyLike.oneMinus()).mul(0.35))
        .min(0.85),
    ) as V3;
    const graded = desat.mul(u.photoTint).mul(u.photoExposure) as V3;
    // Once the sun is down the land loses its sunlit glow faster than the sky darkens.
    const dusk = smoothstep(0.42, 0.66, u.tod);
    const landNight = mix(float(1), float(0.42), dusk.mul(skyLike.oneMinus())).mul(mix(float(1), float(0.6), u.night.mul(skyLike.oneMinus())));
    let color: V3 = mix(dayGrad.mul(u.photoTint).mul(u.photoExposure), graded.mul(landNight), inBand) as V3;
    color = mix(color, nightGrad, u.night.mul(mix(float(0.85), float(0.55), inBand.mul(skyLike.oneMinus())))) as V3;

    // Afterglow: a warm band along the horizon on the sun's side, strongest after sunset.
    const sunDir = u.sunDir;
    const along = max(dot(normalize(vec3(dir.x, 0, dir.z)), normalize(vec3(sunDir.x, 0, sunDir.z))), 0);
    const glowAmount = smoothstep(0.16, 0.44, u.tod).mul(smoothstep(0.86, 0.6, u.tod));
    const band = exp(abs(y.sub(0.02)).div(0.09).negate())
      .mul(along.pow(2.2))
      .mul(glowAmount);
    color = color.add(colorUniform(p.afterglow).mul(band.mul(0.7).mul(mix(float(1), skyLike, inBand)))) as V3;

    // Stars: two hashed layers, only over sky (never over the photo's land), fading in at night.
    const layer = (density: number, cellsPerRad: number, gain: number, sharp: number): V3 => {
      const cells = dir.mul(cellsPerRad);
      const id = floor(cells);
      const r = fract(sin(vec3(dot(id, vec3(127.1, 311.7, 74.7)), dot(id, vec3(269.5, 183.3, 246.1)), dot(id, vec3(113.5, 271.9, 124.6)))).mul(43758.5453));
      const local = fract(cells).sub(r.mul(0.6).add(0.2));
      const dd = local.length();
      const present = step(float(1 - density), r.x);
      const mag = r.y.pow(sharp);
      const tint = mix(vec3(0.75, 0.85, 1.15), vec3(1.15, 0.95, 0.75), r.z);
      const twinkle = sin(ctx.uniforms.time.mul(r.z.mul(2).add(0.8)).add(r.y.mul(40)))
        .mul(0.12)
        .add(0.88);
      return tint.mul(
        present
          .mul(mag.mul(smoothstep(0.16, 0.0, dd)))
          .mul(twinkle)
          .mul(gain),
      ) as V3;
    };
    const starMask = mix(float(1), skyLike, inBand)
      .mul(smoothstep(-0.01, 0.08, y))
      .mul(u.night)
      .mul(p.stars);
    color = color.add(
      layer(0.22, 420, 1.6, 5)
        .add(layer(0.05, 150, 4.5, 3))
        .mul(starMask),
    ) as V3;

    // The moon, with a soft halo, once the light has gone.
    const moonDir = uniform(skyDirection(p.moon.azimuth, p.moon.elevation, new Vector3()));
    const cosA = max(dot(dir, moonDir), 0);
    const r = (p.moon.size * Math.PI) / 180;
    const disc = smoothstep(Math.cos(r * 1.08), Math.cos(r), cosA);
    const halo = exp(cosA.oneMinus().mul(-2 / (0.06 * 0.06))).mul(0.18);
    color = color.add(colorUniform(p.moon.color).mul(disc.mul(1.6).add(halo)).mul(u.night)) as V3;

    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color.mul(presence), 1);
    material.side = BackSide;
    material.depthWrite = false;
    material.fog = false;
    noBloom(material);
    const mesh = new Mesh(new SphereGeometry(900, 64, 32), material);
    mesh.renderOrder = -20;
    mesh.frustumCulled = false;
    return {
      object: mesh,
      update(frame) {
        tickFrontier(s, frame);
      },
      setPresence(value) {
        presence.value = value;
      },
      dispose() {
        mesh.geometry.dispose();
        material.dispose();
        photo?.dispose();
        detailTex?.dispose();
        releaseFrontier(ctx, s);
      },
    };
  },
};
