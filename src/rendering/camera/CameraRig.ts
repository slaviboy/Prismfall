import { MathUtils, PerspectiveCamera, Vector3 } from 'three/webgpu';

export interface CameraSettings {
  zoom: number;
  distance: number;
  fov: number;
  shake: boolean;
  shakeIntensity: number;
  movementIntensity: number;
  reducedMotion: boolean;
}

/** Stage-authored framing; angles are bounded so the playfield always stays readable. */
export interface CameraPreset {
  /** Degrees of downward/upward tilt (positive = camera above, looking down). */
  pitch: number;
  /** Degrees of horizontal orbit. */
  yaw: number;
  /** Slow idle sway amplitude in degrees. */
  sway: number;
  /** Vertical offset of the look target, in cells. */
  targetY: number;
}

export const DEFAULT_CAMERA_PRESET: CameraPreset = { pitch: 4, yaw: 0, sway: 0.6, targetY: 0 };

const MAX_PITCH = 12;
const MAX_YAW = 14;

/**
 * Frames the board (plus hold/next pods) for any aspect ratio. User zoom is clamped so the
 * whole playfield remains visible. Adds beat emphasis, event push-ins and trauma shake.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  settings: CameraSettings = { zoom: 1, distance: 0, fov: 42, shake: true, shakeIntensity: 0.6, movementIntensity: 0.7, reducedMotion: false };
  preset: CameraPreset = DEFAULT_CAMERA_PRESET;
  private presetFrom: CameraPreset = DEFAULT_CAMERA_PRESET;
  private presetBlend = 1;
  private trauma = 0;
  private push = 0;
  private aspect = 16 / 9;
  private readonly target = new Vector3();
  private readonly frameWidth: number;
  private readonly frameHeight: number;

  constructor(frameWidth: number, frameHeight: number) {
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.camera = new PerspectiveCamera(42, 16 / 9, 0.1, 2000);
  }

  setAspect(aspect: number): void {
    this.aspect = Math.max(0.3, aspect);
    this.camera.aspect = this.aspect;
  }

  /** Smoothly blends to a new stage preset over ~1.5 s. */
  transitionTo(preset: CameraPreset): void {
    this.presetFrom = this.currentPreset();
    this.preset = preset;
    this.presetBlend = 0;
  }

  private currentPreset(): CameraPreset {
    const t = MathUtils.smootherstep(this.presetBlend, 0, 1);
    const a = this.presetFrom;
    const b = this.preset;
    return {
      pitch: MathUtils.lerp(a.pitch, b.pitch, t),
      yaw: MathUtils.lerp(a.yaw, b.yaw, t),
      sway: MathUtils.lerp(a.sway, b.sway, t),
      targetY: MathUtils.lerp(a.targetY, b.targetY, t),
    };
  }

  /** Adds screen shake (0..1); scaled by settings, ignored under reduced motion. */
  addTrauma(amount: number): void {
    if (!this.settings.shake || this.settings.reducedMotion) return;
    this.trauma = Math.min(1, this.trauma + amount * this.settings.shakeIntensity);
  }

  /** A short dolly-in for big moments (QUAD, perfect clear). */
  addPush(amount: number): void {
    if (this.settings.reducedMotion) return;
    this.push = Math.min(1, this.push + amount * this.settings.movementIntensity);
  }

  /** Distance at which the full frame (board + pods) fits with the given margin. */
  fitDistance(fovDeg: number, margin: number): number {
    const tanHalf = Math.tan(MathUtils.degToRad(fovDeg) / 2);
    const dh = ((this.frameHeight / 2) * margin) / tanHalf;
    const dw = ((this.frameWidth / 2) * margin) / (tanHalf * this.aspect);
    return Math.max(dh, dw);
  }

  update(dt: number, time: number, beatPulse: number): void {
    const s = this.settings;
    this.presetBlend = Math.min(1, this.presetBlend + dt / 1.5);
    const preset = this.currentPreset();
    const fov = MathUtils.clamp(s.fov, 30, 70);
    this.camera.fov = fov;
    // Fit with comfortable margin, then apply zoom; never closer than the tight fit.
    const comfortable = this.fitDistance(fov, 1.1);
    const tight = this.fitDistance(fov, 1.0);
    let dist = Math.max(tight, comfortable / MathUtils.clamp(s.zoom, 0.8, 1.25)) + s.distance;
    const motion = s.reducedMotion ? 0 : s.movementIntensity;
    dist *= 1 - beatPulse * 0.006 * motion - this.push * 0.035;

    const pitch = MathUtils.clamp(preset.pitch, -MAX_PITCH, MAX_PITCH);
    const swayYaw = Math.sin(time * 0.13) * preset.sway * motion;
    const swayPitch = Math.sin(time * 0.09 + 1.3) * preset.sway * 0.5 * motion;
    const yaw = MathUtils.clamp(preset.yaw + swayYaw, -MAX_YAW, MAX_YAW);
    const pr = MathUtils.degToRad(pitch + swayPitch);
    const yr = MathUtils.degToRad(yaw);
    this.target.set(0, preset.targetY, 0);
    this.camera.position.set(Math.sin(yr) * Math.cos(pr) * dist, preset.targetY + Math.sin(pr) * dist, Math.cos(yr) * Math.cos(pr) * dist);

    // Trauma shake (squared for a natural falloff), applied as small offsets.
    if (this.trauma > 0) {
      const k = this.trauma * this.trauma;
      const n = (f: number, o: number) => Math.sin(time * f + o) * Math.sin(time * f * 0.61 + o * 2.3);
      this.camera.position.x += n(47, 0.1) * 0.12 * k;
      this.camera.position.y += n(53, 1.7) * 0.12 * k;
      this.target.x += n(41, 2.9) * 0.05 * k;
      this.trauma = Math.max(0, this.trauma - dt * 1.8);
    }
    this.push = Math.max(0, this.push - dt * 2.2);
    this.camera.lookAt(this.target);
    this.camera.near = Math.max(0.1, dist * 0.05);
    this.camera.far = dist * 60 + 500;
    this.camera.updateProjectionMatrix();
  }
}
