import { DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, NormalBlending, PlaneGeometry } from 'three/webgpu';
import { Fn, abs, exp, float, instancedBufferAttribute, length, mix, mrt, positionGeometry, positionWorld, smoothstep, varyingProperty, vec3, vec4 } from 'three/tsl';
import { hazeDepth, revealMask, type F, type Haze, type V2, type V3, type V4 } from './shared';

/**
 * Soft ground shadows for walking machines, as instanced decals that darken whatever ground is
 * under them: an ambient-occlusion pool under the body, a contact shadow under each foot (fading as
 * the foot lifts), and the shadow cast away from the nearest bright fire or explosion. The yard is
 * lit by the sky and the fires, not the low sun (see ground.ts), so those are the shadows it has.
 *
 * Per decal: centre, strength, the "along" axis scaled by its half-length, half-width and shape
 * (0 = elliptical pool, 1 = streak that starts at the -along end and fades out towards +along).
 * Faded by the stage haze like any other surface; hidden by the crossfade reveal with the world.
 */
export class GroundShadows {
  readonly mesh: Mesh;
  readonly capacity: number;
  private readonly a: InstancedBufferAttribute;
  private readonly b: InstancedBufferAttribute;
  private used = 0;

  constructor(capacity: number, haze: Haze, presence: F) {
    this.capacity = capacity;
    this.a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.b = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.a.setUsage(DynamicDrawUsage);
    this.b.setUsage(DynamicDrawUsage);
    const ia = instancedBufferAttribute<'vec4'>(this.a, 'vec4') as unknown as V4;
    const ib = instancedBufferAttribute<'vec4'>(this.b, 'vec4') as unknown as V4;
    const vQ = varyingProperty('vec2', 'vShadowQ') as unknown as V2;
    const vShape = varyingProperty('float', 'vShadowShape') as unknown as F;
    const vStrength = varyingProperty('float', 'vShadowStrength') as unknown as F;
    const m = new MeshBasicNodeMaterial();
    // The quad spans -1..1 in both directions: q.x along the decal's axis, q.y across it.
    const q = positionGeometry.xy as unknown as V2;
    const along = vec3(ib.x, 0, ib.y);
    const across = vec3(ib.y, 0, ib.x.negate()).div(length(ib.xy).max(1e-4)).mul(ib.z);
    m.positionNode = Fn(() => {
      vQ.assign(q);
      vShape.assign(ib.w);
      vStrength.assign(ia.w);
      return ia.xyz.add(along.mul(q.x)).add(across.mul(q.y));
    })();
    const r = length(vQ);
    const pool = exp(r.mul(r).mul(-3.2)).mul(smoothstep(1, 0.8, r));
    const streak = exp(vQ.y.mul(vQ.y).mul(-3.5))
      .mul(smoothstep(-1, -0.8, vQ.x))
      .mul(float(1).sub(smoothstep(-0.7, 1, vQ.x)))
      .mul(smoothstep(1, 0.85, abs(vQ.y)));
    // The mesh sits at the origin, so the world position is the decal's own.
    const keep = exp(hazeDepth(positionWorld as unknown as V3, haze).negate());
    const alpha = mix(pool, streak, vShape).mul(vStrength).mul(keep).mul(revealMask(presence)).clamp(0, 0.95);
    m.colorNode = vec4(0, 0, 0, alpha);
    m.mrtNode = mrt({ emissive: vec4(0, 0, 0, alpha) });
    m.transparent = true;
    m.blending = NormalBlending;
    m.depthWrite = false;
    m.side = DoubleSide;
    m.fog = false;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -4;
    const geo = new PlaneGeometry(2, 2);
    this.mesh = new Mesh(geo, m);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Over the ground, under the smoke and the glints.
    this.mesh.renderOrder = 1;
    // Read-only handle for review tools: the decals of the last frame.
    this.mesh.userData.groundShadows = () => ({ used: this.used, a: this.a.array, b: this.b.array });
  }

  begin(): void {
    this.used = 0;
  }

  /**
   * Adds a decal at ground height `y`: `ax, az` is the (unit) along axis, `len` and `wid` the half
   * length and half width (m), `shape` 0 for a pool, 1 for a streak.
   */
  add(x: number, y: number, z: number, ax: number, az: number, len: number, wid: number, strength: number, shape = 0): void {
    if (this.used >= this.capacity || strength <= 0.003) return;
    const i = this.used++;
    this.a.setXYZW(i, x, y, z, strength);
    this.b.setXYZW(i, ax * len, az * len, wid, shape);
  }

  end(): void {
    this.mesh.count = this.used;
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
