import { seeded } from '@prismfall/sdk';

/**
 * The reusable optical-sensor controller every Red Horizon machine uses (humanoid heads, drone
 * turrets, the colossus gondola).
 *
 * A sensor is a little state machine driving a yaw/pitch pair (relative to its mount) through a
 * critically damped spring, plus a focus and a brightness:
 *
 *  - scan:  a slow sweep across a sector of its field;
 *  - hold:  a pause at the end of a sweep (the optics settle);
 *  - focus: it stops on a spot, the lens racks in (focus 0 to 1) and brightens a little;
 *  - track: something happened (an explosion, a spark shower): a quick saccade towards it, a long
 *           stare with the lens focused, then back to scanning;
 *  - turn:  a fast re-aim to a new sector (an occasional large head turn).
 *
 * Springs are stiff for saccades and soft for sweeps, so motion reads as servo-driven optics rather
 * than smooth camera pans. Everything is seeded, so two sensors never move in step, and nothing is
 * tied to the music beat.
 */

export interface SensorConfig {
  /** Yaw and pitch limits (radians) relative to the mount; positive yaw turns left, positive pitch up. */
  yaw: [number, number];
  pitch: [number, number];
  /** Sweep speed (radians per second). */
  scanSpeed: number;
  /** Pause range (seconds) at the end of a sweep. */
  pause: [number, number];
  /** Chance that a pause becomes a focus on a spot. */
  focusChance: number;
  /** Chance that the next sweep starts with a quick large re-aim. */
  turnChance: number;
  /** How far away (metres) events are still noticed, and how often (0..1). */
  hearing: number;
  curiosity: number;
  /** Preferred resting pitch (radians): ground scanners look down. */
  restPitch: number;
  seed: number;
}

export const DEFAULT_SENSOR: SensorConfig = {
  yaw: [-1.1, 1.1],
  pitch: [-0.45, 0.25],
  scanSpeed: 0.28,
  pause: [0.6, 2.4],
  focusChance: 0.35,
  turnChance: 0.2,
  hearing: 700,
  curiosity: 0.7,
  restPitch: -0.08,
  seed: 1,
};

type Mode = 'scan' | 'hold' | 'focus' | 'track' | 'turn';

export interface SensorEvent {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly t: number;
  readonly weight: number;
}

export class SensorController {
  yaw = 0;
  pitch = 0;
  /** 0 = wide, 1 = racked in on a spot. */
  focus = 0;
  /** Lens brightness 0..1 (power, focus and small refresh dips). */
  intensity = 0;
  /** 0 = powered down, 1 = live (boot-up and shutdown ramps). */
  power = 1;
  mode: Mode = 'hold';
  private vy = 0;
  private vp = 0;
  private ty = 0;
  private tp = 0;
  private timer = 0;
  private sweepTo = 0;
  private stiffness = 2.2;
  private lastEvent = -1e9;
  private refresh = 0;
  private readonly rand: () => number;
  readonly cfg: SensorConfig;

  constructor(cfg: Partial<SensorConfig> = {}) {
    this.cfg = { ...DEFAULT_SENSOR, ...cfg };
    this.rand = seeded(this.cfg.seed * 7919 + 101);
    this.ty = this.yaw = this.lerp(this.cfg.yaw[0], this.cfg.yaw[1], this.rand());
    this.tp = this.pitch = this.cfg.restPitch;
    this.timer = this.rand() * 2;
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private clampYaw(v: number): number {
    return Math.min(this.cfg.yaw[1], Math.max(this.cfg.yaw[0], v));
  }

  private clampPitch(v: number): number {
    return Math.min(this.cfg.pitch[1], Math.max(this.cfg.pitch[0], v));
  }

  private newSweep(): void {
    const r = this.rand;
    const span = (0.35 + r() * 0.65) * (this.cfg.yaw[1] - this.cfg.yaw[0]) * 0.5;
    const dir = this.yaw > (this.cfg.yaw[0] + this.cfg.yaw[1]) / 2 ? -1 : 1;
    this.sweepTo = this.clampYaw(this.yaw + dir * span);
    this.tp = this.clampPitch(this.cfg.restPitch + (r() - 0.5) * 0.35 * (this.cfg.pitch[1] - this.cfg.pitch[0]));
    if (r() < this.cfg.turnChance) {
      // A large re-aim first: a saccade to a far part of the field, then the sweep continues.
      this.mode = 'turn';
      this.ty = this.clampYaw(this.lerp(this.cfg.yaw[0], this.cfg.yaw[1], r()));
      this.stiffness = 7;
      this.timer = 0.7 + r() * 0.5;
    } else {
      this.mode = 'scan';
      this.stiffness = 2.2;
      this.timer = Math.abs(this.sweepTo - this.yaw) / Math.max(0.05, this.cfg.scanSpeed) + 0.2;
    }
  }

  /** Aims at a direction now (relative yaw and pitch) and stares for `hold` seconds. */
  look(yaw: number, pitch: number, hold: number): void {
    this.mode = 'track';
    this.ty = this.clampYaw(yaw);
    this.tp = this.clampPitch(pitch);
    this.stiffness = 9;
    this.timer = hold;
  }

  /**
   * Advances the sensor. `mount` is the sensor's world position and heading (radians, 0 = facing
   * -Z, positive turns left), used to turn towards fresh events.
   */
  update(dt: number, events: readonly SensorEvent[] = [], _now = 0, mount?: { x: number; y: number; z: number; heading: number }): void {
    const r = this.rand;
    dt = Math.min(0.1, dt);
    // Events: the newest unseen one in hearing range may pull the sensor round.
    if (mount && this.power > 0.5) {
      for (const e of events) {
        if (e.t <= this.lastEvent) continue;
        this.lastEvent = e.t;
        const dx = e.x - mount.x;
        const dz = e.z - mount.z;
        const dist = Math.hypot(dx, dz);
        if (dist > this.cfg.hearing || r() > this.cfg.curiosity * Math.min(1, e.weight)) continue;
        // Bearing relative to the mount: 0 = straight ahead (-Z), positive = to the left (-X side).
        const bearing = Math.atan2(-dx, -dz) - mount.heading;
        const rel = Math.atan2(Math.sin(bearing), Math.cos(bearing));
        if (rel < this.cfg.yaw[0] - 0.4 || rel > this.cfg.yaw[1] + 0.4) continue;
        const pitch = Math.atan2(e.y - mount.y, Math.max(1, dist));
        // A reaction delay: machines are not instantaneous.
        this.mode = 'track';
        this.timer = 2.5 + r() * 2.5;
        this.ty = this.clampYaw(rel);
        this.tp = this.clampPitch(pitch);
        this.stiffness = 6 + r() * 4;
      }
    }
    this.timer -= dt;
    switch (this.mode) {
      case 'scan':
        // Constant-rate sweep target, so the spring trails it like a servo.
        this.ty += Math.sign(this.sweepTo - this.ty) * Math.min(Math.abs(this.sweepTo - this.ty), this.cfg.scanSpeed * dt);
        this.focus = Math.max(0, this.focus - dt * 0.8);
        if (this.timer <= 0 || Math.abs(this.sweepTo - this.yaw) < 0.01) {
          this.mode = 'hold';
          this.timer = this.lerp(this.cfg.pause[0], this.cfg.pause[1], r());
          if (r() < this.cfg.focusChance) {
            this.mode = 'focus';
            this.timer += 1.2 + r() * 1.8;
            // A small correction onto the spot before racking in.
            this.ty = this.clampYaw(this.ty + (r() - 0.5) * 0.12);
            this.tp = this.clampPitch(this.tp + (r() - 0.5) * 0.08);
            this.stiffness = 5;
          }
        }
        break;
      case 'hold':
        this.focus = Math.max(0, this.focus - dt * 0.6);
        if (this.timer <= 0) this.newSweep();
        break;
      case 'focus':
      case 'track':
        this.focus = Math.min(1, this.focus + dt * 1.4);
        if (this.timer <= 0) {
          this.mode = 'hold';
          this.timer = 0.4 + r() * 0.6;
          this.stiffness = 2.2;
        }
        break;
      case 'turn':
        if (this.timer <= 0) {
          this.mode = 'scan';
          this.stiffness = 2.2;
          this.timer = Math.abs(this.sweepTo - this.ty) / Math.max(0.05, this.cfg.scanSpeed) + 0.2;
        }
        break;
    }
    // Critically damped springs (semi-implicit), stiffer for saccades.
    const k = this.stiffness * (this.power > 0.5 ? 1 : 0.3);
    const ay = k * k * (this.ty - this.yaw) - 2 * k * this.vy;
    const ap = k * k * (this.tp - this.pitch) - 2 * k * this.vp;
    this.vy += ay * dt;
    this.vp += ap * dt;
    this.yaw += this.vy * dt;
    this.pitch += this.vp * dt;
    // Brightness: live level, a lift while focused, and rare short refresh dips (no flicker).
    this.refresh -= dt;
    if (this.refresh < -6 - r() * 10) this.refresh = 0.25;
    const dip = this.refresh > 0 ? 0.55 + 0.45 * Math.cos((this.refresh / 0.25) * Math.PI) * 0.5 + 0.225 : 1;
    const target = this.power * (0.78 + this.focus * 0.22) * dip;
    this.intensity += (target - this.intensity) * Math.min(1, dt * 6);
  }
}
