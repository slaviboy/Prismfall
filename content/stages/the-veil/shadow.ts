import type {
  Matrix4,
  Object3D,
  Vector3} from 'three/webgpu';
import {
  Color,
  DoubleSide,
  HalfFloatType,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  Node,
  NodeUpdateType,
  OrthographicCamera,
  RenderTarget,
  SkinnedMesh,
  type BufferGeometry,
  type NodeFrame,
  type Renderer,
  type Scene,
} from 'three/webgpu';
import { float, max, positionView, positionWorld, select, texture, uniform, vec2, vec4 } from 'three/tsl';
import { cast, type F, type V3, type V4 } from './shared';

/**
 * Creature and tree shadows from the moon, for the fog and for surfaces.
 *
 * The casters' real, animated geometry (skinned creatures, instanced swarms, trees) is drawn by
 * proxy meshes that share its geometry, skeleton or instance data but live only on SHADOW_LAYER,
 * from two orthographic cameras along the moonlight (a near cascade for the forest and the walkers,
 * a far one for the giants). Each texel stores coverage and coverage × depth (RG, half float, with
 * mipmaps): a mip level averages coverage and, divided out, the depth of the casters under it, so
 * one fetch gives a soft shadow whose blur can grow with the distance behind the caster. The
 * capture runs once per frame from a node's updateBefore inside the receivers' materials (the
 * pattern three's reflector uses), so the creatures' current pose is what casts.
 */

export const SHADOW_LAYER = 29;
const NEAR = 1;
const FAR = 4200;

/** A node that contributes 0 but renders the shadow maps before the first receiver draws each frame. */
function captureNode(maps: ShadowMaps): Node {
  const node = new Node('float') as unknown as Node & { updateBefore(frame: NodeFrame): boolean; setup(): unknown };
  node.updateBeforeType = NodeUpdateType.FRAME;
  node.updateBefore = (frame: NodeFrame) => {
    if (frame.renderer) maps.capture(frame.renderer as unknown as Renderer);
    return true;
  };
  node.setup = () => float(0);
  return node;
}

const matU = (m: Matrix4) => uniform(m);
type MatUniform = ReturnType<typeof matU>;

interface Cascade {
  readonly camera: OrthographicCamera;
  readonly target: RenderTarget;
  readonly view: MatUniform;
  /** left, right, bottom, top of the ortho frustum (view space). */
  readonly bounds: { l: number; r: number; b: number; t: number };
}

export interface CascadeSpec {
  /** Centre of the covered area and its half sizes across and along the light (metres). */
  readonly centre: Vector3;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly size: number;
}

export class ShadowMaps {
  readonly cascades: Cascade[] = [];
  readonly trigger: Node;
  /** 0 = shadows off (comfort or quality), 1 = full. */
  readonly strength = uniform(1);
  private readonly lightDir: Vector3;
  private scene: Scene | null = null;
  private readonly clear = new Color();
  enabled = true;
  private turn = 0;

  constructor(lightDir: Vector3, specs: CascadeSpec[]) {
    this.lightDir = lightDir.clone().normalize();
    for (const spec of specs) {
      const camera = new OrthographicCamera(-spec.halfWidth, spec.halfWidth, spec.halfHeight, -spec.halfHeight, NEAR, FAR);
      // Look along the light (from the moon towards the scene), up = world up projected.
      const from = spec.centre.clone().addScaledVector(this.lightDir, FAR * 0.5);
      camera.position.copy(from);
      camera.up.set(0, 1, 0);
      camera.lookAt(spec.centre);
      camera.updateMatrixWorld(true);
      camera.layers.set(SHADOW_LAYER);
      const target = new RenderTarget(spec.size, spec.size, { type: HalfFloatType, depthBuffer: true, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter });
      target.texture.generateMipmaps = true;
      target.texture.minFilter = LinearMipmapLinearFilter;
      target.texture.magFilter = LinearFilter;
      this.cascades.push({ camera, target, view: matU(camera.matrixWorldInverse.clone()), bounds: { l: -spec.halfWidth, r: spec.halfWidth, b: -spec.halfHeight, t: spec.halfHeight } });
    }
    this.trigger = captureNode(this);
  }

  attach(scene: Scene): void {
    this.scene = scene;
  }

  /** Renders every caster proxy into the cascades (once per frame). */
  capture(renderer: Renderer): void {
    const scene = this.scene;
    if (!scene || !this.enabled) return;
    // One cascade per frame, in turn: the casters move slowly, and it halves the cost. Never skip a
    // frame entirely: on WebGL 2, frames that alternate between having this nested render and not
    // having it make three rebuild the main pass's render objects and relink a program every frame
    // (measured: 280 ms frames instead of 9 ms).
    const prevTarget = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT();
    const prevAuto = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    scene.background = null;
    scene.overrideMaterial = null;
    try {
      renderer.setMRT(null);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      const c = this.cascades[this.turn++ % this.cascades.length]!;
      renderer.setRenderTarget(c.target);
      renderer.render(scene, c.camera);
    } finally {
      scene.background = prevBackground;
      scene.overrideMaterial = prevOverride;
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(prevMRT);
      renderer.autoClear = prevAuto;
      renderer.setClearColor(this.clear, prevAlpha);
    }
  }

  /**
   * Shadow at a world point: 0 lit, 1 fully shadowed. `blur` is the base mip level; the shadow
   * softens further with the distance behind its caster (`spread` mip levels per 100 m).
   */
  sample(p: V3, blur = 1.2, spread = 1.2, bias = 0.8): F {
    let result: F = cast<F>(float(0));
    let chosen: F = cast<F>(float(0));
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i]!;
      const v = cast<V4>(c.view.mul(vec4(p, 1)));
      const { l, r, b, t } = c.bounds;
      const texel = (r - l) / c.target.width;
      const u = cast<F>(v.x.sub(l).div(r - l));
      const w = cast<F>(float(t).sub(v.y).div(t - b));
      const depth = cast<F>(v.z.negate().sub(NEAR).div(FAR - NEAR));
      const coarse = cast<V4>(texture(c.target.texture, vec2(u, w)).level(float(blur + 2)));
      const casterDepth = cast<F>(coarse.y.div(max(coarse.x, 1e-4)));
      const behind = cast<F>(depth.sub(casterDepth).mul(FAR - NEAR).max(0));
      const lod = cast<F>(float(blur).add(behind.mul(spread / 100)).min(7));
      const fine = cast<V4>(texture(c.target.texture, vec2(u, w)).level(lod));
      const fineDepth = cast<F>(fine.y.div(max(fine.x, 1e-4)));
      // The blur's footprint mixes nearer parts of the caster into the average: bias by its size.
      const footprint = cast<F>(float(2).pow(lod).mul(texel * 2.5).add(bias));
      const occ = cast<F>(fine.x.mul(depth.sub(fineDepth).mul(FAR - NEAR).sub(footprint).div(footprint.mul(1.5).add(2)).clamp(0, 1)));
      const inside = u.greaterThan(0.01).and(u.lessThan(0.99)).and(w.greaterThan(0.01)).and(w.lessThan(0.99));
      // Use the first cascade that contains the point.
      const take = cast<F>(select(chosen.lessThan(0.5).and(inside), float(1), float(0)));
      result = cast<F>(result.add(occ.mul(take)));
      chosen = cast<F>(chosen.add(take));
    }
    return cast<F>(result.clamp(0, 1).mul(this.strength).add(this.trigger as unknown as F));
  }

  /**
   * A cheaper shadow lookup for the fog volume: one blurred fetch per cascade (no contact
   * hardening, which the mist cannot show). Sharper than about `lod` 2 turns the march's sparse
   * samples into visible grain.
   */
  sampleFog(p: V3, lod = 2.3): F {
    let result: F = cast<F>(float(0));
    let chosen: F = cast<F>(float(0));
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i]!;
      const v = cast<V4>(c.view.mul(vec4(p, 1)));
      const { l, r, b, t } = c.bounds;
      const u = cast<F>(v.x.sub(l).div(r - l));
      const w = cast<F>(float(t).sub(v.y).div(t - b));
      const depth = cast<F>(v.z.negate().sub(NEAR).div(FAR - NEAR));
      const s = cast<V4>(texture(c.target.texture, vec2(u, w)).level(float(lod - i * 0.3)));
      const casterDepth = cast<F>(s.y.div(max(s.x, 1e-4)));
      const occ = cast<F>(s.x.mul(depth.sub(casterDepth).mul(FAR - NEAR).sub(2).div(4).clamp(0, 1)));
      const inside = u.greaterThan(0.01).and(u.lessThan(0.99)).and(w.greaterThan(0.01)).and(w.lessThan(0.99));
      const take = cast<F>(select(chosen.lessThan(0.5).and(inside), float(1), float(0)));
      result = cast<F>(result.add(occ.mul(take)));
      chosen = cast<F>(chosen.add(take));
    }
    return cast<F>(result.clamp(0, 1).mul(this.strength).add(this.trigger as unknown as F));
  }

  dispose(): void {
    for (const c of this.cascades) c.target.dispose();
  }
}

/** The proxies' material: coverage in R, coverage × depth (along the cascade camera) in G. */
let depthMaterial: MeshBasicNodeMaterial | null = null;
function shadowMaterial(positionNode: V3 | null): MeshBasicNodeMaterial {
  if (!positionNode && depthMaterial) return depthMaterial;
  const m = new MeshBasicNodeMaterial();
  if (positionNode) m.positionNode = positionNode;
  const d = cast<F>(positionView.z.negate().sub(NEAR).div(FAR - NEAR));
  m.colorNode = vec4(1, d, 0, 1);
  m.side = DoubleSide;
  m.fog = false;
  m.toneMapped = false;
  void positionWorld;
  if (!positionNode) depthMaterial = m;
  return m;
}

/**
 * Makes `mesh` cast moon shadows: adds a proxy that shares its geometry (and skeleton or instance
 * data) on the shadow layer, as a sibling with the same transform. `positionNode` must be given for
 * meshes whose material animates vertices in TSL (the same node builds the proxy's pose).
 */
export function castShadow(mesh: Mesh | SkinnedMesh | InstancedMesh, positionNode: V3 | null = null): Object3D {
  const mat = shadowMaterial(positionNode);
  let proxy: Mesh;
  if ((mesh as SkinnedMesh).isSkinnedMesh) {
    const sm = mesh as SkinnedMesh;
    const p = new SkinnedMesh(sm.geometry as BufferGeometry, mat);
    p.bind(sm.skeleton, sm.bindMatrix);
    p.bindMode = sm.bindMode;
    proxy = p;
  } else if ((mesh as InstancedMesh).isInstancedMesh) {
    const im = mesh as InstancedMesh;
    const p = new InstancedMesh(im.geometry, mat, im.count);
    p.instanceMatrix = im.instanceMatrix;
    p.count = im.count;
    proxy = p;
  } else {
    proxy = new Mesh(mesh.geometry, mat);
  }
  proxy.name = `${mesh.name || 'mesh'}#shadow`;
  proxy.position.copy(mesh.position);
  proxy.quaternion.copy(mesh.quaternion);
  proxy.scale.copy(mesh.scale);
  proxy.layers.set(SHADOW_LAYER);
  proxy.frustumCulled = false;
  proxy.matrixAutoUpdate = mesh.matrixAutoUpdate;
  if (!mesh.matrixAutoUpdate) proxy.matrix.copy(mesh.matrix);
  (mesh.parent ?? mesh).add(proxy);
  if (!mesh.parent) {
    // No parent yet: keep the proxy under the mesh itself (identity transform).
    proxy.position.set(0, 0, 0);
    proxy.quaternion.identity();
    proxy.scale.set(1, 1, 1);
  }
  return proxy;
}
