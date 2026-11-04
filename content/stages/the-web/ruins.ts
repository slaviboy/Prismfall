import { Box3, BoxGeometry, Group, Mesh, MeshStandardNodeMaterial, NoColorSpace, PlaneGeometry, RepeatWrapping, SRGBColorSpace, TextureLoader, Vector3, type Material, type Object3D, type Texture } from 'three/webgpu';
import { abs, float, mix, mx_noise_float, normalMap, normalWorld, output, positionWorld, pow, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import { floatUniform, z, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { FLOOR, castMoonShadows, fogged, litMaterial, release, revealMask, tick, world, type F, type V3, type WebWorld, musicOf } from './shared';

const schema = z.object({
  /** Placed models: the chapel, the gate, rock walls, statues, trees and roots. */
  models: z
    .array(
      z.object({
        src: z.string(),
        position: zVec3,
        /** Degrees about the vertical. */
        yaw: z.number().default(0),
        /** Extra tilt (degrees) about x and z, for fallen or leaning pieces. */
        tilt: z.tuple([z.number(), z.number()]).default([0, 0]),
        scale: z.number().positive().default(1),
        /** Only meshes whose material name matches one of these (a part of a scene). */
        include: z.array(z.string()).optional(),
        /** Only these nodes of a kit (name prefixes), re-centred on their own base. */
        nodes: z.array(z.string()).optional(),
        tint: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
        roughness: z.number().min(0).max(1).optional(),
        castShadow: z.boolean().default(true),
        /** Cobwebs: keep the texture's alpha cut-out, both sides. */
        cutout: z.boolean().default(false),
        /** Fog multiplier (far silhouettes can take more). */
        fog: z.number().default(1),
      }),
    )
    .default([]),
  /** Masonry with exact faces: a bridge across the nave, fallen wall slabs (creatures walk on them). */
  masonry: z
    .array(z.object({ center: zVec3, size: zVec3, yaw: z.number().default(0), tilt: z.number().default(0) }))
    .default([]),
  floor: z
    .object({
      size: z.number().default(900),
      /** Repeats per metre of the stone flags and of the mud. */
      flags: z.number().default(0.22),
      mud: z.number().default(0.16),
      puddles: z.number().min(0).max(1).default(0.35),
    })
    .prefault({}),
});

type Params = z.infer<typeof schema>;

function load(w: WebWorld, src: string, srgb: boolean): Promise<Texture | null> {
  const url = w.ctx.assets.url(src);
  if (!url) return Promise.resolve(null);
  return new TextureLoader().loadAsync(url).then((t) => {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

/**
 * The ruined nave: a stone floor of worn flags and leaf-strewn mud with still, dark puddles that
 * catch the moon, and the placed scans (the collapsed chapel, the moss-covered gate, cave walls,
 * the gargoyle, dead trees, roots and cobwebs), lit by the moon with shadows and the fog's glow.
 * Provides the ground height (the flat floor) for everything that walks.
 */
export const webRuins: ComponentFactory<Params> = {
  type: 'webRuins',
  version: 1,
  description: 'The ruined nave: stone floor with puddles and the placed ruins, rocks, trees and cobwebs.',
  schema,
  async create(ctx, p) {
    const w = world(ctx);
    const presence = floatUniform(1);
    const group = new Group();
    ctx.ground.provide(() => FLOOR);
    const owned: Material[] = [];
    const boxes: BoxGeometry[] = [];
    const textures: Texture[] = [];

    // ---- Floor.
    const [fd, fn, fa, md, mn, ma] = await Promise.all([
      load(w, 'textures/flags_diff.webp', true),
      load(w, 'textures/flags_nor.webp', false),
      load(w, 'textures/flags_arm.webp', false),
      load(w, 'textures/mud_diff.webp', true),
      load(w, 'textures/mud_nor.webp', false),
      load(w, 'textures/mud_arm.webp', false),
    ]);
    for (const t of [fd, fn, fa, md, mn, ma]) if (t) textures.push(t);
    const floorMat = new MeshStandardNodeMaterial();
    floorMat.lightsNode = w.lightsNode;
    const xz = positionWorld.xz;
    const uvF = xz.mul(p.floor.flags);
    const uvM = xz.mul(p.floor.mud).add(vec2(0.37, 0.71));
    const big = mx_noise_float(vec3(xz.x.mul(0.06), 0, xz.y.mul(0.06)));
    const mudK = smoothstep(-0.15, 0.35, big.add(mx_noise_float(vec3(xz.x.mul(0.2), 1, xz.y.mul(0.2))).mul(0.25)));
    const puddle = smoothstep(0.42, 0.5, mx_noise_float(vec3(xz.x.mul(0.05), 7, xz.y.mul(0.05))).add(big.mul(-0.2))).mul(p.floor.puddles);
    const flagsCol = fd ? texture(fd, uvF).rgb : vec3(0.3, 0.3, 0.3);
    const mudCol = md ? texture(md, uvM).rgb : vec3(0.2, 0.17, 0.13);
    const flagsArm = fa ? texture(fa, uvF).rgb : vec3(1, 0.8, 0);
    const mudArm = ma ? texture(ma, uvM).rgb : vec3(1, 0.9, 0);
    const albedo = mix(flagsCol.mul(vec3(0.42, 0.44, 0.47)), mudCol.mul(vec3(0.34, 0.34, 0.33)), mudK.mul(0.7)).mul(mix(float(1), float(0.45), puddle));
    floorMat.colorNode = vec4(albedo, 1);
    const arm = mix(flagsArm, mudArm, mudK);
    floorMat.roughnessNode = mix(arm.g.mul(0.9).add(0.08), float(0.05), puddle);
    floorMat.metalnessNode = float(0);
    floorMat.aoNode = arm.r;
    if (fn && mn) {
      const nF = normalMap(texture(fn, uvF), vec2(1, 1));
      const nM = normalMap(texture(mn, uvM), vec2(1, 1));
      floorMat.normalNode = mix(mix(nF, nM, mudK), normalMap(texture(fn, uvF), vec2(0.05, 0.05)), puddle);
    }
    floorMat.fog = false;
    floorMat.outputNode = vec4(fogged(w, output.rgb as unknown as V3), output.a);
    floorMat.opacityNode = revealMask(presence as unknown as F);
    floorMat.alphaTest = 0.5;
    owned.push(floorMat);
    const floorGeo = new PlaneGeometry(p.floor.size, p.floor.size, 1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(0, FLOOR, -p.floor.size * 0.3);
    const floor = new Mesh(floorGeo, floorMat);
    floor.receiveShadow = true;
    castMoonShadows(floor, false);
    group.add(floor);

    // ---- Masonry: world-space triplanar stone, so no face stretches.
    if (p.masonry.length > 0) {
      const mm = new MeshStandardNodeMaterial();
      mm.lightsNode = w.lightsNode;
      const n = abs(normalWorld);
      const wts = pow(n, vec3(4, 4, 4));
      const wsum = wts.x.add(wts.y).add(wts.z);
      const q = positionWorld.mul(0.16);
      const tri = (t: Texture | null, fallback: [number, number, number]) =>
        t
          ? texture(t, q.zy).rgb.mul(wts.x).add(texture(t, q.xz).rgb.mul(wts.y)).add(texture(t, q.xy).rgb.mul(wts.z)).div(wsum)
          : vec3(...fallback);
      const grime = mx_noise_float(positionWorld.mul(0.07)).mul(0.25).add(0.75);
      mm.colorNode = vec4(tri(fd, [0.3, 0.3, 0.3]).mul(vec3(0.5, 0.52, 0.55)).mul(grime), 1);
      const armT = tri(fa, [1, 0.85, 0]);
      mm.roughnessNode = armT.g.mul(0.8).add(0.15);
      mm.metalnessNode = float(0);
      mm.aoNode = armT.r;
      mm.fog = false;
      mm.outputNode = vec4(fogged(w, output.rgb as unknown as V3), output.a);
      mm.opacityNode = revealMask(presence as unknown as F);
      mm.alphaTest = 0.5;
      owned.push(mm);
      for (const b of p.masonry) {
        const geo = new BoxGeometry(...b.size);
        const mesh = new Mesh(geo, mm);
        mesh.position.set(...b.center);
        mesh.rotation.set(0, (b.yaw * Math.PI) / 180, (b.tilt * Math.PI) / 180);
        castMoonShadows(mesh, true);
        boxes.push(geo);
        group.add(mesh);
      }
    }

    // ---- Models.
    const sources = [...new Set(p.models.map((m) => m.src))];
    const loaded = new Map<string, Object3D>();
    await Promise.all(
      sources.map(async (src) => {
        const g = await ctx.assets.loadGLTF(src);
        loaded.set(src, g.scene);
      }),
    );
    const matCache = new Map<string, MeshStandardNodeMaterial>();
    for (const m of p.models) {
      const scene = loaded.get(m.src);
      if (!scene) continue;
      const inst = new Group();
      const body = scene.clone(true);
      inst.add(body);
      inst.position.set(...m.position);
      inst.rotation.set((m.tilt[0] * Math.PI) / 180, (m.yaw * Math.PI) / 180, (m.tilt[1] * Math.PI) / 180, 'YXZ');
      inst.scale.setScalar(m.scale);
      const drop: Object3D[] = [];
      const named = (o: Object3D): boolean => {
        for (let n: Object3D | null = o; n && n !== body; n = n.parent) if (m.nodes!.some((k) => n!.name.startsWith(k))) return true;
        return false;
      };
      body.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material;
        if ((m.include && !m.include.some((name) => (src?.name ?? '').includes(name))) || (m.nodes && !named(mesh))) {
          drop.push(mesh);
          return;
        }
        const key = `${src?.uuid}|${m.tint.join(',')}|${m.roughness ?? ''}|${m.cutout}|${m.fog}`;
        let mat = matCache.get(key);
        if (!mat) {
          mat = litMaterial(w, src, { presence: presence as unknown as F, tint: m.tint, roughness: m.roughness, metalness: 0, doubleSided: m.cutout, alphaTest: m.cutout ? 0.4 : undefined, fog: m.fog });
          matCache.set(key, mat);
          owned.push(mat);
        }
        mesh.material = mat;
        mesh.frustumCulled = true;
      });
      for (const d of drop) d.removeFromParent();
      if (m.nodes) {
        // A kit part keeps its place in the kit's space: move its base centre to the instance origin.
        body.updateMatrixWorld(true);
        const box = new Box3().setFromObject(body);
        const c = box.getCenter(new Vector3());
        body.position.set(-c.x, -box.min.y, -c.z);
      }
      castMoonShadows(inst, m.castShadow && !m.cutout);
      group.add(inst);
    }

    return {
      object: group,
      update(frame) {
        tick(w, frame.time, frame.dt, musicOf(frame));
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        floorGeo.dispose();
        for (const b of boxes) b.dispose();
        for (const m of owned) m.dispose();
        for (const t of textures) t.dispose();
        for (const src of sources) ctx.assets.release(src);
        ctx.ground.provide(null);
        release(w);
      },
    };
  },
};
