import { BufferAttribute, BufferGeometry, DoubleSide, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, Vector2 } from 'three/webgpu';
import { Fn, abs, atan, attribute, cameraPosition, cos, dot, exp, float, instancedBufferAttribute, mix, mrt, normalGeometry, normalize, positionGeometry, pow, select, sin, smoothstep, step, uniform, varyingProperty, vec3, vec4 } from 'three/tsl';
import { floatUniform, seeded, z, zVec3, type ComponentFactory } from '@prismfall/sdk';
import { backdropSampler, backdropTexture, fogDepth, frontCrossing, lampLight, release, revealMask, shared, zBackdrop, zFog, type F, type V3 } from './shared';

const groupSchema = z.object({
  /** Centre of the circling (world). */
  center: zVec3,
  radius: z.number().positive().default(9),
  count: z.number().int().min(1).max(40).default(12),
  /** Flight speed (m/s); negative circles clockwise. */
  speed: z.number().default(6),
});

const schema = z.object({
  groups: z.array(groupSchema).min(1).max(4),
  ground: z.number().default(-1.05),
  /** Seconds between unprovoked startles (range); big clears and level-ups startle them too. */
  restless: z.tuple([z.number().positive(), z.number().positive()]).default([45, 95]),
  backdrop: zBackdrop,
  fog: zFog,
  seed: z.number().default(9),
});

type Params = z.infer<typeof schema>;

/**
 * One crow, 0.45 m long with a 0.95 m span, facing +z. `crow` = (side, span 0..1, part, 0):
 * part 0 body and tail, 1 inner wing, 2 hand and primaries (the separated "fingers" of a crow's wing).
 */
function crowGeometry(): BufferGeometry {
  const pos: number[] = [];
  const crow: number[] = [];
  const idx: number[] = [];
  const v = (x: number, y: number, zz: number, side: number, span: number, part: number) => {
    pos.push(x, y, zz);
    crow.push(side, span, part, 0);
    return pos.length / 3 - 1;
  };
  // Body: lofted ellipses along z (tail base .. beak tip).
  const rings: [number, number, number, number][] = [
    // z, half width, half height, centre y
    [-0.13, 0.018, 0.014, 0.0],
    [-0.08, 0.04, 0.04, 0.0],
    [-0.01, 0.052, 0.05, 0.002],
    [0.06, 0.044, 0.046, 0.006],
    [0.1, 0.03, 0.032, 0.012],
    [0.13, 0.031, 0.032, 0.016],
    [0.165, 0.027, 0.028, 0.017],
    [0.19, 0.012, 0.011, 0.012],
    [0.235, 0.002, 0.002, 0.008],
  ];
  const seg = 10;
  const rows: number[][] = [];
  for (const [zz, w, h, cy] of rings) {
    const row: number[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      row.push(v(Math.cos(a) * w, cy + Math.sin(a) * h, zz, 0, 0, 0));
    }
    rows.push(row);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = rows[i]![j]!;
      const b = rows[i]![(j + 1) % seg]!;
      const c = rows[i + 1]![(j + 1) % seg]!;
      const d = rows[i + 1]![j]!;
      idx.push(a, b, c, a, c, d);
    }
  }
  // Tail: a rounded wedge fan, slightly spread.
  const tb = v(0, 0.004, -0.11, 0, 0, 0);
  const tail: number[] = [];
  for (let k = 0; k <= 6; k++) {
    const f = k / 6 - 0.5;
    tail.push(v(f * 0.11, -0.004 + Math.abs(f) * 0.01, -0.3 + Math.abs(f) * 0.03, 0, 0, 0));
  }
  for (let k = 0; k < 6; k++) idx.push(tb, tail[k]!, tail[k + 1]!);
  // Wings: inner wing (shoulder to wrist), hand, and five primaries splayed at the tip.
  for (const side of [1, -1]) {
    const x = (val: number) => val * side;
    const s0 = v(x(0.03), 0.02, 0.05, side, 0, 1);
    const s1 = v(x(0.03), 0.015, -0.08, side, 0, 1);
    const w0 = v(x(0.22), 0.02, 0.07, side, 0.45, 1);
    const w1 = v(x(0.22), 0.015, -0.1, side, 0.45, 1);
    idx.push(s0, w0, w1, s0, w1, s1);
    const h0 = v(x(0.22), 0.02, 0.07, side, 0.45, 2);
    const h1 = v(x(0.22), 0.015, -0.1, side, 0.45, 2);
    const m0 = v(x(0.32), 0.02, 0.055, side, 0.68, 2);
    const m1 = v(x(0.31), 0.015, -0.09, side, 0.68, 2);
    idx.push(h0, m0, m1, h0, m1, h1);
    // Primaries: narrow feathers fanning backwards from the hand's leading edge.
    for (let f = 0; f < 5; f++) {
      const a = 0.12 + f * 0.17;
      const len = 0.17 - f * 0.012;
      const bx = 0.31 - f * 0.002;
      const bz = 0.045 - f * 0.03;
      const tipX = bx + Math.cos(a) * len;
      const tipZ = bz - Math.sin(a) * len;
      const wdt = 0.017;
      const p0 = v(x(bx), 0.02, bz + wdt, side, 0.68, 2);
      const p1 = v(x(bx), 0.02, bz - wdt, side, 0.68, 2);
      const p2 = v(x(tipX), 0.02, tipZ - wdt * 0.4, side, 1, 2);
      const p3 = v(x(tipX + 0.008), 0.02, tipZ + wdt * 0.5, side, 1, 2);
      idx.push(p0, p3, p2, p0, p2, p1);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('crow', new BufferAttribute(new Float32Array(crow), 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Crows circling over the tree line, black against the glowing fog: rowing wingbeats broken by
 * glides, banked into the turn. Now and then something startles them (big clears, level-ups, a dying
 * lamp, or nothing at all): they burst outward and up, beating hard, then settle back into the circle.
 * Reduced motion keeps them circling calmly.
 */
export const crowsComponent: ComponentFactory<Params> = {
  type: 'deadAcreCrows',
  version: 1,
  description: 'Crows circling over the tree line; startled by big moments, they scatter and settle again.',
  schema,
  async create(ctx, p) {
    const s = shared(ctx);
    const backdropTex = await backdropTexture(ctx, s, p.backdrop.src);
    const scale = ctx.quality.detail === 'low' ? 0.5 : ctx.quality.detail === 'medium' ? 0.75 : 1;
    const rand = seeded(p.seed * 4271 + 3);
    const A: number[] = [];
    const B: number[] = [];
    p.groups.forEach((gr, gi) => {
      const n = Math.max(2, Math.round(gr.count * scale));
      for (let i = 0; i < n; i++) {
        const r = gr.radius * (0.65 + rand() * 0.6);
        // Loosely clumped round the circle.
        const phase = (i / n) * Math.PI * 2 * 0.7 + rand() * 0.9;
        A.push(gr.center[0], gr.center[1] + (rand() - 0.5) * 3, gr.center[2], r);
        B.push(phase, gr.speed / r, rand(), gi);
      }
    });
    const count = A.length / 4;
    const iA = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(A), 4), 'vec4');
    const iB = instancedBufferAttribute<'vec4'>(new InstancedBufferAttribute(new Float32Array(B), 4), 'vec4');
    const geometry = crowGeometry();
    const u = { presence: floatUniform(1), dusk: floatUniform(0) };
    const startleAt = uniform(new Vector2(-1e4, -1e4));
    const clock = floatUniform(0);
    const t = clock as unknown as F;
    const backdrop = backdropSampler(backdropTex, p.backdrop, u.dusk as unknown as F);
    const cr = attribute<'vec4'>('crow', 'vec4');
    const vWorld = varyingProperty('vec3', 'vCrowWorld');
    const vNormal = varyingProperty('vec3', 'vCrowNormal');

    const posed = Fn(() => {
      const seed = iB.z;
      const centre = iA.xyz;
      const r = iA.w;
      const omega = iB.y;
      // Startle envelope for this crow's group: up and out fast, then a slow settle.
      const ts = select(iB.w.lessThan(0.5), startleAt.x, startleAt.y);
      const since = t.sub(ts).sub(seed.mul(0.6)).max(0);
      const e = float(1).sub(exp(since.mul(-1.8))).mul(exp(since.mul(-0.16))).mul(step(ts, t));
      const ang = iB.x.add(omega.mul(t)).add(sin(t.mul(0.07).add(seed.mul(20))).mul(0.4));
      const radial = vec3(cos(ang), 0, sin(ang));
      const alt = sin(t.mul(0.3).add(seed.mul(17))).mul(1.4);
      const centreP = centre.add(radial.mul(r.add(e.mul(16).mul(seed.mul(0.6).add(0.7))))).add(vec3(0, alt.add(e.mul(8).mul(seed.mul(0.5).add(0.75))), 0));
      const dirS = omega.sign();
      const vel = normalize(vec3(sin(ang).negate(), 0.0, cos(ang)).mul(dirS).add(radial.mul(e.mul(0.8))).add(vec3(0, e.mul(0.35), 0)));
      // Wingbeat: about 3.5 Hz, faster when startled; glides between bouts.
      const flapRate = float(3.4).add(seed.mul(0.6)).add(e.mul(2.6));
      const ph = t.mul(flapRate).mul(Math.PI * 2).add(seed.mul(40));
      const glide = smoothstep(0.25, 0.7, sin(t.mul(0.45).add(seed.mul(9)))).mul(float(1).sub(e.mul(1.5)).clamp(0, 1));
      const amp = float(0.78).add(e.mul(0.25)).mul(float(1).sub(glide.mul(0.92)));
      const side = cr.x;
      const part = cr.z;
      const wing = step(0.5, part);
      const outer = step(1.5, part);
      const a1 = sin(ph).mul(amp).add(0.07).mul(side).mul(wing);
      const a2 = sin(ph.sub(0.8)).mul(amp.mul(0.55)).add(glide.mul(-0.05)).mul(side).mul(outer);
      const rollZ = (v: V3, a: F): V3 => vec3(v.x.mul(cos(a)).sub(v.y.mul(sin(a))), v.x.mul(sin(a)).add(v.y.mul(cos(a))), v.z) as V3;
      let pos: V3 = positionGeometry as V3;
      let nrm: V3 = normalGeometry as V3;
      const wrist = vec3(side.mul(0.22), 0.02, 0);
      pos = wrist.add(rollZ(pos.sub(wrist) as V3, a2 as F)) as V3;
      nrm = rollZ(nrm, a2 as F);
      const shoulder = vec3(side.mul(0.03), 0.02, 0);
      pos = shoulder.add(rollZ(pos.sub(shoulder) as V3, a1 as F)) as V3;
      nrm = rollZ(nrm, a1 as F);
      // Body bobs against the wingbeat.
      pos = pos.add(vec3(0, sin(ph).mul(-0.015).mul(amp), 0)) as V3;
      // Bank into the turn, then face the flight direction.
      const bank = dirS.mul(-0.38).mul(float(1).sub(e));
      pos = rollZ(pos, bank as F);
      nrm = rollZ(nrm, bank as F);
      const pitchUp = vel.y.mul(-0.8);
      const py = (v: V3): V3 => vec3(v.x, v.y.mul(cos(pitchUp)).sub(v.z.mul(sin(pitchUp))), v.y.mul(sin(pitchUp)).add(v.z.mul(cos(pitchUp)))) as V3;
      pos = py(pos);
      nrm = py(nrm);
      const head = atan(vel.x, vel.z);
      const yawF = (v: V3): V3 => vec3(v.x.mul(cos(head)).add(v.z.mul(sin(head))), v.y, v.z.mul(cos(head)).sub(v.x.mul(sin(head)))) as V3;
      const world = centreP.add(yawF(pos.mul(seed.mul(0.25).add(0.9)) as V3)) as V3;
      vWorld.assign(world);
      vNormal.assign(yawF(nrm));
      return world;
    })();

    const view = normalize(cameraPosition.sub(vWorld));
    const n0 = normalize(vNormal);
    const n = select(dot(n0, view).lessThan(0), n0.negate(), n0);
    const toP = normalize(vWorld.sub(cameraPosition));
    const turn = backdrop.turnOf(toP as V3);
    const behind = backdrop.at(turn, float(4));
    const ndv = abs(dot(n, view));
    // Black plumage with a faint blue-violet gloss at grazing angles.
    const gloss = pow(float(1).sub(ndv), 3).mul(behind).mul(vec3(0.55, 0.6, 0.85)).mul(0.9);
    const albedo = vec3(0.012, 0.012, 0.014);
    const lit = albedo.mul(behind.mul(0.6).add(lampLight(s, vWorld as V3, n as V3, 0.2))).add(gloss);
    const tau = fogDepth(vWorld as V3, p.ground, p.fog, float(1));
    const color = mix(backdrop.dir(toP as V3), lit, exp(tau.negate()));

    const material = new MeshBasicNodeMaterial();
    material.positionNode = posed;
    material.colorNode = vec4(color, 1);
    material.opacityNode = revealMask(u.presence as unknown as F);
    material.alphaTest = 0.5;
    material.side = DoubleSide;
    material.fog = false;
    material.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const mesh = new Mesh(geometry, material);
    mesh.count = count;
    mesh.frustumCulled = false;

    const reduced = ctx.quality.reducedMotion;
    const restless = seeded(p.seed * 31 + 1);
    let nextRestless = p.restless[0] + restless() * (p.restless[1] - p.restless[0]);
    let lastShared = s.startle.at;
    let lastFrame = -1;
    const startle = (side: number) => {
      if (reduced) return;
      const now = clock.value;
      // Groups are ordered left (x < 0) then right; side 0 startles both.
      p.groups.forEach((gr, gi) => {
        const gSide = Math.sign(gr.center[0]);
        if (side !== 0 && gSide !== side) return;
        const v = startleAt.value as Vector2;
        // Don't restart a startle that is still playing.
        const prev = gi === 0 ? v.x : v.y;
        if (now - prev < 12) return;
        if (gi === 0) v.x = now;
        else v.y = now;
      });
    };
    return {
      object: mesh,
      reactive: { dusk: u.dusk },
      update(frame) {
        clock.value += Math.min(0.1, frame.dt) * (reduced ? 0.6 : 1);
        if (clock.value > nextRestless) {
          startle(restless() < 0.5 ? -1 : 1);
          nextRestless = clock.value + p.restless[0] + restless() * (p.restless[1] - p.restless[0]);
        }
        if (s.startle.at !== lastShared) {
          lastShared = s.startle.at;
          startle(s.startle.side);
        }
        // A big clear's front scares each flock as it reaches it (a triple or more), so the burst
        // runs out from the board: the near flock first, the far one a moment later.
        const o = ctx.uniforms.waveOrigin.value;
        if (lastFrame >= 0) {
          for (const gr of p.groups) {
            const k = frontCrossing(ctx, Math.hypot(gr.center[0] - o.x, gr.center[1] - o.y, gr.center[2] - o.z), lastFrame, frame.time);
            if (k >= 0.6) startle(Math.sign(gr.center[0]));
          }
        }
        lastFrame = frame.time;
      },
      onGameEvent(ev) {
        if (ev.kind === 'levelUp') startle(0);
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
        release(ctx, s);
      },
    };
  },
};

