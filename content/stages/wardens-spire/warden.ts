import {
  AdditiveBlending,
  ConeGeometry,
  FrontSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
  type Material,
  type Object3D,
} from 'three/webgpu';
import {
  Fn,
  Loop,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  mrt,
  normalWorldGeometry,
  normalize,
  positionLocal,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep,
  step,
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { additiveFog, seeded, z, type ComponentFactory, type EnvironmentContext, type StageGameEvent } from '@prismfall/sdk';
import { WardenController, type WardenOutput } from './controller';
import { beamDirection, gazeRules, gazeTowards } from './gaze';
import { wardenPosition } from './citadel';
import { COLORS, DEG, EYE, clearMask, duskLight, macro, noise3D, polar, release, revealMask, shared, siteCentre, spireLight, stageTexture, triplanar, zSite } from './shared';

/**
 * The Warden: a churning molten core held in a cage of three carved stone rings at the summit of
 * the spire. The rings swing after one another as it turns; a square stone collar on the beam side
 * holds four shutters that close in when it focuses. Its light is a searchlight drawn as true
 * in-scattering (the beam's cone is integrated along every view ray through it), aimed exactly
 * where the cage points. A controller (controller.ts) decides where it looks.
 */

const schema = z.object({
  site: zSite,
  src: z.string().default('models/warden.glb'),
  rock: z.string().default('textures/dark_rock_02_diff.webp'),
  seed: z.number().default(23),
  /** Places worth searching, as [view azimuth (deg), distance from the eye (m)]. */
  targets: z.array(z.tuple([z.number(), z.number()])).default([]),
  /** The horizon arc it scans (beam headings, degrees) and its pitch range (degrees, negative = down). */
  horizon: z.object({ from: z.number().default(24), to: z.number().default(52), pitch: z.tuple([z.number(), z.number()]).default([-6, -2]) }).prefault({}),
  land: z.object({ heading: z.tuple([z.number(), z.number()]).default([-175, 150]), pitch: z.tuple([z.number(), z.number()]).default([-44, -6]) }).prefault({}),
  /** Minimum angle between the beam and the direction to the viewer (degrees). */
  separation: z.number().default(20),
  /** Nothing the beam lights comes within this angle of the view axis (degrees). */
  clearZone: z.number().default(23),
  /** Beam half-angle (degrees), open and focused. */
  beamAngle: z.tuple([z.number(), z.number()]).default([5.2, 2.2]),
  beam: z.number().default(1),
  core: z.number().default(1),
  /** Long sweeps across the land in front of the citadel: [from, to] as [azimuth, distance] from the eye. */
  sweeps: z.array(z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])])).default([]),
  /** Share of scans that sweep the land instead of the horizon. */
  sweepShare: z.number().min(0).max(1).default(0.45),
  /** Mean seconds between awakenings on its own. */
  awakenEvery: z.number().default(320),
  /** QUADs and perfect clears may stir it: chance and cooldown (s). */
  stir: z.object({ chance: z.number().min(0).max(1).default(0.3), cooldown: z.number().default(110) }).prefault({}),
  bloom: z.number().default(0.3),
});

type Params = z.infer<typeof schema>;

export const wardenComponent: ComponentFactory<Params> = {
  type: 'wardenSpireWarden',
  version: 1,
  description: 'The Warden: a molten core in a cage of turning carved stone rings, its searchlight beam and the controller that makes it search, focus, gaze and wake.',
  schema,
  async create(ctx: EnvironmentContext, p: Params) {
    const s = shared(ctx);
    const [gltf, rock, noise] = await Promise.all([ctx.assets.loadGLTF(p.src), stageTexture(ctx, s, p.rock, 'color'), noise3D(s)]);
    const group = new Group();
    group.name = 'wardens-spire-warden';
    const W = wardenPosition(p.site);
    const presence = uniform(1);
    const time = ctx.uniforms.time;
    const disposables: { dispose(): void }[] = [];
    s.u.core.value.set(W[0], W[1], W[2]);

    // --- The cage: ring A turns on its own, ring B follows the heading, ring C, the collar and
    // the shutters follow the full aim. Nested lag makes them swing after one another.
    const root = new Group();
    root.position.set(W[0], W[1], W[2]);
    group.add(root);
    const ringAHolder = new Group();
    const yawG = new Group();
    const ringBHolder = new Group();
    const pitchG = new Group();
    const ringCHolder = new Group();
    root.add(ringAHolder, yawG);
    yawG.add(ringBHolder, pitchG);
    pitchG.add(ringCHolder);
    const parts = new Map<string, Object3D>();
    for (const child of [...gltf.scene.clone(true).children]) parts.set(child.name, child);
    const put = (name: string, parent: Object3D) => {
      const o = parts.get(name);
      if (o) parent.add(o);
      return o ?? null;
    };
    put('cage_ring_a', ringAHolder);
    put('cage_ring_b', ringBHolder);
    put('cage_ring_c', ringCHolder);
    put('cage_collar', pitchG);
    const shutters: { obj: Object3D; base: Vector3; inward: Vector3 }[] = [];
    for (let k = 0; k < 4; k++) {
      const o = put(`cage_shutter_${k}`, pitchG);
      if (!o) continue;
      // Inward = towards the beam axis (local -Z), in the plane across it.
      o.updateMatrixWorld(true);
      const box = new Vector3();
      let count = 0;
      o.traverse((m) => {
        if (m instanceof Mesh) {
          m.geometry.computeBoundingBox();
          const c = m.geometry.boundingBox!.getCenter(new Vector3()).applyMatrix4(m.matrix);
          box.add(c);
          count++;
        }
      });
      if (count) box.divideScalar(count);
      const inward = new Vector3(-box.x, -box.y, 0).normalize();
      shutters.push({ obj: o, base: o.position.clone(), inward });
    }

    // Stone of the cage: near black, lit hard from the fire inside.
    const n = normalWorldGeometry;
    const wp = positionWorld;
    const tex = rock ? triplanar(rock, wp, n, 1 / 6) : vec3(0.3, 0.3, 0.3);
    const grey = dot(tex, vec3(0.3, 0.55, 0.15));
    const alb = mix(vec3(grey, grey, grey), tex, 0.2).mul(0.3).mul(macro(wp, 0.05));
    const cageStone = new MeshBasicNodeMaterial();
    cageStone.colorNode = vec4(alb.mul(spireLight(s, wp, n, { core: 1.4, beam: 0, bolt: 1, rim: 1 }).add(duskLight(wp, n, { back: 0.8, k: 0.45 }))).mul(presence), 1);
    cageStone.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    cageStone.fog = true;
    cageStone.opacityNode = revealMask(presence);
    cageStone.alphaTest = 0.5;
    const ironAlb = vec3(0.06, 0.05, 0.045);
    const view = normalize(wp.sub(cameraPosition));
    const toCore = normalize(s.u.core.sub(wp));
    const sheen = clamp(dot(normalize(toCore.sub(view)), n), 0, 1).pow(14).mul(s.u.coreGlow);
    const cageIron = new MeshBasicNodeMaterial();
    cageIron.colorNode = vec4(ironAlb.mul(spireLight(s, wp, n, { core: 1.6, beam: 0, bolt: 1, rim: 1 }).add(duskLight(wp, n, { k: 0.45 }))).add(COLORS.coreHot.mul(sheen.mul(1.2))).mul(presence), 1);
    cageIron.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    cageIron.fog = true;
    cageIron.opacityNode = revealMask(presence);
    cageIron.alphaTest = 0.5;
    disposables.push(cageStone, cageIron);
    root.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.material = (o.material as Material).name === 'wardenMetal' ? cageIron : cageStone;
      o.frustumCulled = false;
    });

    // --- The molten core: churning, domain-warped fire with moving inner veins; its outline
    // boils (the surface is displaced by the same flow).
    const coreR = 18;
    const u = {
      glow: uniform(1),
      focus: uniform(0),
      stir: uniform(0),
    };
    const pl = positionLocal.div(coreR);
    const tw = time.mul(0.6);
    const warp = texture3D(noise, pl.mul(0.32).add(vec3(0, tw.mul(-0.05), tw.mul(0.02)))).rgb.sub(0.5);
    const billow = texture3D(noise, pl.mul(0.55).add(warp.mul(0.7)).add(vec3(tw.mul(0.03), tw.mul(0.08), 0))).r;
    const vein = texture3D(noise, pl.mul(1.25).sub(warp.mul(1.1)).add(vec3(tw.mul(0.05), 0, tw.mul(-0.06)))).g;
    const boil = billow.sub(0.5).mul(0.34).add(vein.sub(0.5).mul(0.12));
    const coreMat = new MeshBasicNodeMaterial();
    coreMat.positionNode = positionLocal.mul(float(1).add(boil.mul(float(1).add(u.stir.mul(0.6)))));
    const vdir = normalize(positionWorld.sub(cameraPosition));
    const facing = clamp(dot(normalWorldGeometry, vdir.negate()), 0, 1);
    const temp = billow.mul(0.7).add(smoothstep(0.04, 0.0, vein.sub(0.5).abs()).mul(0.5)).add(facing.mul(0.45)).add(u.focus.mul(0.3));
    const ramp = mix(mix(vec3(0.5, 0.05, 0.0), vec3(1.0, 0.32, 0.05), smoothstep(0.3, 0.7, temp)), vec3(1.0, 0.74, 0.42), smoothstep(0.85, 1.3, temp));
    const coreE = ramp.mul(u.glow.mul(float(2.2).add(temp.mul(3.2)))).mul(p.core);
    coreMat.colorNode = vec4(coreE.mul(presence), 1);
    coreMat.mrtNode = mrt({ emissive: vec4(coreE.mul(p.bloom), 1) });
    coreMat.fog = true;
    const coreGeo = new IcosahedronGeometry(coreR, 5);
    const coreMesh = new Mesh(coreGeo, coreMat);
    coreMesh.frustumCulled = false;
    root.add(coreMesh);
    disposables.push(coreGeo, coreMat);

    // Corona and flame tongues licking up through the cage (additive, distance-faded).
    const flameCount = 14;
    const fd = new Float32Array(flameCount * 4);
    const frand = seeded(p.seed * 41);
    for (let i = 0; i < flameCount; i++) {
      fd[i * 4] = frand() * Math.PI * 2;
      fd[i * 4 + 1] = frand();
      fd[i * 4 + 2] = 0.6 + frand() * 0.8;
      fd[i * 4 + 3] = frand();
    }
    const fa = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(fd, 4), 'vec4');
    const fAge = fract(time.mul(fa.z.mul(0.32)).add(fa.w));
    const fPos = vec3(W[0], W[1], W[2]).add(vec3(sin(fa.x).mul(coreR * 0.5), fAge.mul(38).sub(2), sin(fa.x.add(1.57)).mul(coreR * 0.5)));
    const fq = uv().sub(0.5).mul(2);
    const fn = texture3D(noise, vec3(uv().x.mul(0.6).add(fa.y), uv().y.mul(0.3).sub(fAge.mul(0.6)), fa.w.add(time.mul(0.05)))).r;
    const tongue = smoothstep(1, 0, length(vec3(fq.x.mul(1.6), fq.y, 0))).mul(smoothstep(0.35, 0.7, fn.add(fq.y.mul(-0.2)).add(0.15)));
    const fLife = smoothstep(0, 0.15, fAge).mul(smoothstep(1, 0.45, fAge));
    const flameE = mix(COLORS.coreHot, COLORS.core, fAge).mul(tongue.mul(fLife).mul(u.glow).mul(1.25));
    const flameMat = new SpriteNodeMaterial();
    flameMat.positionNode = fPos;
    flameMat.scaleNode = float(20).add(fAge.mul(18)).mul(fa.z);
    flameMat.colorNode = vec4(additiveFog(flameE.mul(presence)), 1);
    flameMat.blending = AdditiveBlending;
    flameMat.transparent = true;
    flameMat.depthWrite = false;
    flameMat.fog = false;
    flameMat.mrtNode = mrt({ emissive: vec4(flameE.mul(p.bloom * 0.6), 1) });
    const flames = new Sprite(flameMat);
    flames.count = flameCount;
    flames.frustumCulled = false;
    flames.renderOrder = 4;
    group.add(flames);
    disposables.push(flameMat);

    const coronaMat = new SpriteNodeMaterial();
    const cq = uv().sub(0.5).mul(2);
    const cr = length(cq);
    const cn = texture3D(noise, vec3(cq.mul(0.4).add(0.5), time.mul(0.02))).a;
    // Heat rising off the fire: a tall, ragged glow above the core (never a round halo).
    const tall = vec3(cq.x.mul(1.7), cq.y.add(0.25).mul(0.75), 0);
    const cr2 = tall.length();
    const rag = texture3D(noise, vec3(cq.x.mul(0.6).add(0.5), cq.y.mul(0.35).sub(time.mul(0.05)), time.mul(0.013))).r;
    const corona = exp(cr2.mul(cr2).mul(-4.2)).mul(smoothstep(0.25, 0.75, rag.add(cq.y.mul(-0.15)).add(0.2))).mul(smoothstep(1, 0.5, cr)).mul(cn.mul(0.3).add(0.85));
    const coronaE = COLORS.core.mul(corona.mul(u.glow).mul(float(0.32).add(s.u.awaken.mul(1.1))));
    coronaMat.positionNode = vec3(W[0], W[1] + 22, W[2]);
    coronaMat.scaleNode = float(96).mul(float(1).add(s.u.awaken.mul(0.4)));
    coronaMat.colorNode = vec4(additiveFog(coronaE.mul(presence)), 1);
    coronaMat.blending = AdditiveBlending;
    coronaMat.transparent = true;
    coronaMat.depthWrite = false;
    coronaMat.fog = false;
    coronaMat.mrtNode = mrt({ emissive: vec4(coronaE.mul(p.bloom * 0.4), 1) });
    const coronaSprite = new Sprite(coronaMat);
    coronaSprite.frustumCulled = false;
    coronaSprite.renderOrder = 3;
    group.add(coronaSprite);
    disposables.push(coronaMat);

    // Sparks: drifting embers thrown off the core, orbiting and rising through the cage.
    const sparkCount = Math.max(24, Math.round(140 * Math.min(1.5, ctx.quality.particles) * (ctx.quality.detail === 'low' ? 0.4 : 1)));
    const sd = new Float32Array(sparkCount * 4);
    for (let i = 0; i < sparkCount; i++) {
      sd[i * 4] = frand() * Math.PI * 2;
      sd[i * 4 + 1] = 14 + frand() * 34;
      sd[i * 4 + 2] = frand();
      sd[i * 4 + 3] = 0.5 + frand();
    }
    const sa = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(sd, 4), 'vec4');
    const sAge = fract(time.mul(0.11).mul(sa.w).add(sa.z));
    const sAng = sa.x.add(time.mul(0.12).mul(sa.w)).add(sAge.mul(1.4));
    const sR = sa.y.mul(float(0.6).add(sAge.mul(0.8)));
    const sPos = vec3(W[0], W[1], W[2]).add(vec3(sin(sAng).mul(sR), sAge.mul(110).sub(10).add(sin(sAng.mul(3)).mul(4)), sin(sAng.add(1.57)).mul(sR)));
    const sShape = smoothstep(1, 0, length(uv().sub(0.5).mul(2))).pow(2.2);
    const sE = vec3(1.0, 0.5, 0.15).mul(sShape.mul(float(1).sub(sAge)).mul(smoothstep(0, 0.06, sAge)).mul(2.6).mul(u.glow).mul(float(0.8).add(u.stir.mul(0.6))));
    const sparkMat = new SpriteNodeMaterial();
    sparkMat.positionNode = sPos;
    sparkMat.scaleNode = float(2.4).mul(float(1).sub(sAge.mul(0.5)));
    sparkMat.colorNode = vec4(additiveFog(sE.mul(presence)), 1);
    sparkMat.blending = AdditiveBlending;
    sparkMat.transparent = true;
    sparkMat.depthWrite = false;
    sparkMat.fog = false;
    sparkMat.mrtNode = mrt({ emissive: vec4(sE.mul(0.2), 1) });
    const sparks = new Sprite(sparkMat);
    sparks.count = sparkCount;
    sparks.frustumCulled = false;
    sparks.renderOrder = 4;
    group.add(sparks);
    disposables.push(sparkMat);

    // --- The beam: in-scattered light integrated along the view ray through the cone.
    const beamGeo = new ConeGeometry(1, 1, 32, 1, false);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, -0.5);
    const bu = s.u;
    const steps = ctx.quality.detail === 'low' ? 7 : ctx.quality.detail === 'medium' ? 10 : ctx.quality.detail === 'high' ? 14 : 18;
    const beamColor = Fn(() => {
      const o = cameraPosition;
      const v = normalize(positionWorld.sub(o));
      const A = bu.beamOrigin;
      const d = bu.beamDir;
      const w0 = o.sub(A);
      const b = dot(v, d);
      const d1 = dot(v, w0);
      const e1 = dot(d, w0);
      const denom = max(float(1).sub(b.mul(b)), 1e-4);
      const tStar = b.mul(e1).sub(d1).div(denom);
      const sStar = e1.sub(b.mul(d1)).div(denom).max(0).min(bu.beamReach);
      const R = sStar.mul(bu.beamTan).add(3);
      const sinT = denom.sqrt().max(0.04);
      const half = R.mul(2.6).div(sinT).min(4000);
      const t0 = tStar.sub(half).max(2);
      const t1 = tStar.add(half).max(t0.add(1));
      const dt = t1.sub(t0).div(steps);
      // Interleaved gradient noise: each pixel starts at a different offset (no banding).
      const ign = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));
      const acc = float(0).toVar();
      const drift = vec3(time.mul(0.9), time.mul(0.35), time.mul(-0.6));
      Loop(steps, ({ i }) => {
        const t = t0.add(dt.mul(float(i).add(ign)));
        const P = o.add(v.mul(t));
        const pa = P.sub(A);
        const along = dot(pa, d);
        const radial = length(pa.sub(d.mul(along)));
        const Rr = along.max(1).mul(bu.beamTan).add(2.5);
        const x = radial.div(Rr);
        const prof = exp(x.mul(x).mul(-2.2)).add(exp(x.mul(x).mul(-14)).mul(0.7));
        const inside = step(0, along).mul(float(1).sub(smoothstep(bu.beamReach.mul(0.9), bu.beamReach.mul(1.04), along)));
        // Smoke and dust drifting through the light (gives the beam its volume).
        const dust = texture3D(noise, P.add(drift).div(150)).a;
        const dust2 = texture3D(noise, P.sub(drift.mul(1.7)).div(47)).r;
        const smoke = smoothstep(0.25, 0.85, dust.mul(0.7).add(dust2.mul(0.45))).mul(1.3).add(0.25);
        const haze = exp(P.y.add(40).max(0).div(-190)).mul(1.3).add(0.35);
        // Spreads as it travels (less light per area), fades over the last part of its reach.
        const spread = float(1).div(float(1).add(along.div(700)));
        acc.addAssign(prof.mul(inside).mul(smoke).mul(haze).mul(spread));
      });
      // Mild forward scattering; air between the viewer and the beam dims it.
      const phase = float(0.75).add(clamp(dot(v, d.negate()), 0, 1).pow(4).mul(0.6));
      const trans = exp(tStar.max(0).mul(-0.00032));
      const k = acc.mul(dt).mul(0.02).mul(bu.beamPower).mul(phase).mul(trans).mul(clearMask(o.add(v.mul(tStar.max(10)))));
      return COLORS.beam.mul(k).mul(presence);
    });
    const beamE = beamColor();
    const beamMat = new MeshBasicNodeMaterial();
    beamMat.colorNode = vec4(beamE.mul(p.beam), 1);
    beamMat.mrtNode = mrt({ emissive: vec4(beamE.mul(p.bloom * 0.35), 1) });
    beamMat.blending = AdditiveBlending;
    beamMat.transparent = true;
    beamMat.depthWrite = false;
    beamMat.depthTest = true;
    beamMat.side = FrontSide;
    beamMat.fog = false;
    const beamMesh = new Mesh(beamGeo, beamMat);
    beamMesh.name = 'spire-beam';
    beamMesh.frustumCulled = false;
    beamMesh.renderOrder = 6;
    group.add(beamMesh);
    disposables.push(beamGeo, beamMat);

    // --- The controller and its rules.
    const site = siteCentre(p.site);
    // The crown's drum sits under the cage: the beam cannot turn steeper than about 46 degrees down.
    const allowed = gazeRules({ origin: W, eye: EYE, ground: -55, far: 2600, minSeparation: p.separation, clearZone: p.clearZone, pitch: [-46, 3] });
    const toEye = new Vector3(EYE[0] - W[0], EYE[1] - W[1], EYE[2] - W[2]).normalize();
    const targets = p.targets.map(([az, dist]) => {
      const [x, zz] = polar(az, dist);
      return { ...gazeTowards(W, [x, ctx.ground.height(x, zz) + 4, zz]), weight: 1 };
    });
    // The plateau's scarp below the fortress (the beam turning down reveals it).
    for (const a of [-60, -20, 20, 70, 120]) {
      const r = p.site.radius * 1.35;
      const x = site[0] + Math.sin(a * DEG) * r;
      const zz = site[2] - Math.cos(a * DEG) * r;
      targets.push({ ...gazeTowards(W, [x, ctx.ground.height(x, zz) + 4, zz]), weight: 0.5 });
    }
    const controller = new WardenController({
      seed: p.seed,
      allowed,
      targets: targets.filter((t) => allowed(t.heading, t.pitch)),
      horizon: { from: p.horizon.from * DEG, to: p.horizon.to * DEG, pitch: [p.horizon.pitch[0] * DEG, p.horizon.pitch[1] * DEG] },
      land: { heading: [p.land.heading[0] * DEG, p.land.heading[1] * DEG], pitch: [p.land.pitch[0] * DEG, p.land.pitch[1] * DEG] },
      awakenEvery: p.awakenEvery,
      sweeps: p.sweeps
        .map(([a, b]) => {
          const at = (q: readonly [number, number]) => {
            const [x, zz] = polar(q[0], q[1]);
            return gazeTowards(W, [x, ctx.ground.height(x, zz) + 4, zz]);
          };
          return { from: at(a), to: at(b) };
        })
        .filter((sw) => allowed(sw.from.heading, sw.from.pitch) && allowed(sw.to.heading, sw.to.pitch)),
      sweepShare: p.sweepShare,
    });
    s.wake = (k) => controller.awaken(k);

    // Where the beam meets the land (or the fortress), marched on the CPU each frame.
    const reachOf = (h: number, pt: number): number => {
      const d = beamDirection(h, pt);
      const o = [W[0] + d[0] * 20, W[1] + d[1] * 20, W[2] + d[2] * 20];
      let t = 0;
      const stepLen = 14;
      while (t < 3000) {
        t += stepLen * (1 + t / 900);
        const x = o[0]! + d[0] * t;
        const y = o[1]! + d[1] * t;
        const zz = o[2]! + d[2] * t;
        const sc = p.site.scale;
        const rs = Math.hypot(x - site[0], zz - site[2]) / sc;
        const fortress = rs < 140 ? site[1] + 96 * sc : rs < 230 ? site[1] + 40 * sc : -1e9;
        const spire = rs < 40 ? site[1] + 358 * sc : rs < 95 ? site[1] + 300 * sc : -1e9;
        if (y < Math.max(ctx.ground.height(x, zz), fortress, spire)) return t;
      }
      return 3000;
    };

    const dir = new Vector3();
    const q = new Quaternion();
    const fwd = new Vector3(0, 0, -1);
    let out: WardenOutput | null = null;
    let mid = 0;
    let bass = 0;
    let activity = 0.5;
    let spinA = 0;
    let spinB = 0;
    let spinC = 0;
    let lagA = 0;
    let lagB = 0;
    let lastStir = -1e9;
    let clock = 0;
    let stir = 0;
    const tanOpen = Math.tan(p.beamAngle[0] * DEG);
    const tanFocus = Math.tan(p.beamAngle[1] * DEG);

    return {
      object: group,
      update(frame) {
        const dt = Math.min(0.1, frame.dt);
        clock += dt;
        const k = 1 - Math.exp(-dt / 0.9);
        mid += (frame.audio.mid - mid) * k;
        bass += (frame.audio.bass * 0.6 + frame.audio.subBass * 0.4 - bass) * k;
        activity += (Math.min(1, frame.audio.sectionIntensity * 0.75 + frame.audio.overallEnergy * 0.3) - activity) * (1 - Math.exp(-dt / 4));
        out = controller.update(dt, { activity, reducedMotion: ctx.quality.reducedMotion });
        const o = out;
        // Cage: nested lag so the rings swing after one another.
        lagA += (o.heading * 0.55 - lagA) * (1 - Math.exp(-dt * 0.8));
        lagB += (o.pitch * 0.5 - lagB) * (1 - Math.exp(-dt * 1.5));
        const turn = ctx.quality.reducedMotion ? 0.5 : 1;
        const stirK = 1 + bass * 0.25 + o.awaken * 1.5;
        spinA += dt * 0.035 * stirK * turn;
        spinB += dt * -0.05 * stirK * turn;
        spinC += dt * 0.08 * stirK * turn;
        ringAHolder.rotation.set(0, -lagA + spinA, 0);
        yawG.rotation.set(0, -o.heading, 0);
        ringBHolder.rotation.set(lagB + Math.sin(spinB) * 0.35, 0, spinB * 0.6);
        pitchG.rotation.set(o.pitch, 0, 0);
        ringCHolder.rotation.set(0, 0, spinC);
        for (const sh of shutters) sh.obj.position.copy(sh.base).addScaledVector(sh.inward, Math.max(0, o.aperture) * 3.4);

        // Publish the beam.
        const d = beamDirection(o.heading, o.pitch);
        dir.set(d[0], d[1], d[2]);
        const tanA = (tanOpen + (tanFocus - tanOpen) * Math.max(0, Math.min(1, o.aperture))) * (1 + Math.max(0, -o.aperture) * 0.6);
        const reach = reachOf(o.heading, o.pitch);
        bu.beamDir.value.copy(dir);
        bu.beamOrigin.value.set(W[0] + d[0] * 20, W[1] + d[1] * 20, W[2] + d[2] * 20);
        bu.beamTan.value = tanA;
        bu.beamReach.value = reach;
        // Focusing pours the same light into a narrower cone: brighter per area.
        const focusGain = (tanOpen / tanA) ** 0.9;
        // Dimmer as it turns towards the viewer (it never points at them; this keeps it gentle near the limit).
        const sep = Math.acos(Math.max(-1, Math.min(1, dir.dot(toEye)))) / DEG;
        const towards = 0.55 + 0.45 * Math.min(1, Math.max(0, (sep - p.separation) / 14));
        bu.beamPower.value = o.intensity * (0.95 + mid * 0.1) * focusGain * towards * presence.value;
        bu.coreGlow.value = o.intensity * (0.94 + mid * 0.14);
        bu.awaken.value = o.awaken;
        stir += (Math.min(1, bass * 0.8 + o.awaken) - stir) * (1 - Math.exp(-dt * 2));
        u.glow.value = bu.coreGlow.value * (1 + o.focus * 0.25);
        u.focus.value = o.focus;
        u.stir.value = stir;
        // Lava heat: a big moment (QUAD, awakening) brightens it, then it settles.
        const since = clock - s.events.volcano;
        const volcano = since < 0 ? 0 : since < 1.2 ? since / 1.2 : Math.exp(-(since - 1.2) / 5);
        bu.lavaHeat.value = 1 + volcano * 0.45 + o.awaken * 0.35;
        // The Warden's own sound: a low hum while it scans, a rising tone as it focuses, a deeper
        // swell when it wakes (the host's world drone; silent where unsupported).
        const pan = Math.max(-1, Math.min(1, Math.sin(Math.atan2(W[0] - EYE[0], -(W[2] - EYE[2]))) * 1.1));
        const vis = presence.value;
        ctx.sounds.drone?.('warden-hum', (0.42 + (o.intensity - 1) * 0.25 + Math.min(1, o.speed * 1.5) * 0.12) * vis, 49 * (1 + o.focus * 0.42 + mid * 0.03), 0.22 + o.focus * 0.35 + o.awaken * 0.2, pan);
        if (o.awaken > 0.01 || o.state === 'awaken') ctx.sounds.drone?.('warden-swell', o.awaken * 0.85 * vis, 32.7 * (1 - o.awaken * 0.06), 0.35 + o.awaken * 0.25, pan * 0.8);
        s.state.heading = o.heading;
        s.state.pitch = o.pitch;
        s.state.intensity = o.intensity;
        s.state.awaken = o.awaken;
        s.state.focus = o.focus;

        // Beam mesh: apex at the collar's mouth, long enough to reach the land, wide enough for its soft edge.
        beamMesh.position.copy(bu.beamOrigin.value);
        q.setFromUnitVectors(fwd, dir);
        beamMesh.quaternion.copy(q);
        const rMax = reach * tanA * 2.6 + 10;
        beamMesh.scale.set(rMax, rMax, reach * 1.06);
        beamMesh.visible = presence.value > 0.01;
      },
      onGameEvent(event: StageGameEvent) {
        if (event.kind !== 'clear') return;
        if (event.lines >= 4 || event.perfectClear) {
          s.events.volcano = clock;
          // Only rarely does a big clear stir the Warden itself.
          if (clock - lastStir > p.stir.cooldown && Math.random() < p.stir.chance) {
            lastStir = clock;
            controller.awaken(event.perfectClear ? 1 : 0.6);
          }
        }
      },
      setPresence(v) {
        presence.value = v;
      },
      dispose() {
        s.wake = null;
        for (const d of disposables) d.dispose();
        ctx.assets.release(p.src);
        release(ctx, s);
      },
    };
  },
};

