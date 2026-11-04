import type { Color, Object3D } from 'three/webgpu';
import { AdditiveBlending, Box3, BufferAttribute, Group, Mesh, Sprite, SpriteNodeMaterial, Vector3, type BufferGeometry, type Material } from 'three/webgpu';
import { attribute, cameraPosition, dot, exp, float, fract, max, mix, mx_noise_float, normalWorld, positionWorld, sin, smoothstep, uv, vec2, vec3, vec4 } from 'three/tsl';
import { additiveFog, floatUniform, noBloom, seeded, z, type ComponentFactory, type EnvironmentContext } from '@prismfall/sdk';
import { castWorldShadows, frontier, LAMP_COLOR, litMaterial, MAX_LAMPS, releaseFrontier, tickFrontier, type F, type Frontier, type V3 } from './shared';

const schema = z.object({
  src: z.string().default('models/town.glb'),
  /** Share of windows lit at night. */
  litWindows: z.number().min(0).max(1).default(0.55),
  /** Average seconds between someone pushing through the saloon's batwing doors. */
  doorEvery: z.number().positive().default(22),
  /** Wind pump turns per second in a light breeze. */
  rotor: z.number().default(0.32),
  seed: z.number().default(5),
});

type Params = z.infer<typeof schema>;

/**
 * Groups a glass mesh's quads into windows (panes closer than ~0.8 m in the same plane) and gives
 * every vertex its window's random number (`win`: x = random, y = lit flag, z = window width, w = height),
 * so a whole window lights up together at night.
 */
function tagWindows(geometry: BufferGeometry, rand: () => number, litShare: number): Vector3[] {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = pos.count;
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const tri = index ? index.array : Uint32Array.from({ length: count }, (_, i) => i);
  for (let t = 0; t < tri.length; t += 3) {
    unite(tri[t] as number, tri[t + 1] as number);
    unite(tri[t] as number, tri[t + 2] as number);
  }
  // Merge panes of one window: components whose centres are within 0.8 m.
  const groups = new Map<number, { c: Vector3; n: number; min: Vector3; max: Vector3 }>();
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    const r = find(i);
    v.fromBufferAttribute(pos, i);
    let g = groups.get(r);
    if (!g) {
      g = { c: new Vector3(), n: 0, min: v.clone(), max: v.clone() };
      groups.set(r, g);
    }
    g.c.add(v);
    g.n++;
    g.min.min(v);
    g.max.max(v);
  }
  const keys = [...groups.keys()];
  for (const k of keys) groups.get(k)!.c.multiplyScalar(1 / groups.get(k)!.n);
  for (let a = 0; a < keys.length; a++) {
    for (let b = a + 1; b < keys.length; b++) {
      const ga = groups.get(keys[a]!)!;
      const gb = groups.get(keys[b]!)!;
      if (ga.c.distanceTo(gb.c) < 0.8) unite(keys[a]!, keys[b]!);
    }
  }
  const info = new Map<number, [number, number]>();
  const centres: Vector3[] = [];
  const win = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = find(i);
    let w = info.get(r);
    if (!w) {
      w = [rand(), rand() < litShare ? 1 : 0];
      info.set(r, w);
      if (w[1] > 0) centres.push(groups.get(r)?.c.clone() ?? new Vector3());
    }
    win[i * 4] = w[0];
    win[i * 4 + 1] = w[1];
  }
  geometry.setAttribute('win', new BufferAttribute(win, 4));
  return centres;
}

/**
 * Window glass: dark old glass that mirrors the sky by day; at dusk some rooms are lit (warm
 * lamplight with a soft falloff, curtains, and now and then the shadow of someone crossing the room).
 */
function windowEmissive(s: Frontier, time: F): V3 {
  const win = attribute<'vec4'>('win', 'vec4');
  const rnd = win.x;
  const lit = win.y;
  const p = uv();
  // Each window switches on at its own moment as dusk deepens.
  const onAt = rnd.mul(0.35);
  const on = smoothstep(onAt, onAt.add(0.15), s.u.lamps).mul(lit);
  const warm = mix(vec3(1.0, 0.58, 0.26), vec3(1.0, 0.7, 0.42), rnd);
  // Lamp inside: brighter near the middle, curtains darker at the sides.
  const curtain = smoothstep(0.0, 0.22, p.x)
    .mul(smoothstep(1.0, 0.78, p.x))
    .mul(0.75)
    .add(0.25);
  const glowShape = mix(float(0.55), float(1.0), exp(p.sub(vec2(0.5, 0.45)).length().mul(-3.0)));
  // A figure crossing the room every so often (a slow, soft dark shape; never a flash).
  const period = rnd.mul(17).add(19);
  const phase = fract(time.div(period).add(rnd.mul(7.3)));
  const walking = smoothstep(0.0, 0.05, phase).mul(smoothstep(0.42, 0.36, phase));
  const fx = phase.div(0.4).mul(1.6).sub(0.3);
  const body = exp(p.x.sub(fx).mul(p.x.sub(fx)).mul(-60))
    .mul(smoothstep(0.05, 0.35, p.y))
    .mul(smoothstep(0.95, 0.75, p.y));
  const shadow = float(1).sub(body.mul(walking).mul(0.75));
  const flame = mx_noise_float(vec3(time.mul(0.6), rnd.mul(40), 0))
    .mul(0.06)
    .add(1);
  return warm.mul(on.mul(curtain).mul(glowShape).mul(shadow).mul(flame).mul(1.9)) as V3;
}

/**
 * Copper Wells: the Blender town (town.glb), lit by the world's sun and sky with real shadows,
 * windows that light up at dusk, lanterns that burn at night (with their warm light on the walls
 * and the street), a turning wind pump, swaying signs and lanterns, and batwing doors that swing
 * when someone goes into the saloon.
 */
export const frontierTown: ComponentFactory<Params> = {
  type: 'frontierTown',
  version: 1,
  description: 'The Blender frontier town with sun shadows, lit windows and lanterns at dusk, a wind pump, swaying signs and saloon doors.',
  schema,
  async create(ctx: EnvironmentContext, p) {
    const s = frontier(ctx);
    const gltf = await ctx.assets.loadGLTF(p.src);
    const root = gltf.scene.clone(true);
    const presence = floatUniform(1);
    const rand = seeded(p.seed * 977);
    const time = ctx.uniforms.time as unknown as F;
    const reduced = ctx.quality.reducedMotion;

    // Materials: one converted copy per source material (glass and lamp glass get their glow).
    const converted = new Map<Material, Material>();
    // Window glass gets its own copy of the shared geometry (tagged per window): ours to dispose.
    const ownGeometries: BufferGeometry[] = [];
    const lampMeshes: Mesh[] = [];
    const glassCentres: Vector3[] = [];
    root.updateMatrixWorld(true);
    const glassEmissive = windowEmissive(s, time);
    const flicker = mx_noise_float(vec3(time.mul(1.3), positionWorld.x.mul(0.7), positionWorld.z.mul(0.7)))
      .mul(0.08)
      .add(1) as F;
    const lampEmissive = vec3(...LAMP_COLOR).mul(s.u.lamps.mul(6.5).mul(flicker).mul(s.u.mids.mul(0.18).add(1))) as V3;
    const convert = (m: Material, mesh: Mesh): Material => {
      const name = m.name || '';
      const isGlass = /^glass/i.test(name);
      const isLamp = /^lampGlow/i.test(name);
      if (isGlass && !mesh.geometry.getAttribute('win')) {
        mesh.geometry = mesh.geometry.clone();
        ownGeometries.push(mesh.geometry);
        const centres = tagWindows(mesh.geometry, rand, p.litWindows);
        for (const c of centres) glassCentres.push(c.applyMatrix4(mesh.matrixWorld));
      }
      if (isLamp) lampMeshes.push(mesh);
      const key = converted.get(m);
      if (key) return key;
      let out: Material;
      if (isGlass) {
        // Sky reflection (fresnel) by day; lamplight from inside at night.
        const view = cameraPosition.sub(positionWorld).normalize();
        const fres = float(1)
          .sub(max(dot(normalWorld, view), 0))
          .pow(4)
          .mul(0.85)
          .add(0.06);
        const sky = mix(s.u.groundColor, s.u.skyColor, normalWorld.y.mul(0.5).add(0.5)).mul(1.4);
        out = litMaterial(s, m, {
          vertexAO: true,
          presence,
          emissive: sky.mul(fres).add(glassEmissive) as V3,
        });
        const g = out as Material & {
          roughness: number;
          metalness: number;
          color: Color;
        };
        g.roughness = 0.12;
        g.metalness = 0;
        g.color.multiplyScalar(0.35);
      } else if (isLamp) {
        out = litMaterial(s, m, {
          vertexAO: false,
          presence,
          emissive: lampEmissive,
        });
      } else {
        out = litMaterial(s, m, { vertexAO: true, presence });
      }
      converted.set(m, out);
      return out;
    };
    root.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => convert(m, o)) : convert(o.material, o);
      o.frustumCulled = false;
    });
    castWorldShadows(root, true);
    {
      const b = new Box3().setFromObject(root);
      s.shadowBoxes.push([b.min.x - 2, b.min.y - 1, b.min.z - 2, b.max.x + 2, b.max.y + 1, b.max.z + 2]);
    }
    // Lamp glass and window glass do not cast shadows (thin, and they would block their own light).
    for (const m of lampMeshes) m.castShadow = false;

    // Animated parts (named empties at their pivots).
    const named = (re: RegExp): Object3D[] => {
      const out: Object3D[] = [];
      root.traverse((o) => re.test(o.name) && !/_mesh$/.test(o.name) && out.push(o));
      return out;
    };
    const rotor = named(/^windmill_rotor$/)[0];
    const vane = named(/^windmill_vane$/)[0];
    const doors = named(/^saloon_door_[LR]$/);
    const signs = named(/^sign_swing_\d+$/).map((o) => ({
      o,
      q: o.quaternion.clone(),
      ph: rand() * 6.28,
    }));
    const lanterns = named(/^lantern_\d+$/).map((o) => ({
      o,
      q: o.quaternion.clone(),
      ph: rand() * 6.28,
    }));
    const doorRest = doors.map((d) => d.quaternion.clone());
    let doorAt = -1e9;
    let nextDoor = 6 + rand() * p.doorEvery;

    // Lamp positions: the lanterns and street lamps, then the brightest lit windows (warm light spill).
    const lampPositions: Vector3[] = [];
    for (const m of lampMeshes) {
      m.geometry.computeBoundingBox();
      const c = m.geometry.boundingBox!.getCenter(new Vector3()).applyMatrix4(m.matrixWorld);
      if (!lampPositions.some((q) => q.distanceTo(c) < 1.2)) lampPositions.push(c);
    }
    const lamps = lampPositions.slice(0, MAX_LAMPS - 2);
    const windowsNear = glassCentres.sort((a, b) => a.distanceTo(new Vector3(0, 1, 30)) - b.distanceTo(new Vector3(0, 1, 30))).slice(0, MAX_LAMPS - lamps.length);
    lamps.forEach((c, i) => s.lampValues[i]!.set(c.x, c.y - 0.15, c.z, 5.5));
    windowsNear.forEach((c, i) => s.lampValues[lamps.length + i]!.set(c.x, c.y, c.z, 2.2));

    // Lantern halos: small additive glows that never pulse (flash reduction safe).
    const halos = new Group();
    const haloMat = new SpriteNodeMaterial();
    const haloShape = smoothstep(1, 0, uv().sub(0.5).mul(2).length()).pow(2.2);
    haloMat.colorNode = vec4(additiveFog(vec3(...LAMP_COLOR).mul(haloShape.mul(s.u.lamps).mul(presence).mul(0.75))), 1);
    haloMat.transparent = true;
    haloMat.depthWrite = false;
    haloMat.blending = AdditiveBlending;
    haloMat.fog = false;
    noBloom(haloMat);
    for (const c of lamps) {
      const h = new Sprite(haloMat);
      h.position.copy(c);
      h.scale.setScalar(1.6);
      h.renderOrder = 4;
      halos.add(h);
    }

    const group = new Group();
    group.add(root, halos);
    let clock = 0;
    void sin;
    return {
      object: group,
      update(frame) {
        tickFrontier(s, frame);
        const dt = Math.min(0.1, frame.dt);
        clock += dt;
        const motion = reduced ? 0.35 : 1;
        const gust = s.gust;
        if (rotor) rotor.rotateZ(-(p.rotor * (1 + gust * 1.5)) * Math.PI * 2 * dt * motion);
        if (vane) vane.rotation.z = Math.sin(clock * 0.21) * 0.08 * motion;
        const swing = (0.05 + gust * 0.07) * motion;
        for (const sg of signs) {
          sg.o.quaternion.copy(sg.q);
          sg.o.rotateX(Math.sin(clock * 1.7 + sg.ph) * swing + Math.sin(clock * 0.6 + sg.ph * 2) * swing * 0.6);
        }
        for (const l of lanterns) {
          l.o.quaternion.copy(l.q);
          l.o.rotateX(Math.sin(clock * 1.3 + l.ph) * swing * 0.6);
          l.o.rotateZ(Math.sin(clock * 1.1 + l.ph * 1.7) * swing * 0.5);
        }
        // Batwing doors: pushed open, then swinging shut with a damped oscillation.
        if (clock > nextDoor) {
          doorAt = clock;
          nextDoor = clock + p.doorEvery * (0.5 + rand());
        }
        const td = clock - doorAt;
        const ang = td < 6 ? 1.15 * Math.exp(-td / 0.9) * Math.cos(td * 6.2) * motion : 0;
        doors.forEach((d, i) => {
          d.quaternion.copy(doorRest[i]!);
          d.rotateY(i === 0 ? ang : -ang);
        });
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const m of converted.values()) m.dispose();
        for (const g of ownGeometries) g.dispose();
        haloMat.dispose();
        for (let i = 0; i < MAX_LAMPS; i++) s.lampValues[i]!.set(0, -1000, 0, 0);
        ctx.assets.release(p.src);
        releaseFrontier(ctx, s);
      },
    };
  },
};
