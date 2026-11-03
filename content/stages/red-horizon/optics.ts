import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  cross,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  length,
  max,
  mix,
  mrt,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  positionGeometry,
  pow,
  screenSize,
  smoothstep,
  step,
  uv,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { additiveFog, type EnvironmentContext } from '@prismfall/sdk';
import { GROUND_Y, hazeDepth, type F, type Haze, type V3 } from './shared';

/**
 * Light from the machines' optics, drawn in two additive passes:
 *
 *  - Glints: the lit lenses themselves as tiny sprites, never smaller than about two pixels (a real
 *    lens 4 cm across is sub-pixel at 50 m, but still visible as a point of light), brighter when
 *    the sensor faces the viewer, faded by the haze. Bloom stays restrained: glints feed bloom at a
 *    fraction of their brightness.
 *  - Beams: soft cones of light scattered by the smoke (searchlights, a few red sensor beams), lit
 *    where you look through the most haze, with drifting dust in them, and a soft spot where they
 *    meet the ground. Thicker haze near the ground makes them stronger; the far end fades out.
 */

export class GlintSet {
  readonly mesh: Mesh;
  private readonly a: InstancedBufferAttribute;
  private readonly b: InstancedBufferAttribute;
  readonly capacity: number;
  private used = 0;

  constructor(capacity: number, haze: Haze, minPixels = 2.2, bloom = 0.25) {
    this.capacity = capacity;
    const geo = new PlaneGeometry(1, 1);
    this.a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.b = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.a.setUsage(DynamicDrawUsage);
    this.b.setUsage(DynamicDrawUsage);
    const ia = instancedBufferAttribute<'vec4'>(this.a, 'vec4');
    const ib = instancedBufferAttribute<'vec4'>(this.b, 'vec4');
    const vColor = varyingProperty('vec3', 'vGlintColor');
    const m = new MeshBasicNodeMaterial();
    // Billboard: radius in metres, grown to a pixel floor at distance.
    m.vertexNode = Fn(() => {
      const centre = ia.xyz;
      const view = cameraViewMatrix.mul(vec4(centre, 1));
      const dist = view.z.negate().max(0.1);
      const p11 = (cameraProjectionMatrix as unknown as { element(i: number): { y: F } }).element(1).y;
      const pxWorld = dist.mul(2).div(p11).div(screenSize.y);
      const r = max(ia.w, pxWorld.mul(minPixels * 0.5));
      // Sub-pixel lenses keep their total light: dimmer as the sprite is grown beyond the lens.
      const cover = ia.w.div(r).pow(2).mul(0.85).add(0.15);
      const haze0 = exp(hazeDepth(centre as unknown as V3, haze).negate());
      vColor.assign(ib.rgb.mul(cover).mul(haze0));
      const offset = positionGeometry.xy.mul(r.mul(2));
      return cameraProjectionMatrix.mul(vec4(view.xy.add(offset), view.z, 1));
    })();
    const d = length(uv().sub(0.5)).mul(2);
    const core = exp(d.mul(d).mul(-9));
    const halo = exp(d.mul(-4.5)).mul(0.18);
    const col = vColor.mul(core.add(halo)).mul(smoothstep(1, 0.8, d));
    m.colorNode = vec4(col, 1);
    m.blending = AdditiveBlending;
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    m.mrtNode = mrt({ emissive: vec4(col.mul(bloom), 1) });
    this.mesh = new Mesh(geo, m);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  begin(): void {
    this.used = 0;
  }

  /** Adds a glint: position, lens radius (m) and linear colour × intensity. */
  add(x: number, y: number, z: number, radius: number, r: number, g: number, b: number): void {
    if (this.used >= this.capacity) return;
    const i = this.used++;
    this.a.setXYZW(i, x, y, z, radius);
    this.b.setXYZW(i, r, g, b, 0);
  }

  end(): void {
    this.mesh.count = this.used;
    this.mesh.visible = this.used > 0;
    this.a.needsUpdate = true;
    this.b.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}

/** Unit cone along +Z (apex at the origin, radius 1 at z = 1), open at the far end. */
function coneGeometry(segments = 24, rings = 6): BufferGeometry {
  const pos: number[] = [];
  const along: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * t, Math.sin(a) * t, t);
      along.push(t, j / segments);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('along', new BufferAttribute(new Float32Array(along), 2));
  g.setIndex(idx);
  return g;
}

export class BeamSet {
  readonly cones: Mesh;
  readonly spots: Mesh;
  private readonly o: InstancedBufferAttribute;
  private readonly d: InstancedBufferAttribute;
  private readonly c: InstancedBufferAttribute;
  private readonly so: InstancedBufferAttribute;
  private readonly sc: InstancedBufferAttribute;
  readonly capacity: number;
  private used = 0;
  private spotsUsed = 0;

  constructor(ctx: EnvironmentContext, capacity: number, _haze: Haze, strength = 1) {
    this.capacity = capacity;
    const mk = () => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.o = mk();
    this.d = mk();
    this.c = mk();
    this.so = mk();
    this.sc = mk();
    const io = instancedBufferAttribute<'vec4'>(this.o, 'vec4');
    const id = instancedBufferAttribute<'vec4'>(this.d, 'vec4');
    const ic = instancedBufferAttribute<'vec4'>(this.c, 'vec4');
    const along = attribute('along', 'vec2');
    const vWorld = varyingProperty('vec3', 'vBeamWorld');
    const vAxis = varyingProperty('vec3', 'vBeamAxis');
    const vNormal = varyingProperty('vec3', 'vBeamNormal');
    const t = ctx.uniforms.time;
    const cone = new MeshBasicNodeMaterial();
    cone.positionNode = Fn(() => {
      const dir = normalize(id.xyz);
      const up = mix(vec3(0, 1, 0), vec3(1, 0, 0), smoothstep(0.9, 0.99, abs(dir.y)));
      const side = normalize(cross(up, dir));
      const up2 = cross(dir, side);
      const len = io.w;
      const radius = id.w.mul(len);
      const p = positionGeometry;
      const w = io.xyz.add(dir.mul(p.z.mul(len))).add(side.mul(p.x.mul(radius))).add(up2.mul(p.y.mul(radius)));
      vWorld.assign(w);
      vAxis.assign(dir);
      vNormal.assign(normalize(side.mul(p.x).add(up2.mul(p.y)).sub(dir.mul(id.w))));
      return w;
    })();
    // Brightest where the eye looks through the cone's middle (a long path through lit haze).
    const view = normalize(cameraPosition.sub(vWorld));
    const facing = abs(dot(normalize(vNormal), view));
    const thick = pow(facing, 1.6);
    const tAlong = along.x;
    const fall = smoothstep(0.0, 0.06, tAlong).mul(pow(float(1).sub(tAlong).max(0), 1.4)).div(tAlong.mul(3).add(1));
    const dust = mx_noise_float(vWorld.mul(0.35).add(vec3(t.mul(0.4), t.mul(-0.15), t.mul(0.2)))).mul(0.35).add(0.75);
    const lowHaze = exp(vWorld.y.sub(GROUND_Y).div(-22)).mul(0.8).add(0.5);
    // Looking along the beam (towards its source) scatters forward: a little brighter.
    const forward = pow(max(dot(vAxis, view.negate()), 0), 4).mul(0.6).add(1);
    const glow = ic.rgb.mul(thick).mul(fall).mul(dust).mul(lowHaze).mul(forward).mul(strength * 0.5);
    const col = additiveFog(glow as unknown as V3);
    cone.colorNode = vec4(col, 1);
    cone.blending = AdditiveBlending;
    cone.transparent = true;
    cone.depthWrite = false;
    cone.side = DoubleSide;
    cone.fog = false;
    cone.mrtNode = mrt({ emissive: vec4(col.mul(0.08), 1) });
    this.cones = new Mesh(coneGeometry(), cone);
    this.cones.count = 0;
    this.cones.frustumCulled = false;
    this.cones.renderOrder = 7;

    // Ground spots: light where beams land on the yard. Drawn on a camera-facing quad, but each
    // fragment finds the ground point behind it, so the spot is a true ellipse on the ground with a
    // soft falloff, broken up by the unevenness of the asphalt (light on a surface, never a flat
    // disc of colour).
    const iso = instancedBufferAttribute<'vec4'>(this.so, 'vec4');
    const isc = instancedBufferAttribute<'vec4'>(this.sc, 'vec4');
    const spot = new MeshBasicNodeMaterial();
    const vSpot = varyingProperty('vec4', 'vSpotCentre');
    const vFrag = varyingProperty('vec3', 'vSpotFrag');
    spot.vertexNode = Fn(() => {
      // so: xyz centre, w radius. The quad is squashed by how steeply the eye looks down at the
      // spot so it just covers the ellipse.
      const centre = vec3(iso.x, iso.y.add(0.05), iso.z);
      const toEye = normalize(cameraPosition.sub(centre));
      const squash = toEye.y.abs().max(0.22);
      vSpot.assign(vec4(iso.x, iso.y, iso.z, iso.w));
      const view = cameraViewMatrix.mul(vec4(centre, 1));
      const corner = vec4(view.xy.add(positionGeometry.xy.mul(vec2(iso.w.mul(1.2), iso.w.mul(squash).mul(1.25)))), view.z, 1);
      vFrag.assign(cameraWorldMatrix.mul(corner).xyz);
      return cameraProjectionMatrix.mul(corner);
    })();
    const ray = vFrag.sub(cameraPosition);
    const down = step(ray.y, -1e-4);
    const hitT = vSpot.y.sub(cameraPosition.y).div(ray.y.min(-1e-4)).max(0);
    const G = cameraPosition.add(ray.mul(hitT));
    const sd = length(vec2(G.x.sub(vSpot.x), G.z.sub(vSpot.z))).div(vSpot.w.max(0.05));
    const rough = mx_fractal_noise_float(vec3(G.x.mul(1.6), G.z.mul(1.6), 3.7), 3, 2, 0.5).mul(0.45).add(0.75).max(0);
    const spotGlow = isc.rgb.mul(exp(sd.mul(sd).mul(-4.5))).mul(smoothstep(1.1, 0.55, sd)).mul(rough).mul(down).mul(strength * 0.42);
    const spotCol = additiveFog(spotGlow as unknown as V3);
    spot.colorNode = vec4(spotCol, 1);
    spot.blending = AdditiveBlending;
    spot.transparent = true;
    spot.depthWrite = false;
    spot.side = DoubleSide;
    spot.fog = false;
    spot.mrtNode = mrt({ emissive: vec4(0, 0, 0, 1) });
    const plane = new PlaneGeometry(2, 2);
    this.spots = new Mesh(plane, spot);
    this.spots.count = 0;
    this.spots.frustumCulled = false;
    this.spots.renderOrder = 6;
  }

  begin(): void {
    this.used = 0;
    this.spotsUsed = 0;
  }

  /**
   * A beam from (x, y, z) along a unit direction, `length` metres long with a half-angle tangent
   * `spread`, in linear colour × intensity. Adds a ground spot where it meets the yard.
   */
  add(x: number, y: number, z: number, dx: number, dy: number, dz: number, length: number, spread: number, r: number, g: number, b: number, groundY = GROUND_Y, spotGain = 1): void {
    if (this.used >= this.capacity) return;
    let len = length;
    if (dy < -0.02) {
      const hit = (groundY - y) / dy;
      if (hit > 0 && hit < length) {
        len = hit;
        if (this.spotsUsed < this.capacity) {
          const s = this.spotsUsed++;
          const radius = Math.max(0.3, hit * spread);
          const incidence = Math.max(0.15, -dy);
          // Stretch along x only (beams here mostly sweep across the view): a fair approximation.
          const fade = spotGain / (1 + hit * hit * 0.0004);
          this.so.setXYZW(s, x + dx * hit, groundY, z + dz * hit, radius);
          this.sc.setXYZW(s, r * fade * 1.1, g * fade * 1.1, b * fade * 1.1, 1 / incidence);
        }
      }
    }
    const i = this.used++;
    this.o.setXYZW(i, x, y, z, len);
    this.d.setXYZW(i, dx, dy, dz, spread);
    this.c.setXYZW(i, r, g, b, 0);
  }

  end(): void {
    this.cones.count = this.used;
    this.spots.count = this.spotsUsed;
    this.cones.visible = this.used > 0;
    this.spots.visible = this.spotsUsed > 0;
    for (const a of [this.o, this.d, this.c, this.so, this.sc]) a.needsUpdate = true;
  }

  dispose(): void {
    this.cones.geometry.dispose();
    this.spots.geometry.dispose();
    (this.cones.material as MeshBasicNodeMaterial).dispose();
    (this.spots.material as MeshBasicNodeMaterial).dispose();
  }
}

