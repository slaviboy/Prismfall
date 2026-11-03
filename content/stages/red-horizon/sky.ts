import { BackSide, LinearMipmapLinearFilter, Mesh, MeshBasicNodeMaterial, RepeatWrapping, SphereGeometry, SRGBColorSpace, TextureLoader, type Texture } from 'three/webgpu';
import {
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
  fract,
  max,
  mix,
  mrt,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  positionWorldDirection,
  sin,
  smoothstep,
  step,
  texture,
  vec2,
  vec3,
  vec4,
  viewZToPerspectiveDepth,
} from 'three/tsl';
import { floatUniform, z, zColor, type ComponentFactory } from '@prismfall/sdk';
import { PANO, bandTexture, lin, release, world, type F, type V3 } from './shared';

const schema = z.object({
  panorama: z.object({
    src: z.string(),
    elevation: z.tuple([z.number(), z.number()]).default([-32, 40]),
    offset: z.number().default(0.5),
    exposure: z.number().min(0).default(1),
    fade: z.number().positive().default(8),
    detail: z.object({ src: z.string(), uRange: z.tuple([z.number(), z.number()]) }).optional(),
  }),
  /** The photo's land (alpha mask) writes depth this far away, so 3D beyond it passes behind. */
  occlude: z.number().min(0).default(420),
  /** Gradient above the photo band, continuing its smoky top. */
  top: zColor.default('#0d0908'),
  upper: zColor.default('#1c100c'),
  /** Drifting smoke over the photo's sky. */
  smoke: z.object({ strength: z.number().min(0).default(0.55), scale: z.number().positive().default(2.6), speed: z.number().default(0.006), lit: zColor.default('#7a2410'), dark: zColor.default('#0c0807') }).prefault({}),
  /** Distant fires glowing on the horizon (azimuth degrees from straight ahead, width, strength). */
  fires: z.array(z.tuple([z.number(), z.number(), z.number()])).default([]),
  fireColor: zColor.default('#ff5a1c'),
  /** How brightly explosions light the smoke (multiplies the shared flash). */
  flash: z.number().min(0).default(1),
  flashColor: zColor.default('#ff8a3a'),
});

type Params = z.infer<typeof schema>;

/**
 * Red Horizon's sky: the graded freight-yard photograph (band plus a high-resolution crop of the
 * visible directions) under a smoke-filled gradient, with
 *  - slow drifting smoke over the photo's sky, lit red from below near the horizon;
 *  - distant fires breathing on the skyline (slow, irregular, never on the beat);
 *  - the glow of explosions spreading through the smoke around their bearing (shared flash);
 *  - the photo's land writing depth at `occlude` metres (from the band's alpha mask), so the 3D
 *    ruins, walkers and factory stand behind the real tree line and cranes.
 */
export const skyComponent: ComponentFactory<Params> = {
  type: 'redHorizonSky',
  version: 1,
  description: 'Graded photographic horizon with drifting smoke, horizon fires, explosion glow and land occlusion.',
  schema,
  async create(ctx, p) {
    const w = world(ctx);
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
    const pano = p.panorama;
    const shared = pano.src === PANO.src;
    const band = shared ? await bandTexture(w) : await load(pano.src, true);
    const detail = pano.detail && ctx.quality.detail !== 'low' ? await load(pano.detail.src, false) : null;
    const presence = floatUniform(1);
    const dusk = floatUniform(0);
    const glow = floatUniform(1);
    const t = ctx.uniforms.time;
    const dir = normalize(positionWorldDirection);
    const y = dir.y;
    const deg = 180 / Math.PI;
    const elev = asin(clamp(y, -1, 1)).mul(deg);
    const turn = atan(dir.x, dir.z.negate()).div(Math.PI * 2).add(pano.offset);
    const v = elev.sub(pano.elevation[0]).div(pano.elevation[1] - pano.elevation[0]);
    let photo: V3 = vec3(0.05, 0.02, 0.015) as V3;
    let land: F = float(0) as F;
    if (band) {
      const s = texture(band, vec2(turn, v));
      photo = s.rgb as unknown as V3;
      land = s.a as unknown as F;
      if (detail && pano.detail) {
        const [u0, u1] = pano.detail.uRange;
        const du = fract(turn).sub(u0).div(u1 - u0);
        const inDetail = smoothstep(0, 0.012, du).mul(smoothstep(1, 0.988, du));
        const d = texture(detail, vec2(du.clamp(0, 1), v));
        photo = mix(photo, d.rgb, inDetail) as unknown as V3;
        land = mix(land, d.a, inDetail) as unknown as F;
      }
    }
    photo = photo.mul(pano.exposure).mul(float(1).sub(dusk.mul(0.35))) as V3;
    const inBand = smoothstep(pano.elevation[1], pano.elevation[1] - pano.fade, elev).mul(step(pano.elevation[0], elev));
    const above = mix(lin(p.upper), lin(p.top), smoothstep(0.55, 1.0, y));
    let color: V3 = mix(above, photo, inBand) as V3;
    // The photo's yard under and around the board stays calm and dark (the 3D ground takes over at
    // the sides and steps aside in front of the board).
    const azDeg = atan(dir.x, dir.z.negate()).abs().mul(deg);
    const yardDim = smoothstep(-1.0, -4.0, elev).mul(float(1).sub(smoothstep(14, 26, azDeg))).mul(0.5);
    color = color.mul(float(1).sub(yardDim)) as V3;
    const sky = float(1).sub(land).mul(smoothstep(-1.5, 1.0, elev));

    // ---- Drifting smoke: two fBm layers sheared by a slow wind, darker above, lit red low down.
    const sm = p.smoke;
    const drift = t.mul(sm.speed);
    const q = vec3(dir.x.add(drift), dir.y.mul(2.6), dir.z.add(drift.mul(0.4))).mul(sm.scale);
    const n1 = mx_fractal_noise_float(q.add(vec3(0, drift.mul(0.3), 0)), 4, 2.0, 0.55).mul(0.5).add(0.5);
    const n2 = mx_fractal_noise_float(q.mul(2.3).add(vec3(drift.mul(1.7), 0, 3.1)), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const density = smoothstep(0.42, 0.85, n1).mul(n2.mul(0.6).add(0.4)).mul(sm.strength);
    const low = smoothstep(18, 0, elev);
    const smokeCol = mix(lin(sm.dark), lin(sm.lit), low.mul(n2));
    color = mix(color, smokeCol, density.mul(sky).mul(smoothstep(-1, 3, elev))) as V3;

    // ---- Horizon fires: low, wide, slowly breathing orange glows on the skyline.
    let fires: V3 = vec3(0, 0, 0) as V3;
    for (const [az, width, strength] of p.fires) {
      const a = (az * Math.PI) / 180;
      // Angular distance in azimuth (wrapped) and height above the horizon.
      const azNow = atan(dir.x, dir.z.negate());
      const da = asin(sin(azNow.sub(a))).mul(deg);
      const breathe = mx_noise_float(vec3(t.mul(0.21), az * 0.37, 0)).mul(0.35).add(mx_noise_float(vec3(t.mul(0.9), az * 0.11, 2)).mul(0.12)).add(0.8);
      const dn = da.div(width);
      // A low glow hugging the skyline, only where the photo shows sky (never over the land).
      const shape = exp(dn.mul(dn).negate()).mul(exp(max(elev, 0).div(width * 0.5 + 1.5).negate())).mul(smoothstep(-0.6, 0.4, elev)).mul(sky);
      fires = fires.add(lin(p.fireColor).mul(shape.mul(breathe).mul(strength))) as V3;
    }
    color = color.add(fires.mul(glow)) as V3;

    // ---- Explosion light in the smoke around its bearing (land catches a little of it too).
    const fd = normalize(w.flashDir as unknown as V3);
    const near = max(dot(dir, fd), 0);
    const spread = near.pow(12).mul(0.7).add(near.pow(60).mul(1.6));
    // The photo's land catches only a trace (the yard below the horizon almost none).
    const landShare = mix(float(0.02), float(0.18), smoothstep(-3, 1, elev));
    const flashLight = lin(p.flashColor).mul(spread).mul(w.flash).mul(p.flash).mul(mix(landShare, float(1), sky).add(density.mul(0.8)));
    color = color.add(flashLight) as V3;

    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color.mul(presence), 1);
    material.side = BackSide;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(fires.mul(0.15).add(flashLight.mul(0.2)), 1) });
    if (p.occlude > 0) {
      const isLand = step(0.5, land.mul(inBand));
      const viewZ = cameraViewMatrix.mul(vec4(cameraPosition.add(dir.mul(p.occlude)), 1)).z;
      material.depthNode = mix(float(1), viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar), isLand);
      material.depthWrite = true;
    } else {
      material.depthWrite = false;
    }
    const mesh = new Mesh(new SphereGeometry(900, 64, 32), material);
    mesh.renderOrder = -20;
    mesh.frustumCulled = false;
    return {
      object: mesh,
      reactive: { dusk, glow },
      setPresence(val) {
        presence.value = val;
      },
      dispose() {
        mesh.geometry.dispose();
        material.dispose();
        if (!shared) band?.dispose();
        detail?.dispose();
        release(w);
      },
    };
  },
};
