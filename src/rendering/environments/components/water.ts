import { Group, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector2, type MRTNode, type Node, type Object3D, type Renderer } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  max,
  min,
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
  step,
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
  /** Fine ripples on top of the swell (0 = off): break the moon glint into a glitter path. */
  chop: z.number().min(0).default(0),
  /** Ripple frequency (cycles per world unit). */
  chopScale: z.number().positive().default(1.4),
  /**
   * Bioluminescent surf (off unless given): here and there a stretch of the main swell's crest
   * breaks, flashes cold blue where the break runs along it, and leaves glowing foam behind that
   * fades within a second or two. Line-clear ripples light the crests they cross, softly.
   */
  surf: z
    .object({
      color: zColor.default('#4cc6ff'),
      strength: z.number().min(0).default(1),
      /** Chance that a stretch of crest breaks in each cycle. */
      density: z.number().min(0).max(1).default(0.3),
      /** Seconds per cycle of each stretch of crest. */
      period: z.number().min(4).default(9),
      /** Length of a stretch of crest (world units); a break runs along up to a third of it. */
      stretch: z.number().positive().default(36),
      /** Breaks are drawn up to this distance from the viewer. */
      range: z.number().positive().default(170),
      /** Kept outside the cone around the board, |x| > clearance × (viewZ − z). */
      clearance: z.number().min(0).default(0.42),
      viewZ: z.number().default(34),
      /** Glow that line-clear ripples send through the crests. */
      clearGlow: z.number().min(0).default(0.6),
      bloom: z.number().min(0).default(0.25),
      seed: z.number().default(1),
    })
    .optional(),
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
    const v = normalize(cameraPosition.sub(positionWorld));
    let n = normalize(vec3(frag.dx.negate(), 1, frag.dz.negate()));
    if (p.chop > 0) {
      // Slope of two drifting noise octaves (finite differences), fading out with distance so
      // the far sea doesn't alias.
      const e = 0.05;
      const q = positionWorld.xz.mul(p.chopScale);
      const field = (o: Node<'vec2'>) => mx_noise_float(vec3(q.add(o), t.mul(0.35))).add(mx_noise_float(vec3(q.mul(2.3).add(o.mul(2.3)).add(5.1), t.mul(0.5))).mul(0.5));
      const h0 = field(vec2(0, 0));
      const gx = field(vec2(e, 0)).sub(h0).div(e);
      const gz = field(vec2(0, e)).sub(h0).div(e);
      const fade = exp(positionWorld.xz.length().mul(-0.006));
      n = normalize(n.add(vec3(gx.negate(), 0, gz.negate()).mul(p.chop / p.chopScale).mul(fade)));
    }
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
    // Bioluminescent surf, worked out in a frame moving with the main swell, where its crests
    // stand still at v = (n + 1/4) wavelengths. Each stretch of crest (a cell one wavelength deep)
    // may break once per cycle at a hashed time and place: the break runs along the crest both
    // ways, each spot flashing as it is reached, and the water it leaves behind glows and fades.
    const uSurf = floatUniform(p.surf?.strength ?? 0);
    let surf: Node<'float'> | null = null;
    if (p.surf) {
      const sp = p.surf;
      const w1 = waves[0] as (typeof waves)[number];
      const lambda = (2 * Math.PI) / w1.k;
      const d1 = vec2(w1.d.x, w1.d.y);
      const along = vec2(-w1.d.y, w1.d.x);
      // The swell's crests travel towards -d1 at this speed.
      const c = u.speed.mul(w1.w / w1.k).max(0.05);
      const xz = positionWorld.xz;
      const vM = dot(xz, d1).add(t.mul(c));
      const uM = dot(xz, along);
      const hashOf = (id: Node<'vec2'>, k: number) => fract(sin(dot(id, vec2(127.1 + k * 31.7, 311.7 + k * 17.9))).mul(43758.5453));
      const swell = (pt: Node<'vec2'>) => {
        let h: Node<'float'> = float(0);
        for (const w of waves) h = h.add(sin(dot(pt, vec2(w.d.x, w.d.y)).mul(w.k).add(t.mul(u.speed).mul(w.w))).mul(w.a));
        return h;
      };
      const U = sp.stretch;
      const P = sp.period;
      const flashAmt = ctx.uniforms.flashLimit.mul(1.4);
      // The breaking lip (a bright line along the crest) and the foam it leaves behind.
      let lip: Node<'float'> = float(0);
      let foamBand: Node<'float'> = float(0);
      // Two grids offset by half a stretch, so breaks can start anywhere along a crest (one on low detail).
      for (const layer of ctx.quality.detail === 'low' ? [0] : [0, 1]) {
        const uL = uM.add(layer * U * 0.5);
        const cu = floor(uL.div(U));
        const cv = floor(vM.div(lambda));
        const id = vec2(cu, cv).add(vec2(layer * 17.31 + sp.seed * 3.7, sp.seed * 1.3));
        const cycle = t.div(P).add(hashOf(id, 0).mul(7));
        const n = floor(cycle);
        const key = id.add(vec2(n.mul(3.71), n.mul(1.37)));
        const h = (k: number) => hashOf(key, k);
        const exists = step(h(1), sp.density);
        // Seconds since this break began (each lives at most 4 s inside its cycle).
        const age = fract(cycle).mul(P).sub(h(2).mul(P - 4));
        const u0 = h(3).mul(0.4).add(0.3).mul(U);
        const runSpeed = h(4).mul(3).add(3);
        const reach = h(5).mul(0.12).add(0.2).mul(U);
        const active = h(6).mul(0.8).add(0.9);
        const du = abs(uL.sub(cu.mul(U)).sub(u0));
        const dv = vM.sub(cv.add(0.25).mul(lambda));
        const tFront = du.div(runSpeed);
        const alongMask = float(1).sub(smoothstep(reach.mul(0.5), reach, du));
        // Breaking at this spot: from when the run along the crest reaches it until the break ends.
        const breaking = (tb: Node<'float'>) => smoothstep(tFront.sub(0.05), tFront.add(0.12), tb).mul(float(1).sub(smoothstep(active.sub(0.3), active.add(0.3), tb)));
        const flash = (tb: Node<'float'>) => exp(tb.sub(tFront).max(0).div(-0.18)).mul(flashAmt).add(1);
        // Crests break where they stand tallest (the other waves adding to the swell).
        const crestPt = along.mul(uM).add(d1.mul(cv.add(0.25).mul(lambda).sub(t.mul(c))));
        const weight = exists.mul(alongMask).mul(smoothstep(0.8, 1.45, swell(crestPt))).mul(step(0, age));
        const lipD = dv.add(0.2).div(0.5);
        lip = lip.add(weight.mul(breaking(age)).mul(flash(age)).mul(exp(lipD.mul(lipD).negate())));
        // Water behind the crest left it `since` seconds ago, glowing if the crest was breaking
        // then; in front, foam spills a little way down the face.
        const since = max(dv, 0).div(c);
        const tp = age.sub(since);
        const spill = min(dv, 0).div(0.8);
        const band = exp(since.div(-1.3)).mul(exp(spill.mul(spill).negate()));
        foamBand = foamBand.add(weight.mul(breaking(tp)).mul(flash(tp).mul(0.5).add(0.5)).mul(band));
      }
      // Structure: warped lacy foam with holes, speckled with flickering sparks (single flashing
      // cells); the lip is beaded unevenly along the crest. Averaged out with distance so the far
      // sea does not shimmer.
      const warp = vec2(mx_noise_float(vec3(xz.mul(0.55), t.mul(0.12))), mx_noise_float(vec3(xz.mul(0.55).add(5.2), t.mul(0.1)))).mul(1.6);
      const lace = smoothstep(-0.25, 0.6, mx_noise_float(vec3(xz.add(warp).mul(1.9), t.mul(0.35))));
      const sparks = smoothstep(0.45, 0.85, mx_noise_float(vec3(xz.mul(7.5), t.mul(2.4))));
      const beads = smoothstep(-0.35, 0.75, mx_noise_float(vec3(uM.mul(0.45), sp.seed, t.mul(0.8))));
      const fromViewer = xz.sub(vec2(0, sp.viewZ)).length();
      const smooth = smoothstep(60, 150, fromViewer);
      const foamTex = mix(lace.mul(sparks.mul(1.8).add(0.3)), float(0.55), smooth);
      const lipTex = mix(beads.mul(1.3).add(0.2).add(sparks.mul(0.8)), float(0.95), smooth);
      const cone = smoothstep(sp.clearance * 0.85, sp.clearance * 1.1, abs(positionWorld.x).div(max(float(sp.viewZ).sub(positionWorld.z), 1)));
      const near = float(1).sub(smoothstep(sp.range * 0.55, sp.range, fromViewer));
      // Line clears: the ripple ring lights the crests it crosses.
      const ring = exp(dist.sub(ripplePos).abs().mul(-0.5))
        .mul(u.rippleStrength)
        .mul(exp(t.sub(u.rippleTime).mul(-0.55)))
        .mul(smoothstep(0.35, 1.3, frag.h.div(u.amplitude.add(0.001))))
        .mul(sp.clearGlow);
      surf = lip.mul(lipTex).add(foamBand.add(ring).mul(foamTex).mul(0.5)).mul(cone).mul(near).mul(uSurf);
    }
    const surfC = colorUniform(p.surf?.color ?? '#000000');
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
    let color = surface
      .add(colorUniform(p.moonColor).mul(spec))
      .add(glowC.mul(crest.mul(0.35)))
      .add(colorUniform(p.rippleColor).mul(ripple));
    let emissive = glowC.mul(crest.mul(0.25)).add(colorUniform(p.rippleColor).mul(ripple.mul(0.8)));
    if (surf && p.surf) {
      color = color.add(surfC.mul(surf));
      emissive = emissive.add(surfC.mul(surf.mul(p.surf.bloom)));
    }
    const fadeFar = smoothstep(p.size * 0.48, p.size * 0.3, dist);
    material.colorNode = vec4(color.mul(u.presence).mul(fadeFar), 1);
    material.mrtNode = mrt({ emissive: vec4(emissive.mul(u.presence), 1) });
    const mesh = new Mesh(geometry, material);
    mesh.position.y = p.y;
    ctx.ground.setWaterLevel(p.y);
    mesh.frustumCulled = false;
    mesh.renderOrder = -8;
    group.add(mesh);
    return {
      object: group,
      reactive: { amplitude: u.amplitude, glow: u.glow, speed: u.speed, ...(p.surf ? { surf: uSurf } : {}) },
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

