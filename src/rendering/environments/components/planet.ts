import { AdditiveBlending, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, RingGeometry, SphereGeometry, Vector3 } from 'three/webgpu';
import { clamp, dot, float, length, mix, mrt, mx_fractal_noise_float, normalView, normalWorld, normalize, positionLocal, positionViewDirection, sin, smoothstep, uniform, vec4 } from 'three/tsl';
import { z } from 'zod';
import type { ComponentFactory } from '../../../sdk/types';
import { colorUniform, floatUniform, zColor, zVec3 } from './common';

const schema = z.object({
  position: zVec3.default([-160, 60, -420]),
  radius: z.number().default(70),
  colorA: zColor.default('#c48a5a'),
  colorB: zColor.default('#5a3a72'),
  bands: z.number().default(9),
  atmosphere: zColor.default('#8fb4ff'),
  atmosphereStrength: z.number().default(0.9),
  lightDirection: zVec3.default([1, 0.4, 0.6]),
  rotationSpeed: z.number().default(0.01),
  tilt: z.number().default(0.35),
  ring: z
    .object({ inner: z.number(), outer: z.number(), color: zColor, opacity: z.number().default(0.7) })
    .optional(),
});

/** Distant planet: banded procedural surface, lit terminator, atmosphere rim and optional rings. */
export const planetComponent: ComponentFactory<z.infer<typeof schema>> = {
  type: 'planet',
  version: 1,
  description: 'Procedural banded planet with atmosphere glow and optional ring system.',
  schema,
  create(_ctx, p) {
    const group = new Group();
    group.position.set(...p.position);
    group.rotation.z = p.tilt;
    const u = { atmosphere: floatUniform(p.atmosphereStrength), presence: floatUniform(1) };
    const light = uniform(new Vector3(...p.lightDirection).normalize());
    const lat = positionLocal.y.div(p.radius);
    const noise = mx_fractal_noise_float(positionLocal.mul(3 / p.radius), 4, 2.0, 0.5);
    const bands = sin(lat.mul(p.bands).add(noise.mul(1.6))).mul(0.5).add(0.5);
    const surface = mix(colorUniform(p.colorA), colorUniform(p.colorB), bands);
    const diffuse = clamp(dot(normalize(normalWorld), light).mul(1.1).add(0.08), 0, 1);
    const rim = float(1).sub(clamp(dot(normalView, positionViewDirection), 0, 1)).pow(3);
    const atmo = colorUniform(p.atmosphere).mul(rim.mul(u.atmosphere)).mul(diffuse.add(0.25));
    const color = surface.mul(diffuse).add(atmo).mul(u.presence);
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(color, 1);
    material.mrtNode = mrt({ emissive: vec4(atmo.mul(0.5).mul(u.presence), 1) });
    material.fog = false;
    const sphere = new Mesh(new SphereGeometry(p.radius, 96, 48), material);
    group.add(sphere);

    let ringMesh: Mesh | null = null;
    if (p.ring) {
      const ringGeo = new RingGeometry(p.ring.inner, p.ring.outer, 160, 1);
      const rmat = new MeshBasicNodeMaterial();
      const rr = length(positionLocal.xy);
      const t = rr.sub(p.ring.inner).div(p.ring.outer - p.ring.inner);
      const stripes = sin(t.mul(80)).mul(0.25).add(sin(t.mul(23)).mul(0.25)).add(0.5);
      const edge = smoothstep(0, 0.08, t).mul(smoothstep(1, 0.85, t));
      const rcol = colorUniform(p.ring.color).mul(stripes.mul(edge).mul(p.ring.opacity)).mul(u.presence);
      rmat.colorNode = vec4(rcol, 1);
      rmat.transparent = true;
      rmat.depthWrite = false;
      rmat.blending = AdditiveBlending;
      rmat.side = DoubleSide;
      rmat.fog = false;
      rmat.mrtNode = mrt({ emissive: vec4(rcol.mul(0.25), 1) });
      ringMesh = new Mesh(ringGeo, rmat);
      ringMesh.rotation.x = Math.PI / 2.3;
      group.add(ringMesh);
    }
    return {
      object: group,
      reactive: { atmosphere: u.atmosphere },
      update(frame) {
        sphere.rotation.y += frame.dt * p.rotationSpeed;
      },
      setPresence(v) {
        u.presence.value = v;
      },
      dispose() {
        sphere.geometry.dispose();
        material.dispose();
        if (ringMesh) {
          ringMesh.geometry.dispose();
          (ringMesh.material as MeshBasicNodeMaterial).dispose();
        }
      },
    };
  },
};

