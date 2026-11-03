/**
 * A radial profile of a planetary ring system modelled on Saturn's measured structure (ring
 * edges in km from the planet's centre): the faint C ring, the dense bright B ring, the Cassini
 * Division, the A ring with the Encke and Keeler gaps, and the thin F ring, with fine ringlet
 * variation from layered noise. Values are colour (albedo, rgb) and optical opacity (a).
 */
export const SATURN_RING_KM = { inner: 74_658, outer: 140_400 } as const;

interface Zone {
  readonly from: number;
  readonly to: number;
  /** Opacity at the zone's start and end. */
  readonly tau: readonly [number, number];
  readonly color: readonly [number, number, number];
  /** Strength of fine ringlet variation. */
  readonly ringlets: number;
}

const ZONES: readonly Zone[] = [
  { from: 74_658, to: 92_000, tau: [0.04, 0.14], color: [0.46, 0.43, 0.4], ringlets: 0.6 }, // C ring
  { from: 92_000, to: 99_000, tau: [0.55, 0.78], color: [0.78, 0.7, 0.58], ringlets: 0.25 }, // inner B
  { from: 99_000, to: 117_580, tau: [0.9, 0.96], color: [0.86, 0.77, 0.63], ringlets: 0.18 }, // B ring core
  { from: 117_580, to: 122_170, tau: [0.04, 0.08], color: [0.5, 0.47, 0.43], ringlets: 0.9 }, // Cassini Division
  { from: 122_170, to: 133_420, tau: [0.62, 0.5], color: [0.76, 0.7, 0.6], ringlets: 0.2 }, // A ring
  { from: 133_420, to: 133_745, tau: [0, 0], color: [0.5, 0.47, 0.43], ringlets: 0 }, // Encke gap
  { from: 133_745, to: 136_485, tau: [0.48, 0.42], color: [0.74, 0.68, 0.59], ringlets: 0.2 }, // outer A
  { from: 136_485, to: 136_527, tau: [0, 0], color: [0.5, 0.47, 0.43], ringlets: 0 }, // Keeler gap
  { from: 136_527, to: 136_775, tau: [0.38, 0.3], color: [0.72, 0.66, 0.58], ringlets: 0.1 },
];

const F_RING = { center: 140_180, width: 60, tau: 0.35 } as const;

/** Deterministic smooth 1D value noise in [-1, 1]. */
function noise1(x: number, seed: number): number {
  const hash = (i: number): number => {
    const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const i = Math.floor(x);
  const f = x - i;
  const t = f * f * (3 - 2 * f);
  return hash(i) * (1 - t) + hash(i + 1) * t;
}

/** RGBA samples (length `samples` * 4) across SATURN_RING_KM, inner edge first. */
export function saturnRingProfile(samples: number, seed = 1): Float32Array {
  const out = new Float32Array(samples * 4);
  const span = SATURN_RING_KM.outer - SATURN_RING_KM.inner;
  for (let i = 0; i < samples; i++) {
    const km = SATURN_RING_KM.inner + ((i + 0.5) / samples) * span;
    let tau = 0;
    let color: readonly [number, number, number] = [0.5, 0.47, 0.43];
    const zone = ZONES.find((z) => km >= z.from && km < z.to);
    if (zone) {
      const t = (km - zone.from) / (zone.to - zone.from);
      tau = zone.tau[0] + (zone.tau[1] - zone.tau[0]) * t;
      // Ringlets on several scales (tens to thousands of km).
      const n = noise1(km / 1800, seed) * 0.5 + noise1(km / 420, seed + 1) * 0.32 + noise1(km / 95, seed + 2) * 0.18;
      tau *= Math.max(0, 1 + n * zone.ringlets * 1.6);
      // Soft zone edges (a few hundred km) except at the sharp gaps.
      const edge = Math.min(km - zone.from, zone.to - km);
      if (zone.tau[0] > 0) tau *= Math.min(1, 0.35 + edge / 300);
      color = zone.color;
    }
    const f = Math.exp(-(((km - F_RING.center) / F_RING.width) ** 2));
    tau = Math.max(tau, F_RING.tau * f);
    const shade = 1 + noise1(km / 260, seed + 3) * 0.06;
    out[i * 4] = color[0] * shade;
    out[i * 4 + 1] = color[1] * shade;
    out[i * 4 + 2] = color[2] * shade;
    out[i * 4 + 3] = Math.min(0.98, Math.max(0, tau));
  }
  return out;
}
