/**
 * Geometry of the Warden's gaze (pure TypeScript, shared by the controller test and the world):
 * beam directions, where a beam meets the land, and which directions are allowed. The beam must
 * never point at the viewer and never light anything inside the clear zone around the board.
 */

export type Vec3 = readonly [number, number, number];

const DEG = Math.PI / 180;

/** Unit beam direction for a heading (from -Z towards +X) and a pitch (up). */
export function beamDirection(heading: number, pitch: number): [number, number, number] {
  const c = Math.cos(pitch);
  return [c * Math.sin(heading), Math.sin(pitch), -c * Math.cos(heading)];
}

/** Heading and pitch of the direction from a to b. */
export function gazeTowards(a: Vec3, b: Vec3): { heading: number; pitch: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return { heading: Math.atan2(dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** View azimuth (degrees right of the view axis -Z) and elevation of a point seen from the eye. */
export function viewAngles(eye: Vec3, p: Vec3): { azimuth: number; elevation: number } {
  const dx = p[0] - eye[0];
  const dy = p[1] - eye[1];
  const dz = p[2] - eye[2];
  return { azimuth: Math.atan2(dx, -dz) / DEG, elevation: Math.atan2(dy, Math.hypot(dx, dz)) / DEG };
}

/** Angle (degrees) between a direction from the eye and the view axis. */
export function offAxis(eye: Vec3, p: Vec3): number {
  const dx = p[0] - eye[0];
  const dy = p[1] - eye[1];
  const dz = p[2] - eye[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  return Math.acos(Math.min(1, Math.max(-1, -dz / l))) / DEG;
}

/** Where a beam from `origin` meets the plane y = ground, or the point `far` metres out. */
export function beamEnd(origin: Vec3, heading: number, pitch: number, ground: number, far: number): { point: [number, number, number]; distance: number; hits: boolean } {
  const d = beamDirection(heading, pitch);
  let t = far;
  let hits = false;
  if (d[1] < -1e-4) {
    const tg = (ground - origin[1]) / d[1];
    if (tg > 0 && tg < far) {
      t = tg;
      hits = true;
    }
  }
  return { point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t], distance: t, hits };
}

export interface GazeRules {
  /** The Warden's core. */
  readonly origin: Vec3;
  /** The viewer's eye. */
  readonly eye: Vec3;
  /** Approximate land height for beam ends. */
  readonly ground: number;
  /** Beam reach when it does not meet the land. */
  readonly far: number;
  /** Minimum angle (degrees) between the beam and the direction to the viewer. */
  readonly minSeparation: number;
  /** Nothing the beam lights may come within this angle (degrees) of the view axis. */
  readonly clearZone: number;
  /** Pitch limits (degrees). */
  readonly pitch: readonly [number, number];
}

/** Builds the allowed-direction test for the Warden's controller. */
export function gazeRules(r: GazeRules): (heading: number, pitch: number) => boolean {
  const toEye = [r.eye[0] - r.origin[0], r.eye[1] - r.origin[1], r.eye[2] - r.origin[2]];
  const l = Math.hypot(toEye[0]!, toEye[1]!, toEye[2]!);
  const e = toEye.map((v) => v / l) as [number, number, number];
  const minDot = Math.cos(r.minSeparation * DEG);
  return (heading: number, pitch: number) => {
    if (pitch < r.pitch[0] * DEG || pitch > r.pitch[1] * DEG) return false;
    const d = beamDirection(heading, pitch);
    if (d[0] * e[0] + d[1] * e[1] + d[2] * e[2] > minDot) return false;
    // Sample along the beam: no lit point may sit in the clear zone around the board.
    const end = beamEnd(r.origin, heading, pitch, r.ground, r.far);
    for (let i = 1; i <= 8; i++) {
      const t = (end.distance * i) / 8;
      const p: Vec3 = [r.origin[0] + d[0] * t, r.origin[1] + d[1] * t, r.origin[2] + d[2] * t];
      if (offAxis(r.eye, p) < r.clearZone) return false;
    }
    return true;
  };
}
