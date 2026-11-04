import { AdditiveBlending, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector4, type Node } from 'three/webgpu';
import { Fn, abs, cameraPosition, cameraProjectionMatrix, cross, exp, float, instancedBufferAttribute, int, length, max, mix, mrt, normalize, positionGeometry, screenSize, smoothstep, step, uniformArray, varyingProperty, vec3, vec4 } from 'three/tsl';
import { z, type ComponentFactory } from '@prismfall/sdk';
import { buildChannel } from './bolt';
import { FLASH_COLOR, HAZE_DENSITY, cast, releaseStorm, storm, tickStorm, type ActiveStrike, type F, type V3, type V4 } from './shared';

const schema = z.object({
  /** Strikes drawn at once and the segment budget of each. */
  slots: z.number().int().min(1).max(6).default(4),
  segments: z.number().int().min(64).max(1600).default(1000),
  /** Core and halo widths in pixels at full brightness. */
  core: z.number().positive().default(1.0),
  halo: z.number().positive().default(5.5),
  brightness: z.number().positive().default(1),
});

type Params = z.infer<typeof schema>;

/**
 * The lightning itself: every strike's own branching channel (bolt.ts), drawn as thin camera-facing
 * ribbons with a white-hot core in a blue-violet halo, a few pixels wide however far away, dimmed
 * and softened by the rain haze with distance. The dim stepped leader grows down from the cloud for
 * a few tens of milliseconds, then each return stroke lights the whole channel; later strokes follow
 * the main channel while most branches stay dark. Brightness follows the shared storm's comfort-
 * scaled flash envelope, so flash reduction and the comfort settings hold the bolts back too.
 */
export const lightningComponent: ComponentFactory<Params> = {
  type: 'stormLightning',
  version: 1,
  description: 'Dark Storm: procedural branching lightning channels with leaders, return strokes and afterglow.',
  schema,
  create(ctx, p) {
    const s = storm(ctx);
    const detail = ctx.quality.detail;
    const segs = Math.round(p.segments * (detail === 'low' ? 0.5 : detail === 'medium' ? 0.75 : 1));
    const SLOTS = p.slots;
    const total = SLOTS * segs;
    const aBuf = new Float32Array(total * 4);
    const bBuf = new Float32Array(total * 4);
    const cBuf = new Float32Array(total * 4);
    const attrA = new InstancedBufferAttribute(aBuf, 4);
    const attrB = new InstancedBufferAttribute(bBuf, 4);
    const attrC = new InstancedBufferAttribute(cBuf, 4);
    for (const a of [attrA, attrB, attrC]) a.setUsage(DynamicDrawUsage);
    const plane = new PlaneGeometry(1, 2);
    const geo = new InstancedBufferGeometry();
    geo.index = plane.index;
    geo.setAttribute('position', plane.getAttribute('position'));
    geo.setAttribute('segA', attrA);
    geo.setAttribute('segB', attrB);
    geo.setAttribute('segC', attrC);
    geo.instanceCount = total;
    // Per slot: brightness, leader reach (0..1 along the channel), branch visibility, unused.
    const slotValues = Array.from({ length: SLOTS }, () => new Vector4(0, 0, 0, 0));
    const slotU = uniformArray(slotValues, 'vec4');
    const A = cast<V4>(instancedBufferAttribute(attrA, 'vec4'));
    const B = cast<V4>(instancedBufferAttribute(attrB, 'vec4'));
    const C = cast<V4>(instancedBufferAttribute(attrC, 'vec4'));
    const vX = varyingProperty('float', 'vBoltX');
    const vHalf = varyingProperty('float', 'vBoltHalfPx');
    const vLight = varyingProperty('float', 'vBoltLight');
    const vHaze = varyingProperty('float', 'vBoltHaze');
    const pixelAt = (dist: F): F => {
      // Projection [1][1] = 1 / tan(fov / 2): world size of one pixel at this distance.
      const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
      return cast<F>(dist.mul(2).div(p11.mul(screenSize.y)));
    };
    const material = new MeshBasicNodeMaterial();
    material.positionNode = Fn(() => {
      const slot = C.y;
      const state = cast<V4>(slotU.element(int(slot)));
      const order = C.x;
      const level = C.z;
      const end = positionGeometry.y.mul(0.5).add(0.5);
      const side = positionGeometry.x.mul(2);
      // The leader reveals the channel from the cloud down; branches mostly light on the first stroke.
      const reached = smoothstep(state.y.sub(0.04), state.y, order).oneMinus();
      const branchVis = mix(float(1), state.z, step(0.5, level));
      const light = state.x.mul(B.w).mul(reached).mul(branchVis);
      const P = cast<V3>(mix(A.xyz, B.xyz, end));
      const dir = cast<V3>(normalize(B.xyz.sub(A.xyz)));
      const toCam = cast<V3>(cameraPosition.sub(P));
      const dist = length(toCam);
      const pixel = pixelAt(dist);
      // Wider glare for brighter, nearer channels; never thinner than a pixel and a half.
      const halfPx = float(p.halo).mul(light.min(1.6).mul(0.7).add(0.3)).mul(A.w.mul(0.6).add(0.4));
      const worldHalf = A.w.mul(0.12);
      const half = max(pixel.mul(halfPx), worldHalf.mul(halfPx.div(p.core)));
      const on = step(0.002, light);
      const across = normalize(cross(dir, toCam));
      vX.assign(side);
      vHalf.assign(halfPx);
      vLight.assign(light);
      vHaze.assign(exp(dist.mul(HAZE_DENSITY * 0.75).negate()));
      // Ends overlap by half a width so the joints between segments never show gaps.
      return P.add(across.mul(side.mul(half).mul(on))).add(dir.mul(end.sub(0.5).mul(2).mul(half).mul(on)));
    })();
    const x = cast<F>(abs(cast<F>(vX)).mul(cast<F>(vHalf)));
    const corePx = float(p.core);
    const core = exp(x.div(corePx).pow(2).negate());
    const halo = exp(x.div(cast<F>(vHalf).mul(0.42)).pow(2).negate());
    const lightV = cast<F>(vLight);
    const colour = cast<V3>(
      vec3(1, 1, 1)
        .mul(core.mul(7))
        .add(vec3(...FLASH_COLOR).mul(vec3(0.8, 0.88, 1.1)).mul(halo.mul(0.55)))
        .mul(lightV.mul(p.brightness))
        .mul(cast<F>(vHaze))
        .mul(s.u.presence),
    );
    material.colorNode = vec4(colour, 1);
    material.mrtNode = mrt({ emissive: vec4(colour.mul(0.22).mul(ctx.uniforms.flashLimit), 1) });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.fog = false;
    const mesh = new Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;

    // Read-only handle for review tools and captures (scene.traverse finds it): the director, the
    // strike log, and a way to force a strike for a screenshot.
    mesh.userData.storm = { director: s.director, log: s.log, active: s.active, force: (level: 1 | 2 | 3 | 4, azimuth?: number, distance?: number) => s.director.force(level, azimuth, distance) };
    const owners: (ActiveStrike | null)[] = Array.from({ length: SLOTS }, () => null);
    const write = (slot: number, a: ActiveStrike): void => {
      const channel = buildChannel({ kind: a.strike.kind, top: [a.top.x, a.top.y, a.top.z], bottom: [a.bottom.x, a.bottom.y, a.bottom.z], seed: a.strike.seed, detail: detail === 'low' ? 0.3 : detail === 'medium' ? 0.6 : 1, maxSegments: segs });
      const base = slot * segs;
      // Channel widths scale with the strike: near ones are thicker in the world.
      const thick = 0.6 + a.strike.energy * 1.6;
      for (let i = 0; i < segs; i++) {
        const o = (base + i) * 4;
        const sg = channel.segments[i];
        if (!sg) {
          aBuf.fill(0, o, o + 4);
          bBuf.fill(0, o, o + 4);
          cBuf.set([2, slot, 0, 0], o);
          continue;
        }
        aBuf.set([sg.a[0], sg.a[1], sg.a[2], sg.width * thick], o);
        bBuf.set([sg.b[0], sg.b[1], sg.b[2], sg.glow], o);
        cBuf.set([sg.order, slot, sg.level, sg.branch], o);
      }
      attrA.needsUpdate = true;
      attrB.needsUpdate = true;
      attrC.needsUpdate = true;
    };
    const listener = (a: ActiveStrike): void => {
      if (a.strike.kind === 'intracloud') return;
      // Reuse a free slot, or the dimmest one.
      let slot = owners.findIndex((o) => o === null || !s.active.includes(o));
      if (slot < 0) {
        let dim = Infinity;
        owners.forEach((o, i) => {
          if (o && o.level < dim) {
            dim = o.level;
            slot = i;
          }
        });
      }
      if (slot < 0) return;
      const prev = owners[slot];
      if (prev) prev.slot = -1;
      owners[slot] = a;
      a.slot = slot;
      write(slot, a);
    };
    s.onStrike.add(listener);

    return {
      object: mesh,
      update(frame) {
        tickStorm(s, ctx, frame);
        for (let i = 0; i < SLOTS; i++) {
          const a = owners[i];
          const v = slotValues[i]!;
          if (!a || a.slot !== i || !s.active.includes(a)) {
            owners[i] = null;
            v.set(0, 0, 0, 0);
            continue;
          }
          const t = frame.time - a.start;
          // The leader: in the 60 ms before the first stroke it grows down the channel, dimly.
          const leader = a.reduced ? 1 : Math.min(1, Math.max(0, (t + 0.06) / 0.06));
          let stroke = 0;
          for (let k = 1; k < a.strike.strokes.length; k++) if (t >= a.strike.strokes[k]!) stroke = k;
          const branches = stroke === 0 ? 1 : 0.16;
          v.set(Math.max(a.level, t < 0 && !a.reduced ? 0.12 * a.peak : 0), t < 0 ? leader : 1.05, branches, 0);
        }
      },
      onGameEvent(e) {
        // The storm answers big clears: a QUAD calls down a strike (its thunder follows), a double
        // or triple a flicker in the clouds. Hard drops never call lightning.
        if (e.kind !== 'clear') return;
        if (e.lines >= 4 || e.perfectClear) s.director.accent();
        else if (e.lines >= 2) s.director.flicker();
      },
      setPresence() {
        // Brightness already follows the storm's presence.
      },
      dispose() {
        s.onStrike.delete(listener);
        geo.dispose();
        plane.dispose();
        material.dispose();
        releaseStorm(ctx, s);
      },
    };
  },
};
