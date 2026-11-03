import { Color, DirectionalLight, Group, HemisphereLight, MathUtils, PointLight } from 'three/webgpu';

/** Stage-authored lighting. The rig's light count never changes (avoids shader recompiles). */
export interface LightingConfig {
  key: { color: string; intensity: number; azimuth: number; elevation: number };
  rim: { color: string; intensity: number };
  ambient: { sky: string; ground: string; intensity: number };
  accents: readonly { color: string; intensity: number; x: number; y: number; z: number }[];
  /** How much the beat pulses the accent lights (0..1). */
  beatResponse: number;
}

export const DEFAULT_LIGHTING: LightingConfig = {
  key: { color: '#fff4e8', intensity: 2.4, azimuth: -35, elevation: 40 },
  rim: { color: '#8fb4ff', intensity: 1.6 },
  ambient: { sky: '#3a3f7a', ground: '#120f2a', intensity: 0.9 },
  accents: [
    { color: '#5cf2c8', intensity: 30, x: -9, y: -6, z: 6 },
    { color: '#b57cff', intensity: 30, x: 9, y: 7, z: 6 },
  ],
  beatResponse: 0.4,
};

const ACCENT_COUNT = 2;

export type ShadowQuality = 'off' | 'low' | 'medium' | 'high';

/** Fixed global rig: key (shadow caster), rim, hemisphere ambient and two accent point lights. */
export class LightRig {
  readonly group = new Group();
  readonly key = new DirectionalLight();
  readonly rim = new DirectionalLight();
  readonly ambient = new HemisphereLight();
  readonly accents: PointLight[] = [];
  private config: LightingConfig = DEFAULT_LIGHTING;
  private from: LightingConfig = DEFAULT_LIGHTING;
  private blend = 1;
  private readonly baseAccent: number[] = [];
  /** Level-up bundle: accents grow a little brighter with each level. */
  private level = 1;

  setLevel(level: number): void {
    this.level = level;
  }

  constructor() {
    this.key.target.position.set(0, 0, 0);
    this.group.add(this.key, this.key.target, this.rim, this.ambient);
    for (let i = 0; i < ACCENT_COUNT; i++) {
      // Short range: accents shape the playfield, not the distant world.
      const light = new PointLight(0xffffff, 0, 30, 1.6);
      this.accents.push(light);
      this.group.add(light);
    }
    const cam = this.key.shadow.camera;
    cam.left = -7;
    cam.right = 7;
    cam.top = 12;
    cam.bottom = -12;
    cam.near = 1;
    cam.far = 60;
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.02;
    this.apply(DEFAULT_LIGHTING, 1);
  }

  setShadowQuality(q: ShadowQuality): void {
    this.key.castShadow = q !== 'off';
    const size = q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024;
    if (this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.key.shadow.radius = q === 'high' ? 3 : 2;
  }

  transitionTo(config: LightingConfig): void {
    this.from = this.config;
    this.config = config;
    this.blend = 0;
  }

  private static mixColor(a: string, b: string, t: number, out: Color): Color {
    return out.set(a).lerp(new Color(b), t);
  }

  private apply(cfg: LightingConfig, t: number): void {
    const a = this.from;
    const lerp = MathUtils.lerp;
    LightRig.mixColor(a.key.color, cfg.key.color, t, this.key.color);
    this.key.intensity = lerp(a.key.intensity, cfg.key.intensity, t);
    const az = MathUtils.degToRad(lerp(a.key.azimuth, cfg.key.azimuth, t));
    const el = MathUtils.degToRad(lerp(a.key.elevation, cfg.key.elevation, t));
    this.key.position.set(Math.sin(az) * Math.cos(el) * 30, Math.sin(el) * 30, Math.cos(az) * Math.cos(el) * 30);
    LightRig.mixColor(a.rim.color, cfg.rim.color, t, this.rim.color);
    this.rim.intensity = lerp(a.rim.intensity, cfg.rim.intensity, t);
    this.rim.position.set(6, 10, -20);
    LightRig.mixColor(a.ambient.sky, cfg.ambient.sky, t, this.ambient.color);
    LightRig.mixColor(a.ambient.ground, cfg.ambient.ground, t, this.ambient.groundColor);
    this.ambient.intensity = lerp(a.ambient.intensity, cfg.ambient.intensity, t);
    for (let i = 0; i < ACCENT_COUNT; i++) {
      const fa = a.accents[i] ?? { color: '#000000', intensity: 0, x: 0, y: 0, z: 5 };
      const fb = cfg.accents[i] ?? { color: '#000000', intensity: 0, x: 0, y: 0, z: 5 };
      const light = this.accents[i] as PointLight;
      LightRig.mixColor(fa.color, fb.color, t, light.color);
      this.baseAccent[i] = lerp(fa.intensity, fb.intensity, t);
      light.position.set(lerp(fa.x, fb.x, t), lerp(fa.y, fb.y, t), lerp(fa.z, fb.z, t));
    }
  }

  update(dt: number, beatPulse: number, clearPulse: number, reactivity: number): void {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 1.8);
      this.apply(this.config, MathUtils.smootherstep(this.blend, 0, 1));
    }
    // The playfield's light stays steady: no beat or clear pulsing (it reads as flicker).
    void beatPulse;
    void clearPulse;
    void reactivity;
    const levelBoost = 1 + Math.min(0.3, (this.level - 1) * 0.02);
    this.accents.forEach((light, i) => (light.intensity = (this.baseAccent[i] ?? 0) * levelBoost));
  }
}
