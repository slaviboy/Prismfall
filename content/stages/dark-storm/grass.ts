import { BufferAttribute, BufferGeometry, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh } from 'three/webgpu';
import { Fn, attribute, cameraPosition, cameraViewMatrix, cos, float, instancedBufferAttribute, length, mix, normalize, output, positionWorld, sin, smoothstep, vec3, vec4 } from 'three/tsl';
import { noBloom, z, type ComponentFactory } from '@prismfall/sdk';
import { EYE, boardLimit, ledgeMask, pointAt, puddle, rockiness, streamDistance, terrainHeight } from './terrain';
import { StormMaterial, castFlashShadows, cast, haze, releaseStorm, rng, storm, tickStorm, type F, type V3, type V4 } from './shared';
import { reveal } from './land';

const schema = z.object({
  tufts: z.number().int().min(0).max(30000).default(5200),
  /** Blades per tuft. */
  blades: z.number().int().min(3).max(16).default(9),
  reach: z.number().positive().default(70),
  seed: z.number().int().default(3),
});

type Params = z.infer<typeof schema>;

/**
 * Moor grass and heather in tufts on the ledge around the viewer: thin solid blades (no
 * transparency) bent over by the wind, whipping in the gusts, sodden and dark, lit by the flashes.
 * The bend is computed in the vertex shader from the blade's height, the integrated wind and a
 * per-tuft phase, so nothing moves on the CPU.
 */
export const grassComponent: ComponentFactory<Params> = {
  type: 'stormGrass',
  version: 1,
  description: 'Dark Storm: wind-bent moor grass tufts on the wet ledge.',
  schema,
  create(ctx, p) {
    const s = storm(ctx);
    const u = s.u;
    const rand = rng(p.seed * 104729 + 7);
    const k = ctx.quality.detail === 'low' ? 0.35 : ctx.quality.detail === 'medium' ? 0.6 : ctx.quality.detail === 'high' ? 0.85 : 1;
    const want = Math.round(p.tufts * k);
    // One tuft: blades fanning out from its foot, each a tapered strip of two triangles.
    const pos: number[] = [];
    const tip: number[] = [];
    for (let b = 0; b < p.blades; b++) {
      const a = (b / p.blades) * Math.PI * 2 + rand() * 0.6;
      const lean = 0.15 + rand() * 0.35;
      const h = 0.28 + rand() * 0.32;
      const w = 0.014 + rand() * 0.01;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const px = -dz * w;
      const pz = dx * w;
      const top = [dx * lean * h, h, dz * lean * h];
      const mid = [dx * lean * h * 0.35, h * 0.5, dz * lean * h * 0.35];
      // Base pair, middle pair, tip.
      const verts = [
        [-px, 0, -pz, 0],
        [px, 0, pz, 0],
        [mid[0]! - px * 0.6, mid[1]!, mid[2]! - pz * 0.6, 0.5],
        [mid[0]! + px * 0.6, mid[1]!, mid[2]! + pz * 0.6, 0.5],
        [top[0]!, top[1]!, top[2]!, 1],
      ];
      for (const tri of [
        [0, 1, 2],
        [1, 3, 2],
        [2, 3, 4],
      ]) {
        for (const i of tri) {
          const v = verts[i]!;
          pos.push(v[0]!, v[1]!, v[2]!);
          tip.push(v[3]!);
        }
      }
    }
    const blade = new BufferGeometry();
    blade.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    blade.setAttribute('along', new BufferAttribute(new Float32Array(tip), 1));
    // Tufts on the ledge, denser near the viewer, never in puddles, the stream or on bare slabs.
    const inst: number[] = [];
    for (let tries = 0; inst.length / 4 < want && tries < want * 8; tries++) {
      const az = -180 + rand() * 360;
      const d = 2.5 + Math.pow(rand(), 1.7) * p.reach;
      const at = pointAt(az, d);
      if (ledgeMask(at.x, at.z) < 0.97 || puddle(at.x, at.z) > 0.2 || streamDistance(at.x, at.z) < 1.4 || rockiness(at.x, at.z) > 0.35) continue;
      const y = terrainHeight(at.x, at.z);
      if (boardLimit(at.x, at.z) < y + 1) continue;
      inst.push(at.x, y - 0.03, at.z, 0.6 + rand() * 0.9);
    }
    const count = inst.length / 4;
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', blade.getAttribute('position'));
    geo.setAttribute('along', blade.getAttribute('along'));
    const ia = new InstancedBufferAttribute(new Float32Array(inst), 4);
    geo.setAttribute('tuft', ia);
    geo.instanceCount = count;
    const T = cast<V4>(instancedBufferAttribute(ia, 'vec4'));
    const along = cast<F>(attribute('along', 'float'));
    const m = new StormMaterial();
    m.lightsNode = s.lightsNode;
    m.fog = false;
    m.side = DoubleSide;
    const local = cast<V3>(attribute('position', 'vec3'));
    m.positionNode = Fn(() => {
      const scale = T.w;
      const base = cast<V3>(T.xyz);
      const phase = base.x.mul(0.37).add(base.z.mul(0.29));
      // Bend downwind with the wind's strength, flutter faster in the gusts.
      const wind = u.wind;
      const speed = length(wind.xz);
      const dir = cast<V3>(normalize(vec3(wind.x, 0, wind.z).add(vec3(0.0001, 0, 0))));
      const sway = sin(u.time.mul(float(2.2).add(u.gust.mul(3))).add(phase)).mul(0.25).add(sin(u.time.mul(5.3).add(phase.mul(2.1))).mul(0.12)).add(1);
      const bend = speed.mul(0.035).mul(sway).mul(along.mul(along)).mul(scale);
      const bent = cast<V3>(local.mul(scale).add(dir.mul(bend.mul(0.6))).sub(vec3(0, bend.mul(0.25), 0)));
      return base.add(bent);
    })();
    const shade = cast<F>(cos(T.x.mul(1.7).add(T.z.mul(2.3))).mul(0.5).add(0.5));
    // Sodden grass and heather: dark olive, rust-brown tips.
    const col = cast<V3>(mix(mix(vec3(0.03, 0.034, 0.02), vec3(0.042, 0.034, 0.026), shade), vec3(0.06, 0.045, 0.03), along.mul(0.6)));
    m.colorNode = vec4(col, 1);
    m.roughnessNode = float(0.82);
    m.metalness = 0;
    // Blades face mostly up, tilted towards the viewer a little so they read as a soft mass.
    const toEye = cast<V3>(normalize(cameraPosition.sub(cast<V3>(positionWorld))));
    m.normalNode = cast<V3>(normalize(cameraViewMatrix.mul(vec4(normalize(vec3(toEye.x.mul(0.35), 1, toEye.z.mul(0.35))), 0)).xyz));
    const world = cast<V3>(positionWorld);
    m.outputNode = Fn(() => vec4(haze(s, cast<V3>(output.rgb), world), 1))();
    m.opacityNode = reveal(u.presence);
    m.alphaTest = 0.5;
    noBloom(m);
    const mesh = new Mesh(geo, m);
    mesh.frustumCulled = false;
    castFlashShadows(mesh, false);
    void smoothstep;
    void cameraPosition;
    void EYE;
    return {
      object: mesh,
      update(frame) {
        tickStorm(s, ctx, frame);
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        blade.dispose();
        geo.dispose();
        m.dispose();
        releaseStorm(ctx, s);
      },
    };
  },
};
