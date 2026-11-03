import { BackSide, CylinderGeometry, Group, Mesh, MeshBasicNodeMaterial, NormalBlending } from 'three/webgpu';
import { asin, atan, clamp, float, mx_fractal_noise_float, normalize, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { colorUniform, floatUniform, noBloom, z, zColor, type ComponentFactory } from '@prismfall/sdk';

/**
 * Humid air between the plaza and the photographed forest: a few nested, open cylinders of haze
 * around the player, each a soft gradient by elevation (densest at the horizon, gone well above
 * it) with slow, broad variation, so the far plaza dissolves into the forest without any edge.
 * Nearer shells are thinner; whatever stands in front of a shell (the pyramid, the outcrop, the
 * near plants) is not hazed by it, so the haze deepens with distance as real aerial perspective.
 */

const shellSchema = z.object({
  radius: z.number().positive(),
  opacity: z.number().min(0).max(1),
});

const schema = z.object({
  /** Centre of the shells (the player's eye). */
  eye: z.tuple([z.number(), z.number(), z.number()]).default([0, 1, 30]),
  shells: z.array(shellSchema).min(1).max(6).default([
    { radius: 125, opacity: 0.16 },
    { radius: 190, opacity: 0.28 },
    { radius: 420, opacity: 0.3 },
  ]),
  color: zColor.default('#aab597'),
  /** Elevations (degrees) where the haze is full and where it has faded out. */
  from: z.number().default(-3),
  to: z.number().default(11),
  /** Bindable as `density` (scales every shell). */
  density: z.number().min(0).default(1),
});
type Params = z.infer<typeof schema>;

export const horizonHaze: ComponentFactory<Params> = {
  type: 'horizonHaze',
  version: 1,
  description: 'Nested gradient haze shells that dissolve the far plaza into the photographed forest.',
  schema,
  create(ctx, p) {
    const root = new Group();
    const u = { presence: floatUniform(1), density: floatUniform(p.density) };
    const t = ctx.uniforms.time;
    const materials: MeshBasicNodeMaterial[] = [];
    const geoms: CylinderGeometry[] = [];
    const [ex, ey, ez] = p.eye;
    p.shells.forEach((s, i) => {
      const height = Math.tan((Math.max(20, p.to + 8) * Math.PI) / 180) * s.radius * 2;
      const g = new CylinderGeometry(s.radius, s.radius, height, 96, 1, true);
      g.translate(ex, ey, ez);
      geoms.push(g);
      const d = normalize(positionWorld.sub(vec3(ex, ey, ez)));
      const elev = asin(clamp(d.y, -1, 1)).mul(180 / Math.PI);
      const az = atan(d.x, d.z.negate());
      // Broad, slow variation of the top of the haze: no straight line anywhere.
      const wav = mx_fractal_noise_float(vec3(az.mul(2.2).add(i * 3.1), elev.mul(0.08), t.mul(0.004).add(i)), 3, 2.0, 0.5);
      const top = float(p.to).add(wav.mul(3.5));
      const fade = smoothstep(top, float(p.from), elev);
      const m = new MeshBasicNodeMaterial();
      m.colorNode = colorUniform(p.color);
      m.opacityNode = fade.mul(fade).mul(s.opacity).mul(u.density).mul(u.presence).mul(wav.mul(0.25).add(0.9));
      m.transparent = true;
      m.depthWrite = false;
      m.blending = NormalBlending;
      m.fog = false;
      m.side = BackSide;
      noBloom(m);
      const mesh = new Mesh(g, m);
      mesh.frustumCulled = false;
      // Far shells first, so nearer haze composites over them.
      mesh.renderOrder = -5 - i;
      root.add(mesh);
      materials.push(m);
    });
    return {
      object: root,
      reactive: { density: u.density },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        for (const g of geoms) g.dispose();
        for (const m of materials) m.dispose();
      },
    };
  },
};
