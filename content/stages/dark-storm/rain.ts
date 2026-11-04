import { AdditiveBlending, DoubleSide, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicNodeMaterial, NormalBlending, PlaneGeometry, type Node } from 'three/webgpu';
import {
  Fn,
  abs,
  cameraPosition,
  cameraProjectionMatrix,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  instancedBufferAttribute,
  int,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  pow,
  screenSize,
  sin,
  smoothstep,
  step,
  texture,
  uv,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { clearFront, clearFrontMotion, frameUniforms, noBloom, z, type ComponentFactory } from '@prismfall/sdk';
import { EYE, pointAt, terrainHeight } from './terrain';
import { CLOUD_BASE, FLASH_COLOR, HAZE_DENSITY, MAX_FLASH, cast, hash2, releaseStorm, skyRadiance, storm, surfaceMap, surfaceUV, tickStorm, type F, type Storm, type V2, type V3, type V4 } from './shared';

const zLayer = z.object({
  count: z.number().int().min(0).max(200000),
  /** Box around the viewer: half width (x), depth ahead (−z) and behind (+z), and height range. */
  halfWidth: z.number().positive(),
  ahead: z.number().positive(),
  behind: z.number().min(0),
  low: z.number(),
  high: z.number(),
  /** Streak length scale, drop width (m), brightness. */
  length: z.number().positive().default(1),
  width: z.number().positive().default(0.01),
  brightness: z.number().min(0).default(1),
});

const schema = z.object({
  layers: z.array(zLayer).default([
    { count: 2200, halfWidth: 9, ahead: 10, behind: 6, low: -4, high: 9, length: 0.75, width: 0.009, brightness: 0.55 },
    { count: 16000, halfWidth: 48, ahead: 75, behind: 14, low: -9, high: 30, length: 1.0, width: 0.012, brightness: 0.85 },
    { count: 30000, halfWidth: 230, ahead: 330, behind: 40, low: -50, high: 70, length: 0.9, width: 0.03, brightness: 0.5 },
  ]),
  splashes: z.number().int().min(0).max(20000).default(2600),
  curtains: z.number().int().min(0).max(24).default(10),
  /** Overall drop opacity. */
  opacity: z.number().min(0).default(1),
});

type Params = z.infer<typeof schema>;

const pixelAt = (dist: F): F => {
  const p11 = (cameraProjectionMatrix as unknown as { element(i: number): Node<'vec4'> }).element(1).y;
  return cast<F>(dist.mul(2).div(p11.mul(screenSize.y)));
};

/** Light on a drop or splash at `p` seen along `view`: dim storm light, flashes from all around, a glint against the flash. */
function dropLight(s: Storm, p: V3, view: V3): V3 {
  let lit: V3 = cast<V3>(vec3(0.016, 0.019, 0.025).add(vec3(...FLASH_COLOR).mul(s.u.skyFlash.mul(0.25))));
  for (let i = 0; i < MAX_FLASH; i++) {
    const fp = cast<V4>(s.u.flashPos.element(int(i)));
    const to = fp.xyz.sub(p);
    const d = length(to);
    // Drops scatter light forwards: brightest when the flash is behind them.
    const glint = pow(max(dot(view, to.div(d)), 0), 8).mul(2.2).add(0.25);
    lit = cast<V3>(lit.add(vec3(...FLASH_COLOR).mul(fp.w.mul(glint).mul(90).div(d.add(150)))));
  }
  return lit;
}

/**
 * Heavy rain in depth layers (fine distant rainfall, the midground, large drops close by) as GPU
 * streaks: every drop's position is computed in the vertex shader from its instance seed, the time
 * and the integrated wind, wrapped in its layer's box around the viewer, so nothing is updated on
 * the CPU. Drops slant with the wind and stretch along their motion; they are dim against the dark
 * and blaze when lightning lights them. Drops between the viewer and the playfield are thinned to
 * near nothing so rain never hides the pieces. Splashes crown on the ledge and the puddles around
 * the viewer; far off, grey curtains of rain hang under the cloud base and light up with the flashes.
 */
export const rainComponent: ComponentFactory<Params> = {
  type: 'stormRain',
  version: 1,
  description: 'Dark Storm: layered GPU rain streaks, splashes and distant rain curtains, lit by lightning.',
  schema,
  create(ctx, p) {
    const s = storm(ctx);
    const u = s.u;
    const group = new Group();
    const disposables: { dispose(): void }[] = [];
    const density = Math.max(0, ctx.quality.particles) * (ctx.quality.detail === 'low' ? 0.5 : ctx.quality.detail === 'medium' ? 0.75 : 1);
    const quad = new PlaneGeometry(1, 1);
    disposables.push(quad);
    const seeds = (n: number, salt: number): Float32Array => {
      const a = new Float32Array(n * 4);
      let st = (salt * 2654435761) >>> 0 || 1;
      for (let i = 0; i < a.length; i++) {
        st ^= st << 13;
        st ^= st >>> 17;
        st ^= st << 5;
        a[i] = (st >>> 0) / 4294967296;
      }
      return a;
    };

    // ------------------------------------------------------------------ streaks
    p.layers.forEach((layer, li) => {
      const count = Math.round(layer.count * density);
      if (count < 1) return;
      const geo = new InstancedBufferGeometry();
      geo.index = quad.index;
      geo.setAttribute('position', quad.getAttribute('position'));
      const seed = new InstancedBufferAttribute(seeds(count, 11 + li * 7), 4);
      geo.setAttribute('seed', seed);
      geo.instanceCount = count;
      const S = cast<V4>(instancedBufferAttribute(seed, 'vec4'));
      const vAcross = varyingProperty('float', 'vRainAcross');
      const vAlong = varyingProperty('float', 'vRainAlong');
      const vCover = varyingProperty('float', 'vRainCover');
      const vColor = varyingProperty('vec3', 'vRainColor');
      const size = vec3(layer.halfWidth * 2, layer.high - layer.low, layer.ahead + layer.behind);
      const origin = vec3(EYE.x - layer.halfWidth, layer.low, EYE.z - layer.ahead);
      const m = new MeshBasicNodeMaterial();
      m.positionNode = Fn(() => {
        const fall = S.w.mul(2.6).add(7.6);
        const t = u.time;
        // Each drop drifts with the integrated wind (gusts swing the whole rain together) and falls.
        const k = S.x.mul(0.3).add(0.85);
        const raw = vec3(S.x, S.y, S.z).mul(size).add(vec3(u.windOffset.x.mul(k), fall.mul(t).negate(), u.windOffset.z.mul(k)));
        const home = cast<V3>(origin.add(fract(raw.div(size)).mul(size)));
        // A clear's front runs through the rain as a gust: drops in its band are shoved out from the
        // board and slant with it, settling in its tail (accessibility-scaled motion).
        const outward = cast<V3>(normalize(vec3(home.x.sub(frameUniforms.waveOrigin.x), 0, home.z.sub(frameUniforms.waveOrigin.z)).add(vec3(0.0001, 0, 0))));
        const shove = cast<F>(clearFrontMotion(home).min(1));
        const wrapped = cast<V3>(home.add(outward.mul(shove.mul(1.4))));
        const vel = cast<V3>(vec3(u.wind.x.mul(k).add(outward.x.mul(shove.mul(9))), fall.negate(), u.wind.z.mul(k).add(outward.z.mul(shove.mul(9)))));
        const dir = cast<V3>(normalize(vel));
        const toCam = cast<V3>(cameraPosition.sub(wrapped));
        const dist = length(toCam);
        const pixel = pixelAt(dist);
        const len = length(vel).mul(0.032).mul(layer.length);
        const trueW = float(layer.width).mul(S.y.mul(0.6).add(0.7));
        const drawW = max(trueW, pixel.mul(1.1));
        const across = normalize(cross(dir, toCam));
        // Visible share of the drops follows the rain's intensity.
        const shown = step(S.w, u.rain.div(1.5).mul(0.85).add(0.15));
        // Never in front of the pieces: drops whose line of sight crosses the board are thinned out.
        const camZ = cameraPosition.z.max(1);
        const ahead = step(wrapped.z, camZ.sub(0.5)).mul(step(0, wrapped.z));
        const k2 = camZ.div(camZ.sub(wrapped.z).max(0.01));
        const hit = cameraPosition.xy.add(wrapped.xy.sub(cameraPosition.xy).mul(k2));
        const onBoard = step(abs(hit.x), 6.6).mul(step(abs(hit.y), 11.6)).mul(ahead);
        const near = smoothstep(1.6, 4.5, dist);
        const fade = smoothstep(0, 0.08, fract(raw.y.div(size.y))).mul(smoothstep(1, 0.92, fract(raw.y.div(size.y))));
        const keep = shown.mul(near).mul(fade).mul(mix(float(1), float(0.06), onBoard));
        const view = cast<V3>(normalize(wrapped.sub(cameraPosition)));
        const haze = exp(dist.mul(HAZE_DENSITY * 0.9).negate());
        vAcross.assign(positionGeometry.x.mul(2));
        vAlong.assign(positionGeometry.y.add(0.5));
        vCover.assign(trueW.div(drawW).mul(keep).mul(haze));
        // ...and the drops in the band catch a little cold light as it passes.
        vColor.assign(dropLight(s, wrapped, view).add(vec3(...FLASH_COLOR).mul(clearFront(home).mul(0.028))));
        const corner = across.mul(positionGeometry.x.mul(drawW).mul(2)).add(dir.mul(positionGeometry.y.mul(len)));
        return wrapped.add(corner.mul(step(0.001, keep)));
      })();
      const prof = cast<F>(exp(cast<F>(vAcross).pow(2).mul(-3)).mul(smoothstep(0, 0.25, cast<F>(vAlong))).mul(smoothstep(1, 0.6, cast<F>(vAlong))));
      const col = cast<V3>(cast<V3>(vColor).mul(prof).mul(cast<F>(vCover)).mul(layer.brightness * p.opacity).mul(u.presence));
      m.colorNode = vec4(col, 1);
      m.transparent = true;
      m.depthWrite = false;
      m.blending = AdditiveBlending;
      m.side = DoubleSide;
      m.fog = false;
      noBloom(m);
      const mesh = new Mesh(geo, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = 8 + li;
      group.add(mesh);
      disposables.push(geo, m);
    });

    // ------------------------------------------------------------------ splashes
    const splashCount = Math.round(p.splashes * density);
    if (splashCount > 0) {
      const map = surfaceMap(s);
      const geo = new InstancedBufferGeometry();
      geo.index = quad.index;
      geo.setAttribute('position', quad.getAttribute('position'));
      const seed = new InstancedBufferAttribute(seeds(splashCount, 97), 4);
      geo.setAttribute('seed', seed);
      geo.instanceCount = splashCount;
      const S = cast<V4>(instancedBufferAttribute(seed, 'vec4'));
      const vQ = varyingProperty('vec2', 'vSplashQ');
      const vLife = varyingProperty('float', 'vSplashLife');
      const vWet = varyingProperty('float', 'vSplashWet');
      const vCol = varyingProperty('vec3', 'vSplashColor');
      const vSeed = varyingProperty('float', 'vSplashSeed');
      const m = new MeshBasicNodeMaterial();
      m.positionNode = Fn(() => {
        const period = S.x.mul(0.35).add(0.3);
        const t = u.time.add(S.y.mul(period));
        const cycle = floor(t.div(period));
        const life = fract(t.div(period));
        // A new spot every cycle, near the viewer more often than far (spread over 3..48 m).
        const h1 = hash2(cast<V2>(vec2(cycle, S.z.mul(997))));
        const h2 = hash2(cast<V2>(vec2(S.w.mul(911), cycle.add(3.1))));
        const ang = h1.mul(2.6).sub(1.3).mul(1.15).add(S.z.sub(0.5).mul(0.6));
        const rad = mix(float(3), float(48), h2.pow(1.6));
        const xz = cast<V2>(vec2(sin(ang).mul(rad).add(EYE.x), cos(ang).mul(rad).negate().add(EYE.z)));
        const sm = cast<V4>(texture(map, surfaceUV(xz)).level(float(0)));
        const groundY = sm.w;
        // Only on the ledge (not over the drop to the glen), and only as often as the rain allows.
        const onLedge = step(-6.5, groundY);
        const shown = step(S.w, u.rain.div(1.4)).mul(onLedge);
        const wet = max(sm.x, sm.y);
        const size = mix(float(0.16), float(0.1), wet).mul(S.x.mul(0.6).add(0.7)).mul(rad.div(20).add(0.8).min(2.2));
        const centre = vec3(xz.x, groundY.add(size.mul(0.42)), xz.y);
        const toCam = cast<V3>(cameraPosition.sub(centre));
        const right = normalize(cross(vec3(0, 1, 0), toCam));
        vQ.assign(positionGeometry.xy.mul(2));
        vLife.assign(life);
        vWet.assign(wet);
        vSeed.assign(h1);
        const dist = length(toCam);
        vCol.assign(dropLight(s, centre, cast<V3>(normalize(centre.sub(cameraPosition)))).mul(exp(dist.mul(HAZE_DENSITY).negate())).mul(smoothstep(60, 30, dist)));
        return centre.add(right.mul(positionGeometry.x.mul(size))).add(vec3(0, 1, 0).mul(positionGeometry.y.mul(size))).mul(1).add(vec3(0, -1000, 0).mul(float(1).sub(shown)));
      })();
      // A crown: a thin rim rising and spreading, then droplets thrown up that fall back.
      const q = cast<V2>(vQ);
      const life = cast<F>(vLife);
      const rimR = life.mul(0.55).add(0.12);
      const rimH = life.mul(1).min(0.4).mul(float(1).sub(life).mul(1.6));
      const rim = exp(abs(abs(q.x).sub(rimR)).mul(-14)).mul(smoothstep(rimH.sub(0.75), rimH.sub(0.95), q.y)).mul(smoothstep(-1, -0.9, q.y)).mul(0.6);
      const base = exp(q.y.add(0.9).abs().mul(-22)).mul(smoothstep(rimR.add(0.25), rimR, abs(q.x))).mul(0.6);
      let drops: F = cast<F>(float(0));
      for (let k = 0; k < 3; k++) {
        const off = fract(cast<F>(vSeed).mul(17.3 + k * 5.1));
        const dx = off.sub(0.5).mul(1.1);
        const vy = fract(off.mul(31.7)).mul(0.6).add(0.9);
        const y = vy.mul(life).mul(2.2).sub(life.mul(life).mul(2.6)).sub(0.85);
        const d = length(q.sub(vec2(dx.mul(life.mul(1.6).add(0.2)), y)));
        drops = cast<F>(drops.add(exp(d.mul(d).mul(-900))));
      }
      const fadeLife = smoothstep(0, 0.06, life).mul(smoothstep(1, 0.55, life));
      const shape = rim.add(base).add(drops.mul(mix(float(0.8), float(1.4), cast<F>(vWet)))).mul(fadeLife);
      const col = cast<V3>(cast<V3>(vCol).mul(shape).mul(0.55).mul(u.presence));
      m.colorNode = vec4(col, 1);
      m.transparent = true;
      m.depthWrite = false;
      m.blending = AdditiveBlending;
      m.side = DoubleSide;
      m.fog = false;
      noBloom(m);
      const mesh = new Mesh(geo, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = 7;
      group.add(mesh);
      disposables.push(geo, m);
    }

    // ------------------------------------------------------------------ curtains
    if (p.curtains > 0 && ctx.quality.detail !== 'low') {
      let st = 4049;
      const rnd = (): number => {
        st = (st * 16807) % 2147483647;
        return st / 2147483647;
      };
      for (let i = 0; i < p.curtains; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const az = side * (14 + rnd() * 55) + (rnd() < 0.2 ? 180 : 0);
        const dist = 380 + rnd() * 1100;
        const at = pointAt(az, dist);
        const ground = Math.max(-46, terrainHeight(at.x, at.z));
        const width = 380 + rnd() * 520;
        const height = CLOUD_BASE + 30 - ground;
        const plane = new PlaneGeometry(width, height, 1, 1);
        const m = new MeshBasicNodeMaterial();
        const seed = rnd() * 100;
        const uvq = cast<V2>(uv());
        const x = uvq.x.mul(width / 40).add(seed).add(u.windOffset.x.div(40));
        // Streaks: noise stretched tall and falling fast; sheets drifting slowly across.
        const streak = mx_noise_float(vec3(x.mul(1.4), uvq.y.mul(1.2).add(u.time.mul(1.6)), seed)).mul(0.5).add(0.5);
        const sheet = mx_noise_float(vec3(x.mul(0.25), uvq.y.mul(0.6), u.time.mul(0.04).add(seed))).mul(0.5).add(0.5);
        const edge = smoothstep(0, 0.25, uvq.x).mul(smoothstep(1, 0.75, uvq.x)).mul(smoothstep(0, 0.12, uvq.y)).mul(smoothstep(1, 0.8, uvq.y));
        const alpha = cast<F>(smoothstep(0.25, 0.9, sheet).mul(streak.mul(0.3).add(0.7)).mul(edge).mul(u.rain.mul(0.55).add(0.25)).mul(0.12));
        const centre = cast<V3>(vec3(at.x, ground + height / 2, at.z));
        // The curtain's colour: the storm air, lit through from behind by any flash.
        const view = cast<V3>(normalize(centre.sub(cameraPosition)));
        const air = cast<V3>(skyRadiance(s, cast<V3>(normalize(vec3(view.x, 0.04, view.z))), 1).mul(1.15));
        let lit: V3 = air;
        for (let k = 0; k < MAX_FLASH; k++) {
          const fp = cast<V4>(u.flashPos.element(int(k)));
          const to = fp.xyz.sub(centre);
          const d = length(to);
          const back = pow(max(dot(view, to.div(d)), 0), 3).mul(1.6).add(0.25);
          lit = cast<V3>(lit.add(vec3(...FLASH_COLOR).mul(fp.w.mul(back).mul(120).div(d.add(300)))));
        }
        const fogT = exp(float(dist).mul(-HAZE_DENSITY * 0.6));
        m.colorNode = vec4(lit.mul(fogT), alpha.mul(u.presence));
        m.transparent = true;
        m.depthWrite = false;
        m.blending = NormalBlending;
        m.side = DoubleSide;
        m.fog = false;
        noBloom(m);
        const mesh = new Mesh(plane, m);
        mesh.position.set(at.x, ground + height / 2, at.z);
        mesh.rotation.y = Math.atan2(at.x - EYE.x, at.z - EYE.z);
        mesh.renderOrder = 3 - dist / 2000;
        mesh.frustumCulled = false;
        group.add(mesh);
        disposables.push(plane, m);
      }
    }
    void min;
    void dot;

    return {
      object: group,
      update(frame) {
        tickStorm(s, ctx, frame);
      },
      setPresence() {
        // Brightness follows the storm's presence.
      },
      dispose() {
        for (const d of disposables) d.dispose();
        releaseStorm(ctx, s);
      },
    };
  },
};
