import {
  AdditiveBlending,
  AnimationMixer,
  Box3,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  SpotLight,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Bone,
  type Material,
  type Object3D,
  type SkinnedMesh,
} from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { abs, cameraViewMatrix, dot, exp, float, lights, mx_noise_float, normalView, normalize, output, positionView, positionWorld, pow, smoothstep, uv, vec3, vec4 } from 'three/tsl';
import { floatUniform, linear, seeded, z, zColor, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { Director, type SetpieceKind, type SetpieceSpec } from './director';
import { EIGHT_EYES, EyeField } from './eyes';
import { EYE, castMoonShadows, comfortOf, fogDepth, litMaterial, pluck, release, revealMask, tick, world, type F, type V3, type WebWorld, musicOf } from './shared';
import { websOf } from './webs';

/** Layer of the creatures that cast onto the fog screen. */
const SCREEN_LAYER = 7;

const zSpecies = z.object({
  id: z.string(),
  src: z.string(),
  /** Walk clip: a name fragment (default: the longest clip). */
  clip: z.string().optional(),
  /** Leg span (m) at scale 1 of a setpiece. */
  span: z.number().positive(),
  /** 0 light and quick .. 1 massive (louder contacts, bigger plucks, slower turns). */
  weight: z.number().min(0).max(1).default(0.5),
  eyeColor: zColor.default('#ff5a2a'),
  eyeGlow: z.number().min(0).default(1),
  /** Carapace width as a share of the leg span (eye cluster size). */
  carapace: z.number().positive().default(0.11),
  tint: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
  roughness: z.number().min(0).max(1).optional(),
  /** Overrides of what is measured from the model (forward axis, stride speed at clip speed 1). */
  forward: zVec3.optional(),
  stride: z.number().positive().optional(),
});

const zSetpiece = z.object({
  id: z.string(),
  kind: z.enum(['eyes', 'emerge', 'wall', 'ceiling', 'hang', 'webwalk', 'silhouette', 'cross', 'tremble']),
  species: z.string().optional(),
  /** Leg span override (m). */
  span: z.number().positive().optional(),
  /** The route (world points) on the surface whose normal is `normal`. */
  path: z.array(zVec3).default([]),
  normal: zVec3.default([0, 1, 0]),
  speed: z.number().positive().default(0.7),
  /** Chance of a pause at each path point. */
  pauses: z.number().min(0).max(1).default(0.4),
  /** Seconds standing still at the start (eyes first), e.g. inside a dark opening. */
  wait: z.number().min(0).default(0),
  /** Walk back the way it came (emerging creatures withdraw). */
  retreat: z.boolean().default(false),
  /** Hang: the silk's anchor, how far it drops, how long it hangs. */
  anchor: zVec3.optional(),
  depth: z.number().default(12),
  hold: z.tuple([z.number(), z.number()]).default([5, 10]),
  /** Eyes: where (a hiding spot), how many clusters, how far apart, eye size (m). */
  at: zVec3.optional(),
  count: z.number().int().min(1).max(8).default(1),
  spread: z.number().default(2),
  eyeSize: z.number().positive().default(0.05),
  eyeColor: zColor.optional(),
  /** Tremble: which web (index in the webs layer). */
  web: z.number().int().min(0).default(0),
  weight: z.number().min(0).default(1),
  cooldown: z.number().min(0).default(40),
  sudden: z.boolean().default(false),
  /** Close to the viewer (skipped with calm comfort, for VR). */
  near: z.boolean().default(false),
  /** Always present (loops its path), outside the director. */
  resident: z.boolean().default(false),
  /** Casts onto the fog screen. */
  shadow: z.boolean().default(false),
});

const schema = z.object({
  species: z.array(zSpecies).default([]),
  setpieces: z.array(zSetpiece).default([]),
  /** A moonlit fog screen with a light behind it: creatures between them darken it with their shadow. */
  screen: z
    .object({
      center: zVec3,
      size: z.tuple([z.number(), z.number()]),
      light: zVec3,
      color: zColor.default('#9aa8bc'),
      intensity: z.number().default(9000),
      opacity: z.number().default(0.55),
    })
    .optional(),
  /** Seconds between setpieces and the opening stillness. */
  gap: z.tuple([z.number(), z.number()]).default([9, 22]),
  opening: z.tuple([z.number(), z.number()]).default([8, 14]),
  seed: z.number().default(5),
});

type Params = z.infer<typeof schema>;
type SpeciesP = Params['species'][number];
type SetpieceP = Params['setpieces'][number];

/** What a species' model tells us about itself (measured once). */
interface Calib {
  sp: SpeciesP;
  scene: Object3D;
  clip: AnimationClip | null;
  /** Leg span of the bind pose (model units). */
  span: number;
  /** Bind-pose feet centre (model space). */
  feet: Vector3;
  /** Horizontal forward of the model (model space). */
  forward: Vector3;
  /** Ground speed at clip speed 1 (model units per second). */
  stride: number;
  /** Eye anchor (bind pose, model space) and the bone carrying it. */
  eye: Vector3;
  eyeBone: string | null;
  /** The eye anchor in the eye bone's frame. */
  eyeLocal: Vector3;
  /** Root motion: the bone that walks away in the clip (pinned at runtime). */
  rootBone: string | null;
}

function pickClip(clips: AnimationClip[], name?: string): AnimationClip | null {
  if (clips.length === 0) return null;
  if (name) {
    const hit = clips.find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
    if (hit) return hit;
  }
  return [...clips].sort((a, b) => b.duration - a.duration)[0]!;
}

/** Measures a species: span, feet, forward axis and stride from its walk clip, eye anchor from its carapace. */
function calibrate(sp: SpeciesP, scene: Object3D, clips: AnimationClip[]): Calib {
  // Everything is measured on a copy in its animated pose: these rigs often scale or move bones
  // far from the bind pose, so the bind mesh's size says little about what is drawn.
  const clip = pickClip(clips, sp.clip);
  const copy = cloneSkinned(scene);
  const mixer = clip ? new AnimationMixer(copy) : null;
  if (mixer && clip) mixer.clipAction(clip).play();
  mixer?.setTime(0);
  copy.updateMatrixWorld(true);
  const bones: Bone[] = [];
  const skinned: SkinnedMesh[] = [];
  copy.traverse((o) => {
    if ((o as Bone).isBone) bones.push(o as Bone);
    if ((o as SkinnedMesh).isSkinnedMesh) skinned.push(o as SkinnedMesh);
  });
  const verts: Vector3[] = [];
  for (const m of skinned) {
    m.skeleton.update();
    const n = m.geometry.getAttribute('position').count;
    const step = Math.max(1, Math.floor(n / 5000));
    for (let i = 0; i < n; i += step) verts.push(m.getVertexPosition(i, new Vector3()).applyMatrix4(m.matrixWorld));
  }
  const box = new Box3().setFromPoints(verts);
  const size = box.getSize(new Vector3());
  const span = Math.max(size.x, size.z) || 1;
  const feet = new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  let forward = new Vector3(0, 0, 1);
  let stride = span * 0.4;
  let rootBone: string | null = null;
  if (mixer && clip) {
    // Bones carrying a large share of the skeleton are root-motion candidates.
    const desc = (b: Bone): number => {
      let n = 0;
      b.traverse((o) => {
        if ((o as Bone).isBone) n++;
      });
      return n;
    };
    const heavy = bones.filter((b) => desc(b) >= bones.length * 0.3);
    const leaves = bones.filter((b) => !b.children.some((c) => (c as Bone).isBone));
    const N = 40;
    const dt = clip.duration / N;
    const tracks = leaves.map(() => [] as Vector3[]);
    const roots = heavy.map(() => [] as Vector3[]);
    for (let k = 0; k <= N; k++) {
      mixer.setTime(k * dt);
      copy.updateMatrixWorld(true);
      leaves.forEach((b, i) => tracks[i]!.push(new Vector3().setFromMatrixPosition(b.matrixWorld)));
      heavy.forEach((b, i) => roots[i]!.push(new Vector3().setFromMatrixPosition(b.matrixWorld)));
    }
    let travel = 0;
    let travelDir = new Vector3();
    roots.forEach((r, i) => {
      const d = r[r.length - 1]!.clone().sub(r[0]!).setY(0);
      if (d.length() > travel) {
        travel = d.length();
        travelDir = d.normalize();
        rootBone = heavy[i]!.name;
      }
    });
    if (travel > span * 0.15) {
      forward = travelDir;
      stride = travel / clip.duration;
    } else {
      rootBone = null;
      // In place: grounded feet (low leaves that really step) slide backwards at the walking speed.
      const stats = tracks.map((t, i) => {
        const ys = t.map((q) => q.y);
        let reach = 0;
        for (const q of t) reach = Math.max(reach, Math.hypot(q.x - t[0]!.x, q.z - t[0]!.z));
        return { i, meanY: ys.reduce((a, b) => a + b, 0) / ys.length, lift: Math.max(...ys) - Math.min(...ys), reach };
      });
      // Feet: low and actually stepping (they lift and travel), not IK targets parked on the ground.
      const feetIdx = stats
        .filter((q) => q.reach > span * 0.03 && q.lift > span * 0.004 && q.reach < span * 0.8)
        .sort((a, b) => a.meanY - b.meanY)
        .slice(0, 8)
        .map((q) => q.i);
      const vel = new Vector3();
      const speeds: number[] = [];
      for (const i of feetIdx) {
        const t = tracks[i]!;
        const ys = t.map((q) => q.y);
        const lo = Math.min(...ys);
        const hi = Math.max(...ys);
        for (let k = 0; k < N; k++) {
          const g = 1 - Math.min(1, Math.max(0, (t[k]!.y - lo) / Math.max(1e-6, (hi - lo) * 0.3)));
          if (g < 0.5) continue;
          const d = t[k + 1]!.clone().sub(t[k]!).setY(0).divideScalar(dt);
          vel.add(d);
          speeds.push(d.length());
        }
      }
      if (vel.lengthSq() > 1e-12) forward = vel.negate().normalize();
      speeds.sort((a, b) => a - b);
      if (speeds.length > 4) stride = speeds[Math.floor(speeds.length / 2)]!;
    }
    mixer.setTime(0);
    copy.updateMatrixWorld(true);
  }
  if (sp.forward) forward = new Vector3(...sp.forward).setY(0).normalize();
  if (sp.stride) stride = sp.stride;
  // Eyes: the front-top of the carapace on the midline (not legs, not fangs), in the posed copy.
  const right = new Vector3().crossVectors(new Vector3(0, 1, 0), forward).normalize();
  const mid = verts.reduce((acc, q) => acc + q.dot(right), 0) / Math.max(1, verts.length);
  const band = verts.filter((q) => Math.abs(q.dot(right) - mid) < span * 0.06);
  const ys = band.map((q) => q.y).sort((a, b) => a - b);
  const median = ys[Math.floor(ys.length * 0.55)] ?? feet.y;
  let eye = feet.clone().add(new Vector3(0, span * 0.12, 0));
  let best = -Infinity;
  for (const q of band) {
    if (q.y <= median) continue;
    const f = q.dot(forward);
    if (f > best) {
      best = f;
      eye = q.clone();
    }
  }
  eye.addScaledVector(forward, -span * 0.012);
  let eyeBone: string | null = null;
  let bd = Infinity;
  for (const b of bones) {
    const d = new Vector3().setFromMatrixPosition(b.matrixWorld).distanceTo(eye);
    if (d < bd) {
      bd = d;
      eyeBone = b.name;
    }
  }
  // The anchor in that bone's frame (posed), so it rides the head as it moves.
  const eyeBoneObj = bones.find((b) => b.name === eyeBone);
  const eyeLocal = eyeBoneObj ? eye.clone().applyMatrix4(eyeBoneObj.matrixWorld.clone().invert()) : eye.clone();
  mixer?.stopAllAction();
  mixer?.uncacheRoot(copy);
  return { sp, scene, clip, span, feet, forward, stride, eye, eyeBone, eyeLocal, rootBone };
}

interface Agent {
  spec: SetpieceP;
  cal: Calib | null;
  holder: Group;
  model: Object3D | null;
  mixer: AnimationMixer | null;
  action: AnimationAction | null;
  eyeBone: Object3D | null;
  eyeLocal: Vector3;
  rootBone: Object3D | null;
  rootRest: Vector3;
  scale: number;
  running: boolean;
  t: number;
  state: 'wait' | 'walk' | 'pause' | 'descend' | 'hold' | 'ascend' | 'out';
  s: number;
  dir: number;
  timer: number;
  speed: number;
  pos: Vector3;
  fwd: Vector3;
  up: Vector3;
  eyes: number;
  awake: number;
  lastCycle: number;
  thread: Mesh | null;
  clusters: { p: Vector3; n: number; delay: number; blink: number }[];
  rand: () => number;
  pathLen: number[];
}

const _m = new Matrix4();
const _v = new Vector3();
const _w = new Vector3();
const _x = new Vector3();

/** Position and direction along a polyline at distance s. */
function along(path: Vector3[], cum: number[], s: number, out: Vector3, dir: Vector3): void {
  const L = cum[cum.length - 1]!;
  const ss = Math.min(L, Math.max(0, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < ss) i++;
  const a = path[i - 1]!;
  const b = path[i]!;
  const seg = Math.max(1e-6, cum[i]! - cum[i - 1]!);
  out.copy(a).lerp(b, (ss - cum[i - 1]!) / seg);
  dir.copy(b).sub(a).normalize();
}

/**
 * Giant spiders (real rigged models: see ASSET_LICENSES.md) living in the ruins, run by a director
 * of setpieces: walls and ceilings crossed in measured strides, a creature emerging from a dark
 * opening (its eyes first), spiders descending on silk and climbing back, a widow walking its web
 * and shaking it, clusters of eyes opening in hiding places, unseen things trembling the webs, and
 * a colossal silhouette whose real shadow crosses a moonlit fog screen far away.
 *
 * Every species measures itself (span, feet, forward axis and walking speed from its own walk clip,
 * eye anchor from its carapace), so strides follow the distance walked and feet do not slide. The
 * visibility controller lights the eyes by wakefulness, facing, distance and comfort; rocks and
 * walls hide them. Contacts are heard (heavy or light by species) and pluck the webs they cross.
 */
export const webSpiders: ComponentFactory<Params> = {
  type: 'webSpiders',
  version: 1,
  description: 'Giant spiders on walls, ceilings, silk and webs, eyes in the dark, and a shadow on the fog, run by a setpiece director.',
  schema,
  async create(ctx, p) {
    const w: WebWorld = world(ctx);
    const presence = floatUniform(1);
    const group = new Group();
    const comfort = comfortOf(ctx);
    const reduced = ctx.quality.reducedMotion;
    const owned: Material[] = [];
    const cals = new Map<string, Calib>();
    await Promise.all(
      p.species.map(async (sp) => {
        const g = await ctx.assets.loadGLTF(sp.src);
        cals.set(sp.id, calibrate(sp, g.scene, g.animations ?? []));
      }),
    );
    const matCache = new Map<string, MeshStandardNodeMaterial>();
    const rimLight = (): V3 => {
      // Back-lit silhouettes: a cold rim where surfaces turn away from the viewer.
      const ndv = abs(dot(normalize(normalView), normalize(positionView.negate()))).min(1);
      return vec3(0.2, 0.23, 0.29).mul(pow(float(1).sub(ndv), float(2.5))).mul(float(1).add((w.u.clear as unknown as F).mul(2))) as V3;
    };
    const dress = (model: Object3D, sp: SpeciesP, cast: boolean, screen: boolean): void => {
      model.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material;
        const key = `${sp.id}|${src?.uuid}`;
        let mat = matCache.get(key);
        if (!mat) {
          const transparent = (src as { transparent?: boolean })?.transparent === true;
          mat = litMaterial(w, src, { presence: presence as unknown as F, tint: sp.tint, roughness: sp.roughness, glow: rimLight(), alphaTest: transparent ? 0.35 : undefined, doubleSided: transparent });
          matCache.set(key, mat);
          owned.push(mat);
        }
        mesh.material = mat;
        mesh.frustumCulled = false;
      });
      castMoonShadows(model, cast);
      if (screen) model.traverse((o) => o.layers.enable(SCREEN_LAYER));
    };

    // ---- Agents (one per setpiece; models are cloned lazily the first time a setpiece runs).
    const threadGeo = new CylinderGeometry(1, 1, 1, 5, 1, true);
    threadGeo.translate(0, -0.5, 0);
    const threadMat = new MeshBasicNodeMaterial();
    {
      const keep = exp(fogDepth(w, positionWorld as unknown as V3).negate());
      threadMat.colorNode = vec4(vec3(0.16, 0.18, 0.22).mul(keep).mul(revealMask(presence as unknown as F)), 1);
      threadMat.blending = AdditiveBlending;
      threadMat.transparent = true;
      threadMat.depthWrite = false;
      threadMat.fog = false;
    }
    const agents: Agent[] = p.setpieces.map((spec, i) => {
      const holder = new Group();
      holder.visible = false;
      group.add(holder);
      const path = spec.path.map((q) => new Vector3(...q));
      const cum = [0];
      for (let k = 1; k < path.length; k++) cum.push(cum[k - 1]! + path[k]!.distanceTo(path[k - 1]!));
      return {
        spec,
        cal: spec.species ? (cals.get(spec.species) ?? null) : null,
        holder,
        model: null,
        mixer: null,
        action: null,
        eyeBone: null,
        eyeLocal: new Vector3(),
        rootBone: null,
        rootRest: new Vector3(),
        scale: 1,
        running: false,
        t: 0,
        state: 'out',
        s: 0,
        dir: 1,
        timer: 0,
        speed: 0,
        pos: new Vector3(),
        fwd: new Vector3(0, 0, 1),
        up: new Vector3(0, 1, 0),
        eyes: 0,
        awake: 0,
        lastCycle: 0,
        thread: null,
        clusters: [],
        rand: seeded(p.seed * 977 + i * 131),
        pathLen: cum,
      };
    });
    const paths = p.setpieces.map((spec) => spec.path.map((q) => new Vector3(...q)));

    const ensureModel = (a: Agent): void => {
      if (a.model || !a.cal) return;
      const cal = a.cal;
      const model = cloneSkinned(cal.scene);
      const inner = new Group();
      // Native forward -> +Z, feet centre -> origin, leg span -> the setpiece's span.
      const span = a.spec.span ?? cal.sp.span;
      a.scale = span / cal.span;
      inner.quaternion.setFromUnitVectors(cal.forward, new Vector3(0, 0, 1));
      inner.scale.setScalar(a.scale);
      inner.position.copy(cal.feet).applyQuaternion(inner.quaternion).multiplyScalar(-a.scale);
      inner.add(model);
      a.holder.add(inner);
      dress(model, cal.sp, a.spec.kind !== 'silhouette', a.spec.shadow);
      if (cal.clip) {
        a.mixer = new AnimationMixer(model);
        a.action = a.mixer.clipAction(cal.clip);
        a.action.play();
        a.action.time = a.rand() * cal.clip.duration;
      }
      model.traverse((o) => {
        if (o.name === cal.eyeBone) a.eyeBone = o;
        if (o.name === cal.rootBone) a.rootBone = o;
      });
      if (a.rootBone) a.rootRest.copy(a.rootBone.position);
      a.eyeLocal.copy(cal.eyeLocal);
      a.model = model;
      if (a.spec.kind === 'hang') {
        a.thread = new Mesh(threadGeo, threadMat);
        a.thread.frustumCulled = false;
        group.add(a.thread);
      }
    };

    const start = (a: Agent): void => {
      ensureModel(a);
      a.running = true;
      a.t = 0;
      a.awake = 0;
      a.eyes = 0;
      const sp = a.spec;
      if (sp.kind === 'eyes') {
        a.clusters = [];
        const c = new Vector3(...(sp.at ?? [0, 0, -60]));
        for (let k = 0; k < sp.count; k++) {
          const off = new Vector3((a.rand() - 0.5) * 2, (a.rand() - 0.5) * 0.8, (a.rand() - 0.5) * 0.6).multiplyScalar(sp.spread);
          a.clusters.push({ p: c.clone().add(off), n: [2, 4, 8, 8][Math.floor(a.rand() * 4)]!, delay: a.rand() * 4, blink: 3 + a.rand() * 6 });
        }
        a.timer = 10 + a.rand() * 10;
        return;
      }
      if (sp.kind === 'tremble') {
        a.timer = 2.5 + a.rand() * 2;
        return;
      }
      a.holder.visible = true;
      if (sp.kind === 'hang') {
        a.state = 'descend';
        a.s = 0;
        a.timer = sp.hold[0] + a.rand() * (sp.hold[1] - sp.hold[0]);
        return;
      }
      a.state = sp.wait > 0 ? 'wait' : 'walk';
      a.timer = sp.wait;
      a.s = 0;
      a.dir = 1;
      a.speed = 0;
      const path = paths[agents.indexOf(a)]!;
      if (path.length >= 2) {
        a.pos.copy(path[0]!);
        a.fwd.copy(path[1]!).sub(path[0]!).normalize();
      }
    };

    const stop = (a: Agent, now: number): void => {
      a.running = false;
      a.holder.visible = false;
      if (a.thread) a.thread.visible = false;
      director.finish(a.spec.id, now);
    };

    // ---- The director (residents run outside it).
    const specs: SetpieceSpec[] = p.setpieces.filter((s) => !s.resident && !(comfort !== 'full' && s.near)).map((s) => ({ id: s.id, kind: s.kind as SetpieceKind, weight: s.weight, cooldown: s.cooldown, sudden: s.sudden }));
    const director = new Director(specs, { seed: p.seed, comfort, gap: p.gap, opening: p.opening });
    for (const a of agents) if (a.spec.resident && !(comfort === 'off' && a.spec.kind !== 'eyes')) start(a);

    // ---- Eyes and the fog screen.
    const eyes = new EyeField(agents.length * 8 * 8 + 16, w, presence as unknown as F);
    group.add(eyes.mesh);
    let screenLight: SpotLight | null = null;
    let screenMesh: Mesh | null = null;
    if (p.screen && ctx.quality.detail !== 'low') {
      const sc = p.screen;
      const lc = linear(sc.color);
      const light = new SpotLight(0xffffff, sc.intensity, 0, Math.PI / 7, 0.6, 1.2);
      light.color.setRGB(lc.x, lc.y, lc.z);
      light.position.set(...sc.light);
      light.target.position.set(...sc.center);
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.near = 5;
      light.shadow.camera.far = new Vector3(...sc.light).distanceTo(new Vector3(...sc.center)) * 1.4;
      light.shadow.bias = -0.002;
      light.shadow.radius = 4;
      light.shadow.camera.layers.set(SCREEN_LAYER);
      light.updateMatrixWorld(true);
      light.target.updateMatrixWorld(true);
      screenLight = light;
      const mat = new MeshStandardNodeMaterial();
      mat.lightsNode = lights([light]);
      mat.colorNode = vec4(1, 1, 1, 1);
      mat.roughnessNode = float(1);
      mat.metalnessNode = float(0);
      // The screen takes the light on its far side: its normal faces the lamp.
      const toLight = new Vector3(...sc.light).sub(new Vector3(...sc.center)).normalize();
      mat.normalNode = normalize(cameraViewMatrix.mul(vec4(toLight.x, toLight.y, toLight.z, 0)).xyz);
      const q = uv().sub(0.5).mul(2);
      const edge = smoothstep(1, 0.55, q.x.abs()).mul(smoothstep(1, 0.45, q.y.abs()));
      const n1 = mx_noise_float(positionWorld.mul(0.035).add(vec3((w.u.time as unknown as F).mul(0.03), 0, 0))).mul(0.5).add(0.5);
      const n2 = mx_noise_float(positionWorld.mul(0.09).add(vec3(0, (w.u.time as unknown as F).mul(0.02), 0))).mul(0.5).add(0.5);
      const density = edge.mul(n1.mul(0.7).add(n2.mul(0.3))).mul(sc.opacity);
      const keep = exp(fogDepth(w, positionWorld as unknown as V3).mul(-0.6));
      mat.outputNode = vec4(output.rgb.mul(density).mul(keep).mul(revealMask(presence as unknown as F)), 1);
      mat.blending = AdditiveBlending;
      mat.transparent = true;
      mat.depthWrite = false;
      mat.side = DoubleSide;
      mat.fog = false;
      owned.push(mat);
      const geo = new PlaneGeometry(sc.size[0], sc.size[1]);
      screenMesh = new Mesh(geo, mat);
      screenMesh.position.set(...sc.center);
      screenMesh.lookAt(EYE);
      screenMesh.receiveShadow = true;
      screenMesh.renderOrder = 2;
      group.add(screenMesh);
    }

    // ---- Per frame.
    const sounds = ctx.sounds as unknown as { emit(id: string, x: number, y: number, z: number, gain?: number): void };
    let stepBudget = 0;
    const emit = (id: string, at: Vector3, gain: number): void => {
      if (stepBudget < 1 || at.distanceTo(EYE) > 110) return;
      stepBudget -= 1;
      try {
        sounds.emit(id, at.x, at.y, at.z, Math.min(1, gain));
      } catch {
        /* a host without this sound */
      }
    };
    const eyeCol = (a: Agent): { r: number; g: number; b: number } => {
      // Eyeshine, not lamps: a touch less saturated than the nominal colour.
      const c = linear(a.spec.eyeColor ?? a.cal?.sp.eyeColor ?? '#ff5a2a');
      const l = (c.x + c.y + c.z) / 3;
      return { r: c.x * 0.8 + l * 0.2, g: c.y * 0.8 + l * 0.2, b: c.z * 0.8 + l * 0.2 };
    };
    const comfortEyes = comfort === 'full' ? 1 : comfort === 'calm' ? 0.65 : 0.4;

    const place = (a: Agent): void => {
      const up = a.up;
      const f = _v.copy(a.fwd).addScaledVector(up, -a.fwd.dot(up)).normalize();
      const right = _x.crossVectors(up, f).normalize();
      _m.makeBasis(right, up, f);
      a.holder.quaternion.setFromRotationMatrix(_m);
      a.holder.position.copy(a.pos);
    };

    const stepWalk = (a: Agent, dt: number, now: number): void => {
      const sp = a.spec;
      const idx = agents.indexOf(a);
      const path = paths[idx]!;
      const cum = a.pathLen;
      const L = cum[cum.length - 1] ?? 0;
      a.up.set(...sp.normal).normalize();
      if (a.state === 'wait') {
        a.timer -= dt;
        a.speed = 0;
        if (a.timer <= 0) a.state = 'walk';
      } else if (a.state === 'pause') {
        a.timer -= dt;
        a.speed = Math.max(0, a.speed - dt * 1.5);
        if (a.timer <= 0) a.state = 'walk';
      } else if (a.state === 'walk') {
        const target = sp.speed * (sp.kind === 'silhouette' ? 1 : 0.9 + 0.2 * Math.sin(now * 0.3 + idx));
        a.speed += (target - a.speed) * Math.min(1, dt * 1.2);
        const before = a.s;
        a.s += a.dir * a.speed * dt;
        // Pauses at path points: stop, look around.
        for (let k = 1; k < cum.length - 1; k++) {
          const c = cum[k]!;
          if ((before - c) * (a.s - c) <= 0 && a.rand() < sp.pauses) {
            a.state = 'pause';
            a.timer = 1.5 + a.rand() * 4;
          }
        }
        if (a.s >= L || a.s <= 0) {
          if (sp.resident) {
            a.dir = -a.dir;
            a.state = 'pause';
            a.timer = 2 + a.rand() * 4;
          } else if (sp.retreat && a.dir > 0) {
            a.dir = -1;
            a.state = 'pause';
            a.timer = 2 + a.rand() * 3;
          } else {
            stop(a, now);
            return;
          }
          a.s = Math.min(L, Math.max(0, a.s));
        }
      }
      if (path.length >= 2) {
        along(path, cum, a.s, a.pos, _w);
        const want = _w.multiplyScalar(a.dir);
        // Turn towards the travel direction at a pace set by the body's weight.
        const rate = (1.6 - (a.cal?.sp.weight ?? 0.5)) * dt;
        a.fwd.lerp(want, Math.min(1, rate)).normalize();
      }
      place(a);
    };

    const stepHang = (a: Agent, dt: number, now: number): void => {
      const sp = a.spec;
      const anchor = _w.set(...(sp.anchor ?? [0, 30, -60]));
      if (a.state === 'descend') {
        a.s = Math.min(sp.depth, a.s + dt * (0.5 + 0.6 * Math.min(1, (sp.depth - a.s) / 3)));
        if (a.s >= sp.depth) a.state = 'hold';
        a.speed = 0.4;
      } else if (a.state === 'hold') {
        a.timer -= dt;
        a.speed = 0.08;
        if (a.timer <= 0) a.state = 'ascend';
      } else if (a.state === 'ascend') {
        a.s = Math.max(0, a.s - dt * 0.55);
        a.speed = 0.35;
        if (a.s <= 0) {
          stop(a, now);
          return;
        }
      }
      const sway = Math.sin(now * 0.7) * 0.15 * Math.min(1, a.s / 4);
      a.pos.set(anchor.x + sway, anchor.y - a.s, anchor.z);
      // Hanging head down, its back to the viewer, turning slowly on the thread.
      a.up.set(Math.sin(now * 0.2) * 0.3, 0, 1).normalize();
      a.fwd.set(0, -1, 0);
      place(a);
      if (a.thread) {
        a.thread.visible = true;
        const r = Math.max(0.006, (sp.span ?? a.cal?.sp.span ?? 3) * 0.004);
        a.thread.position.copy(anchor);
        a.thread.scale.set(r, Math.max(0.01, a.s + (sp.span ?? 3) * 0.05), r);
        a.thread.lookAt(_v.copy(a.pos).add(new Vector3(0, -1000, 0)));
        a.thread.rotation.set(0, 0, 0);
      }
    };

    let clock = 0;
    const update = (dt: number, time: number, audio: { bass: number; sectionIntensity: number }): void => {
      clock += dt;
      stepBudget = Math.min(4, stepBudget + dt * 3);
      for (const id of director.update(clock, audio.sectionIntensity)) {
        const a = agents.find((x) => x.spec.id === id);
        if (a) start(a);
      }
      eyes.begin();
      const bassK = 1 + audio.bass * 0.15;
      for (const a of agents) {
        if (!a.running) continue;
        a.t += dt;
        const sp = a.spec;
        if (sp.kind === 'eyes') {
          // Watchers: clusters open one by one, blink, shift, then close.
          a.timer -= dt;
          const fadeOut = Math.min(1, Math.max(0, a.timer / 3));
          const col = eyeCol(a);
          for (const c of a.clusters) {
            const open = Math.min(1, Math.max(0, (a.t - c.delay) / 3)) * fadeOut;
            const blink = (a.t + c.delay * 3) % c.blink < 0.18 ? 0.1 : 1;
            const k = open * blink * comfortEyes * bassK * 1.6;
            if (k <= 0.001) continue;
            const drift = Math.sin(a.t * 0.3 + c.delay) * sp.spread * 0.03;
            const toCam = _v.copy(EYE).sub(c.p).normalize();
            const right = _x.crossVectors(new Vector3(0, 1, 0), toCam).normalize();
            const n = c.n;
            for (let e = 0; e < n; e++) {
              const [ex, ey, , es] = EIGHT_EYES[e]!;
              const s = sp.eyeSize * 3.2;
              eyes.add(c.p.x + right.x * (ex * s + drift) , c.p.y + ey * s, c.p.z + right.z * (ex * s + drift), sp.eyeSize * es, col.r * k, col.g * k, col.b * k);
            }
          }
          if (a.timer <= 0) stop(a, clock);
          continue;
        }
        if (sp.kind === 'tremble') {
          a.timer -= dt;
          const web = websOf(w)[sp.web];
          if (web && a.rand() < dt * 3) {
            const r = web.radius * Math.sqrt(a.rand()) * 0.8;
            const ang = a.rand() * Math.PI * 2;
            const at = _v.copy(web.center).addScaledVector(web.right, Math.cos(ang) * r).addScaledVector(web.up, Math.sin(ang) * r);
            pluck(w, at.x, at.y, at.z, 0.35 + a.rand() * 0.4);
            if (a.rand() < 0.4) emit('webHum', at, 0.4);
          }
          if (a.timer <= 0) stop(a, clock);
          continue;
        }
        if (sp.kind === 'hang') stepHang(a, dt, clock);
        else stepWalk(a, dt, clock);
        if (!a.running) continue;
        // Legs: the walk clip at the speed that keeps the feet planted.
        const cal = a.cal;
        if (a.mixer && a.action && cal) {
          const ts = a.speed > 0.02 ? a.speed / Math.max(1e-4, cal.stride * a.scale) : 0.05 * Math.sin(a.t * 0.8);
          a.action.timeScale = Math.max(-3.5, Math.min(3.5, ts * (a.dir < 0 && sp.kind !== 'hang' ? 1 : 1)));
          a.mixer.update(reduced ? dt * 0.8 : dt);
          if (a.rootBone) {
            a.rootBone.position.x = a.rootRest.x;
            a.rootBone.position.z = a.rootRest.z;
          }
          // Contacts twice a cycle: heard, and felt by the webs nearby.
          const dur = cal.clip?.duration ?? 1;
          const cycle = Math.floor(((a.action.time % dur) / dur) * 2);
          if (cycle !== a.lastCycle && a.speed > 0.1) {
            const heavy = cal.sp.weight;
            emit(heavy > 0.55 ? 'crawl' : 'skitter', a.pos, 0.25 + heavy * 0.7);
            if (sp.kind === 'webwalk') pluck(w, a.pos.x, a.pos.y, a.pos.z, 0.15 + heavy * 0.5);
          }
          a.lastCycle = cycle;
        }
        // Visibility: eyes wake, face the viewer, and carry further as the creature comes closer.
        a.awake = Math.min(1, a.awake + dt * (a.state === 'wait' ? 0.35 : 0.6));
        if (a.eyeBone && cal) {
          a.holder.updateMatrixWorld(true);
          const anchor = _v.copy(a.eyeLocal).applyMatrix4(a.eyeBone.matrixWorld);
          const fwdW = _w.copy(a.fwd);
          const toCam = _x.copy(EYE).sub(anchor);
          const dist = toCam.length();
          toCam.divideScalar(dist);
          const facing = Math.min(1, Math.max(0, (fwdW.dot(toCam) + 0.25) / 0.9));
          const near = Math.min(1, Math.max(0.25, 1 - (dist - 25) / 160));
          const flick = 0.85 + 0.15 * Math.sin(a.t * 1.7 + agents.indexOf(a)) * Math.sin(a.t * 0.43);
          const k = a.awake * facing * near * flick * comfortEyes * cal.sp.eyeGlow * bassK * 1.25;
          if (k > 0.002 && sp.kind !== 'silhouette') {
            const col = eyeCol(a);
            const span = sp.span ?? cal.sp.span;
            const cw = span * cal.sp.carapace;
            const up = a.up;
            const right = new Vector3().crossVectors(up, fwdW).normalize();
            for (const [ex, ey, ez, es] of EIGHT_EYES) {
              eyes.add(anchor.x + right.x * ex * cw + up.x * ey * cw + fwdW.x * ez * cw, anchor.y + right.y * ex * cw + up.y * ey * cw + fwdW.y * ez * cw, anchor.z + right.z * ex * cw + up.z * ey * cw + fwdW.z * ez * cw, cw * 0.06 * es, col.r * k, col.g * k, col.b * k);
            }
          }
        }
      }
      eyes.end();
      void time;
    };

    const onClear = (lines: number): void => {
      // A QUAD wakes the dark: an eye cluster opens somewhere, if one is resting.
      if (lines < 4 || comfort !== 'full') return;
      const free = agents.filter((a) => a.spec.kind === 'eyes' && !a.running && !a.spec.resident);
      if (free.length === 0) return;
      const a = free[Math.floor(Math.random() * free.length)]!;
      if (!director.active.has(a.spec.id)) start(a);
    };

    // Dev and test builds only: start a setpiece by id, read the agents (review captures).
    if (typeof __PRISMFALL_HOOKS__ !== 'undefined' && __PRISMFALL_HOOKS__) {
      group.userData.webSpiders = {
        start: (id: string) => {
          const a = agents.find((x) => x.spec.id === id);
          if (a && !a.running) start(a);
          return !!a;
        },
        agents: () => agents.map((a) => ({ id: a.spec.id, running: a.running, state: a.state, pos: a.pos.toArray(), eyes: a.awake, scale: a.scale, stride: a.cal?.stride, forward: a.cal?.forward.toArray(), span: a.cal?.span })),
      };
    }

    return {
      object: group,
      update(frame) {
        tick(w, frame.time, frame.dt, musicOf(frame));
        update(Math.min(0.1, frame.dt), frame.time, frame.audio);
      },
      onGameEvent(e) {
        if (e.kind === 'clear') {
          w.u.clear.value = Math.min(1, w.u.clear.value + 0.15 * e.lines);
          onClear(e.lines);
        }
      },
      onCall(call) {
        // Manifest call-ins (a drop, a build, a back-to-back): the director brings in a setpiece of
        // the asked kinds if one may run now (its comfort rules, rests and limits apply).
        if (call.action !== 'show' && call.action !== 'reveal') return;
        const kinds = Array.isArray(call.params.kinds) ? call.params.kinds.filter((k): k is SetpieceKind => typeof k === 'string') : [];
        const id = director.call(kinds, clock);
        const a = id ? agents.find((x) => x.spec.id === id) : undefined;
        if (a && !a.running) start(a);
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        for (const a of agents) {
          a.mixer?.stopAllAction();
          if (a.model) a.mixer?.uncacheRoot(a.model);
        }
        for (const m of owned) m.dispose();
        threadGeo.dispose();
        threadMat.dispose();
        eyes.dispose();
        screenMesh?.geometry.dispose();
        screenLight?.shadow.map?.dispose();
        screenLight?.dispose();
        for (const sp of p.species) ctx.assets.release(sp.src);
        release(w);
      },
    };
  },
};

