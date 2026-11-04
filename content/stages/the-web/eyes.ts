import { AdditiveBlending, DynamicDrawUsage, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { Fn, cameraProjectionMatrix, cameraViewMatrix, exp, instancedBufferAttribute, length, max, mrt, positionGeometry, screenSize, smoothstep, uv, varyingProperty, vec4 } from 'three/tsl';
import { fogDepth, revealMask, type F, type V3, type V4, type WebWorld } from './shared';

/**
 * Spider eyes as tiny lit points: depth-tested (rocks and walls hide them), never smaller than a
 * fraction of a pixel so a cluster stays readable in the dark, faded by the fog more gently than
 * surfaces (eyeshine carries), and only a hint of bloom. Each point is one eye of a cluster laid
 * out like a real spider's: a large anterior median pair, smaller laterals and a posterior row.
 */
export class EyeField {
  readonly mesh: Mesh;
  private readonly a: InstancedBufferAttribute;
  private readonly b: InstancedBufferAttribute;
  private used = 0;
  readonly capacity: number;

  constructor(capacity: number, w: WebWorld, presence: F, minPixels = 1.9, bloom = 0.16) {
    this.capacity = capacity;
    this.a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.b = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.a.setUsage(DynamicDrawUsage);
    this.b.setUsage(DynamicDrawUsage);
    const ia = instancedBufferAttribute<'vec4'>(this.a, 'vec4') as unknown as V4;
    const ib = instancedBufferAttribute<'vec4'>(this.b, 'vec4') as unknown as V4;
    const vColor = varyingProperty('vec3', 'vEyeColor') as unknown as V3;
    const m = new MeshBasicNodeMaterial();
    m.vertexNode = Fn(() => {
      const centre = ia.xyz;
      const view = cameraViewMatrix.mul(vec4(centre, 1));
      const dist = view.z.negate().max(0.1);
      const p11 = (cameraProjectionMatrix as unknown as { element(i: number): { y: F } }).element(1).y;
      const pxWorld = dist.mul(2).div(p11).div(screenSize.y);
      const r = max(ia.w, pxWorld.mul(minPixels * 0.5));
      // A sub-pixel eye keeps its light: dimmer as its sprite grows past the eye itself.
      const cover = ia.w.div(r).pow(2).mul(0.65).add(0.35);
      const keep = exp(fogDepth(w, centre as unknown as V3).mul(-0.4));
      vColor.assign(ib.rgb.mul(cover).mul(keep));
      // Slightly towards the camera so the eye is not buried in its own socket.
      return cameraProjectionMatrix.mul(vec4(view.xy.add(positionGeometry.xy.mul(r.mul(2))), view.z.add(r.mul(0.6)), 1));
    })();
    const d = length(uv().sub(0.5)).mul(2);
    const core = exp(d.mul(d).mul(-7));
    const col = vColor.mul(core).mul(smoothstep(1, 0.75, d)).mul(revealMask(presence, 900));
    m.colorNode = vec4(col, 1);
    m.blending = AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    m.mrtNode = mrt({ emissive: vec4(col.mul(bloom), 1) });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), m);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  begin(): void {
    this.used = 0;
  }

  add(x: number, y: number, z: number, radius: number, r: number, g: number, b: number): void {
    if (this.used >= this.capacity || r + g + b < 1e-4) return;
    const i = this.used++;
    this.a.setXYZW(i, x, y, z, radius);
    this.b.setXYZW(i, r, g, b, 0);
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

/**
 * Eye layout in units of the carapace width: [right, up, forward, size]. Two rows of four: the
 * large anterior medians in front, the anterior laterals beside them a little lower and back, the
 * posterior row behind and above.
 */
export const EIGHT_EYES: [number, number, number, number][] = [
  [-0.13, 0, 0, 1],
  [0.13, 0, 0, 1],
  [-0.33, -0.05, -0.07, 0.62],
  [0.33, -0.05, -0.07, 0.62],
  [-0.12, 0.16, -0.2, 0.55],
  [0.12, 0.16, -0.2, 0.55],
  [-0.38, 0.1, -0.24, 0.5],
  [0.38, 0.1, -0.24, 0.5],
];
