import { Group, Mesh, MeshBasicNodeMaterial, type Material, type MeshStandardMaterial, type Texture } from 'three/webgpu';
import { float, mrt, positionWorld, texture, uv, vec4 } from 'three/tsl';
import { clearFront, colorUniform, floatUniform, z, zColor, type ComponentFactory } from '@prismfall/sdk';
import { canopyTime, leafFlicker, zSun } from './env';

/**
 * The city's stone, baked in Blender with Cycles (assets/blender/scripts/lost_kingdom.py): every
 * group GLB carries two textures on one UV set. The base colour texture holds the albedo (the
 * photographed limestone, rubble, plaster, moss and leaf litter as mixed in the shader) in RGB and
 * the direct sun through the canopy in alpha; the emissive texture holds the light from the
 * photographed surroundings and the sun's bounce in RGB and the carved-glyph mask in alpha. The
 * game recombines them, so the sun can drift with the leaves and the glyphs can warm faintly with
 * the music while the shading stays the path-traced one.
 */

const groupSchema = z.object({
  src: z.string(),
  /** The bake's sun scale for this group (lost_kingdom.meta.json, groups.<name>.sunEff). */
  sunEff: z.number().positive(),
  envScale: z.number().positive().default(2),
  /** Extra exposure for this group (lifts a shaded group without a new bake). */
  exposure: z.number().min(0).default(1),
});

const schema = z.object({
  groups: z.array(groupSchema).min(1).max(8),
  sun: zSun.prefault({}),
  /** Overall exposure of the baked light, sky light and sun separately. */
  exposure: z.number().min(0).default(1),
  sky: z.number().min(0).default(1),
  sunGain: z.number().min(0).default(1),
  /** How much the sun patches flicker as the leaves move. */
  flicker: z.number().min(0).max(0.5).default(0.1),
  /** Glyph glow colour and strength (bindable as `glow`; 0 by default). */
  glowColor: zColor.default('#7fe0b4'),
  glow: z.number().min(0).default(0),
  /**
   * The world clear wave (SDK 1.5): as a front passes, the carved glyphs wake in their jade glow
   * (`glyph`) and the stone catches a soft sheen of light (`sheen`, in `color`). Light only, never
   * sent to bloom; 0 (off) by default.
   */
  clearWave: z.object({ glyph: z.number().min(0).default(0), sheen: z.number().min(0).default(0), color: zColor.default('#fff2d0') }).prefault({}),
});
type Params = z.infer<typeof schema>;

export const lostKingdomRuins: ComponentFactory<Params> = {
  type: 'lostKingdomRuins',
  version: 1,
  description: 'Baked Maya architecture: albedo, canopy-dappled sun and sky light recombined live, faint glyph glow.',
  schema,
  async create(ctx, p) {
    const root = new Group();
    const u = {
      presence: floatUniform(1),
      sun: floatUniform(p.sunGain),
      sky: floatUniform(p.sky),
      glow: floatUniform(p.glow),
      exposure: floatUniform(p.exposure),
    };
    const sunColor = colorUniform(p.sun.color);
    const glowColor = colorUniform(p.glowColor);
    const waveColor = colorUniform(p.clearWave.color);
    const waving = p.clearWave.glyph > 0 || p.clearWave.sheen > 0;
    const materials: Material[] = [];
    const flicker = ctx.quality.reducedMotion ? p.flicker * 0.3 : p.flicker;
    for (const g of p.groups) {
      const gltf = await ctx.assets.loadGLTF(g.src);
      const scene = gltf.scene.clone(true);
      scene.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const src = o.material as MeshStandardMaterial;
        const albedoSun = src.map as Texture | null;
        const light = src.emissiveMap as Texture | null;
        if (!albedoSun || !light) {
          console.warn(`[lost-kingdom] ${g.src}: baked textures missing`);
          return;
        }
        albedoSun.anisotropy = 8;
        light.anisotropy = 4;
        const a = texture(albedoSun, uv());
        const l = texture(light, uv());
        const sky = l.rgb.mul(g.envScale).mul(u.sky);
        const sun = sunColor.mul(a.a.mul(g.sunEff)).mul(u.sun).mul(leafFlicker(positionWorld, flicker));
        const lit = a.rgb.mul(sky.add(sun)).mul(u.exposure).mul(g.exposure);
        const glyph = glowColor.mul(l.a.mul(u.glow));
        const m = new MeshBasicNodeMaterial();
        if (waving) {
          const front = clearFront(positionWorld);
          const wave = glowColor.mul(l.a.mul(front.mul(p.clearWave.glyph))).add(a.rgb.mul(waveColor).mul(front.mul(p.clearWave.sheen)));
          m.colorNode = lit.add(glyph).add(wave);
        } else m.colorNode = lit.add(glyph);
        m.opacityNode = u.presence;
        m.alphaHash = true;
        m.mrtNode = mrt({ emissive: vec4(glyph.mul(0.35), float(1)) });
        o.material = m;
        o.castShadow = false;
        o.receiveShadow = false;
        materials.push(m);
      });
      root.add(scene);
    }
    return {
      object: root,
      reactive: { glow: u.glow, sun: u.sun, sky: u.sky },
      update(frame) {
        canopyTime.value = frame.time;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        for (const m of materials) m.dispose();
        for (const g of p.groups) ctx.assets.release(g.src);
      },
    };
  },
};
