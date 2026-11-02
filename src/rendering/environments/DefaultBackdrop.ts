import { BackSide, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicNodeMaterial, Points, PointsNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { attribute, float, mix, positionWorldDirection, sin, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { frameUniforms, noBloom } from '../shaders/uniforms';

/**
 * The "between worlds" backdrop shown when no stage environment is loaded (menus before a stage,
 * load failures). A deep gradient dome with slowly drifting light motes.
 */
export class DefaultBackdrop {
  readonly group = new Group();
  private readonly dome: Mesh;
  private readonly motes: Points;
  readonly top = uniform(new Vector3(0.006, 0.007, 0.03));
  readonly bottom = uniform(new Vector3(0.0015, 0.0012, 0.005));
  readonly glow = uniform(new Vector3(0.03, 0.04, 0.12));

  constructor() {
    const domeMat = new MeshBasicNodeMaterial();
    const dir = positionWorldDirection;
    const h = dir.y.mul(0.5).add(0.5);
    const band = smoothstep(0.35, 0.0, dir.y.abs()).mul(0.35).mul(float(0.85).add(frameUniforms.bass.mul(0.3)));
    domeMat.colorNode = vec4(mix(this.bottom, this.top, h).add(this.glow.mul(band)), 1);
    domeMat.side = BackSide;
    domeMat.depthWrite = false;
    noBloom(domeMat);
    this.dome = new Mesh(new SphereGeometry(400, 48, 24), domeMat);
    this.dome.renderOrder = -10;

    const count = 1400;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 40 + Math.random() * 180;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * r;
      pos[i * 3 + 1] = Math.cos(ph) * r * 0.6;
      pos[i * 3 + 2] = -Math.abs(Math.sin(ph) * Math.sin(th) * r) - 20;
      seed[i] = Math.random();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('seed', new Float32BufferAttribute(seed, 1));
    const pm = new PointsNodeMaterial();
    const s = attribute<'float'>('seed', 'float');
    const twinkle = sin(frameUniforms.time.mul(s.mul(2).add(0.5)).add(s.mul(40))).mul(0.5).add(0.5);
    pm.colorNode = vec4(vec3(0.35, 0.42, 0.6).mul(twinkle.mul(0.8).add(0.2)), 1);
    pm.transparent = true;
    pm.depthWrite = false;
    noBloom(pm);
    this.motes = new Points(geo, pm);
    this.group.add(this.dome, this.motes);
  }

  setColors(top: readonly [number, number, number], bottom: readonly [number, number, number], glow: readonly [number, number, number]): void {
    this.top.value.set(...top);
    this.bottom.value.set(...bottom);
    this.glow.value.set(...glow);
  }

  dispose(): void {
    this.dome.geometry.dispose();
    (this.dome.material as MeshBasicNodeMaterial).dispose();
    this.motes.geometry.dispose();
    (this.motes.material as PointsNodeMaterial).dispose();
  }
}
