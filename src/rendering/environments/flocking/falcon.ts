import type { Threat, Vec3 } from './boids';

export interface FalconConfig {
  /** Mean seconds between attacks (at rate 1). */
  every: number;
  /** Speed at the bottom of the stoop (m/s). */
  stoopSpeed: number;
  /** Speed while climbing away (m/s). */
  cruiseSpeed: number;
  /** Flight distance the flock reacts to (m). */
  radius: number;
  /** Height above the flock the stoop starts from (m). */
  above: number;
  /** Horizontal unit direction the falcon arrives from and leaves towards (away from the board). */
  side: Vec3;
  seed: number;
}

export type FalconPhase = 'away' | 'stoop' | 'pass' | 'exit';

/** Where a parked falcon waits (far below the world, never drawn on screen). */
export const FALCON_PARK: Vec3 = [0, -10000, 0];

/**
 * A peregrine that now and then stoops on the flock: it appears high above and to the outer side,
 * dives at the flock's centre (slightly off-centre, so it slices through part of it), carries
 * straight on through, then climbs away out of view until the next attack. While it dives and
 * passes it is a threat the boids flee from, which starts their escape waves.
 */
export class Falcon {
  phase: FalconPhase = 'away';
  readonly pos: Vec3 = [...FALCON_PARK];
  readonly vel: Vec3 = [0, 0, -1];
  private timer: number;
  private phaseTime = 0;
  private readonly aim: Vec3 = [0, 0, 0];
  private s: number;

  constructor(private readonly config: FalconConfig) {
    this.s = config.seed >>> 0 || 1;
    // The first attack comes after a calm spell.
    this.timer = config.every * (0.6 + 0.5 * this.rand());
  }

  private rand(): number {
    this.s = (Math.imul(this.s ^ (this.s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    this.s ^= this.s >>> 13;
    return (this.s >>> 0) / 4294967296;
  }

  /** Seconds until the next attack starts (while away). */
  get countdown(): number {
    return this.phase === 'away' ? this.timer : 0;
  }

  /** Starts an attack now (inspection, tests). */
  trigger(): void {
    if (this.phase === 'away') this.timer = 0;
  }

  /**
   * Advances the falcon. `rate` scales how often attacks come (1 = every `every` seconds on average).
   * Writes the threat the flock should react to.
   */
  update(dt: number, centroid: Vec3, flockVel: Vec3, rate: number, threat: Threat): void {
    const c = this.config;
    this.phaseTime += dt;
    if (this.phase === 'away') {
      threat.active = false;
      if (c.every <= 0) return;
      this.timer -= dt * Math.max(0, rate);
      if (this.timer > 0) return;
      // Appear high above and to the outer side, a little ahead of the flock.
      const lateral = 18 + 14 * this.rand();
      this.pos[0] = centroid[0] + c.side[0] * lateral + flockVel[0] * 1.2;
      this.pos[1] = centroid[1] + c.above * (0.85 + 0.3 * this.rand());
      this.pos[2] = centroid[2] + c.side[2] * lateral + flockVel[2] * 1.2;
      // Aim a few metres off the centre so it slices through one side of the flock.
      this.aim[0] = (this.rand() - 0.5) * 10;
      this.aim[1] = (this.rand() - 0.5) * 3;
      this.aim[2] = (this.rand() - 0.5) * 10;
      const d = this.towards(centroid, flockVel);
      const s = c.stoopSpeed * 0.55;
      this.vel[0] = d[0] * s;
      this.vel[1] = d[1] * s;
      this.vel[2] = d[2] * s;
      this.phase = 'stoop';
      this.phaseTime = 0;
    }
    if (this.phase === 'stoop') {
      // Accelerate down the dive, turning (with a limited rate) to meet the flock.
      const d = this.towards(centroid, flockVel);
      const speed = Math.min(c.stoopSpeed, Math.hypot(this.vel[0], this.vel[1], this.vel[2]) + 14 * dt);
      this.turn(d, 2.2 * dt, speed);
      const tx = centroid[0] + this.aim[0] - this.pos[0];
      const ty = centroid[1] + this.aim[1] - this.pos[1];
      const tz = centroid[2] + this.aim[2] - this.pos[2];
      if (Math.hypot(tx, ty, tz) < 6 || this.phaseTime > 8) {
        this.phase = 'pass';
        this.phaseTime = 0;
      }
    } else if (this.phase === 'pass') {
      // Carry straight on through the flock, levelling out.
      this.vel[1] *= Math.exp(-dt * 1.5);
      if (this.phaseTime > 1.1) {
        this.phase = 'exit';
        this.phaseTime = 0;
      }
    } else if (this.phase === 'exit') {
      // Climb away to the outer side, out of view.
      const ex = c.side[0];
      const ez = c.side[2];
      const len = Math.hypot(ex, 0.8, ez);
      this.turn([ex / len, 0.8 / len, ez / len], 1.6 * dt, c.cruiseSpeed);
      if (this.phaseTime > 6) {
        this.phase = 'away';
        this.phaseTime = 0;
        this.timer = c.every * (0.5 + this.rand());
        this.pos[0] = FALCON_PARK[0];
        this.pos[1] = FALCON_PARK[1];
        this.pos[2] = FALCON_PARK[2];
        threat.active = false;
        return;
      }
    }
    this.pos[0] += this.vel[0] * dt;
    this.pos[1] += this.vel[1] * dt;
    this.pos[2] += this.vel[2] * dt;
    threat.active = this.phase === 'stoop' || this.phase === 'pass' || (this.phase === 'exit' && this.phaseTime < 0.6);
    threat.x = this.pos[0];
    threat.y = this.pos[1];
    threat.z = this.pos[2];
    threat.radius = c.radius;
    threat.strength = 1;
  }

  private towards(centroid: Vec3, flockVel: Vec3): Vec3 {
    const x = centroid[0] + flockVel[0] * 0.5 + this.aim[0] - this.pos[0];
    const y = centroid[1] + flockVel[1] * 0.5 + this.aim[1] - this.pos[1];
    const z = centroid[2] + flockVel[2] * 0.5 + this.aim[2] - this.pos[2];
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }

  /** Turns the velocity towards a unit direction by at most `maxAngle`, at the given speed. */
  private turn(dir: Vec3, maxAngle: number, speed: number): void {
    const v = this.vel;
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    const fx = v[0] / l;
    const fy = v[1] / l;
    const fz = v[2] / l;
    const cos = Math.max(-1, Math.min(1, fx * dir[0] + fy * dir[1] + fz * dir[2]));
    const angle = Math.acos(cos);
    const t = angle <= maxAngle || angle < 1e-6 ? 1 : maxAngle / angle;
    let nx = fx + (dir[0] - fx) * t;
    let ny = fy + (dir[1] - fy) * t;
    let nz = fz + (dir[2] - fz) * t;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    v[0] = nx * speed;
    v[1] = ny * speed;
    v[2] = nz * speed;
  }
}
