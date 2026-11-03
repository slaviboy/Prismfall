import { Group, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector2, type MRTNode, type Node, type Object3D, type Renderer } from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  max,
  mix,
  mrt,
  mx_noise_float,
  normalize,
  output,
  positionLocal,
  positionWorld,
  reflector,
  screenUV,
  sin,
  smoothstep,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, zColor, zVec3 } from './common';

const schema = z.object({
  y: z.number().default(-14),
  size: z.number().default(900),
  deep: zColor.default('#020814'),
  shallow: zColor.default('#0b3046'),
  skyTop: zColor.default('#0b1a3a'),
  skyHorizon: zColor.default('#2a4a7a'),
  glow: zColor.default('#3cf2d0'),
  glowStrength: z.number().default(0.6),
  amplitude: z.number().default(0.55),
  wavelength: z.number().default(9),
  speed: z.number().default(0.6),
  moonDirection: zVec3.default([0.3, 0.25, -1]),
  moonColor: zColor.default('#dce8ff'),
  rippleColor: zColor.default('#7ffff0'),
  /** Planar mirror reflection of the world (not the playfield), for still lakes. */
  reflection: z
    .object({
      strength: z.number().min(0).max(1).default(0.9),
      /** Render scale of the reflection relative to the screen. */
      resolution: z.number().min(0.25).max(1).default(0.5),
      /** Screen-space wobble from fine ripples. */
      distortion: z.number().min(0).default(0.004),
      tint: zColor.default('#ffffff'),
    })
    .optional(),
});

/**
 * The reflector renders the scene with no MRT, where a material's `mrtNode` (bloom masks) would
 * replace its colour output; route plain renders to the colour output instead, and hide the
 * playfield and its effects while the mirrored view is drawn.
 */
function reflectWorldOnly(node: ReturnType<typeof reflector>, scene: Object3D): void {
  const outputOnly: MRTNode = mrt({ '': output });
  outputOnly.setBlendMode('', outputOnly.getBlendMode('output'));
  const base = node.reflector as unknown as { updateBefore(frame: { renderer: Renderer }): unknown };
  const original = base.updateBefore.bind(base);
  let hidden: Object3D[] | null = null;
  base.updateBefore = (frame) => {
    hidden ??= ['board', 'fx'].map((name) => scene.getObjectByName(name)).filter((o): o is Object3D => !!o);
    const r = frame.renderer;
    const setMRT = r.setMRT;
    r.setMRT = (m: MRTNode | null) => setMRT.call(r, m ?? outputOnly);
    const shown = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    try {
      return original(frame);
    } finally {
      r.setMRT = setMRT;
      hidden.forEach((o, i) => (o.visible = shown[i] as boolean));
    }
  };
}

/** Animated ocean surface with fresnel sky reflection, moon glint, glowing crests and clear ripples. */
export const waterComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'water',
  version: 1,
  description: 'Displaced ocean surface: fresnel reflection, moon glint, bioluminescent crests, ripples on line clears.',
  schema,
  create(ctx, p) {
    const seg = ctx.quality.detail === 'low' ? 96 : ctx.quality.detail === 'medium' ? 160 : ctx.quality.detail === 'high' ? 220 : 300;
    const geometry = new PlaneGeometry(p.size, p.size, seg, seg);
    geometry.rotateX(-Math.PI / 2);
    const u = {
      amplitude: floatUniform(p.amplitude),
      glow: floatUniform(p.glowStrength),
      speed: floatUniform(p.speed),
      rippleTime: floatUniform(-1000),
      rippleStrength: floatUniform(0),
      presence: floatUniform(1),
    };
    const t = ctx.uniforms.time;
    const k = (2 * Math.PI) / p.wavelength;
    const waves = [
      { d: new Vector2(1, 0.25).normalize(), a: 1, k: k, w: 1 },
      { d: new Vector2(-0.4, 1).normalize(), a: 0.55, k: k * 1.7, w: 1.4 },
      { d: new Vector2(0.8, -0.6).normalize(), a: 0.3, k: k * 2.9, w: 2.1 },
      { d: new Vector2(-0.9, -0.3).normalize(), a: 0.18, k: k * 4.3, w: 2.9 },
    ];
    const height = (xz: Node<'vec2'>) => {
      let h: Node<'float'> = float(0);
      let dx: Node<'float'> = float(0);
      let dz: Node<'float'> = float(0);
      for (const w of waves) {
        const ph = dot(xz, vec2(w.d.x, w.d.y)).mul(w.k).add(t.mul(u.speed).mul(w.w));
        h = h.add(sin(ph).mul(w.a));
        const c = cos(ph).mul(w.a * w.k);
        dx = dx.add(c.mul(w.d.x));
        dz = dz.add(c.mul(w.d.y));
      }
      return { h: h.mul(u.amplitude), dx: dx.mul(u.amplitude), dz: dz.mul(u.amplitude) };
    };
    const vtx = height(positionLocal.xz);
    // Distance attenuation keeps far waves calm (no aliasing at the horizon).
    const atten = exp(positionLocal.xz.length().mul(-0.004));
    const material = new MeshBasicNodeMaterial();
    material.positionNode = positionLocal.add(vec3(0, vtx.h.mul(atten), 0));

    const frag = height(positionWorld.xz);
    const n = normalize(vec3(frag.dx.negate(), 1, frag.dz.negate()));
    const v = normalize(cameraPosition.sub(positionWorld));
    const fresnel = float(1).sub(clamp(dot(n, v), 0, 1)).pow(5).mul(0.7).add(0.03);
    const skyRef = mix(colorUniform(p.skyHorizon), colorUniform(p.skyTop), clamp(n.y.sub(0.8).mul(5), 0, 1));
    const moonDir = normalize(vec3(...p.moonDirection));
    const half = normalize(moonDir.add(v));
    const spec = max(dot(n, half), 0).pow(420).mul(3).add(max(dot(n, half), 0).pow(40).mul(0.06));
    const crest = smoothstep(0.35, 1, frag.h.div(u.amplitude.add(0.001)).mul(0.5).add(0.5)).mul(u.glow);
    const dist = positionWorld.xz.length();
    const ripplePos = t.sub(u.rippleTime).mul(26);
    const ripple = exp(dist.sub(ripplePos).abs().mul(-0.35)).mul(u.rippleStrength).mul(exp(t.sub(u.rippleTime).mul(-0.45)));
    const body = mix(colorUniform(p.deep), colorUniform(p.shallow), clamp(frag.h.mul(0.4).add(0.4), 0, 1));
    const glowC = colorUniform(p.glow);
    let surface: Node<'vec3'> = mix(body, skyRef, fresnel);
    const group = new Group();
    if (p.reflection) {
      const r = p.reflection;
      const mirror = reflector({ resolutionScale: r.resolution * (ctx.quality.detail === 'low' ? 0.6 : 1), bounces: false });
      mirror.target.rotateX(-Math.PI / 2);
      mirror.target.position.y = p.y;
      group.add(mirror.target);
      reflectWorldOnly(mirror, ctx.scene);
      // Fine ripples wobble the mirrored image slightly; calmer with distance.
      const rp = positionWorld.xz.mul(0.18);
      const wobble = vec2(mx_noise_float(vec3(rp, t.mul(0.15))), mx_noise_float(vec3(rp.add(7.3), t.mul(0.15)))).mul(r.distortion).mul(exp(positionWorld.xz.length().mul(-0.004)));
      mirror.uvNode = screenUV.flipX().add(wobble);
      // Schlick fresnel for water (F0 0.02), lifted so the mirror stays readable at mid angles.
      const cosV = clamp(dot(n, v), 0, 1);
      const schlick = float(0.02).add(float(0.98).mul(float(1).sub(cosV).pow(5)));
      surface = mix(body, mirror.rgb.mul(colorUniform(r.tint)), clamp(schlick.mul(1.3).add(0.3), 0, 1).mul(r.strength));
    }
    const color = surface
      .add(colorUniform(p.moonColor).mul(spec))
      .add(glowC.mul(crest.mul(0.35)))
      .add(colorUniform(p.rippleColor).mul(ripple));
    const fadeFar = smoothstep(p.size * 0.48, p.size * 0.3, dist);
    material.colorNode = vec4(color.mul(u.presence).mul(fadeFar), 1);
    material.mrtNode = mrt({ emissive: vec4(glowC.mul(crest.mul(0.25)).add(colorUniform(p.rippleColor).mul(ripple.mul(0.8))).mul(u.presence), 1) });
    const mesh = new Mesh(geometry, material);
    mesh.position.y = p.y;
    ctx.ground.setWaterLevel(p.y);
    mesh.frustumCulled = false;
    mesh.renderOrder = -8;
    group.add(mesh);
    return {
      object: group,
      reactive: { amplitude: u.amplitude, glow: u.glow, speed: u.speed },
      onGameEvent(e) {
        if (e.kind === 'clear' && e.intensity > 0.2) {
          u.rippleTime.value = ctx.uniforms.time.value;
          u.rippleStrength.value = Math.min(1.6, 0.4 + e.intensity);
        }
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        ctx.ground.setWaterLevel(null);
        geometry.dispose();
        material.dispose();
      },
    };
  },
};

