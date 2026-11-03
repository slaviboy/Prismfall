import { renderCrack, renderRainTexture, renderThunder, type CrackSpec, type RainSurface, type StereoBuffer, type ThunderSpec } from './stormSynth';

/** One storm sound to synthesise: a thunder, a crack or a rain loop. */
export type StormRenderJob =
  | { readonly kind: 'thunder'; readonly spec: ThunderSpec }
  | { readonly kind: 'crack'; readonly spec: CrackSpec }
  | { readonly kind: 'rain'; readonly surface: RainSurface; readonly seconds: number; readonly seed: number; readonly sampleRate: number }
  | { readonly kind: 'noise'; readonly color: 'white' | 'pink' | 'brown'; readonly seconds: number; readonly seed: number; readonly sampleRate: number };

export type StormWorkerRequest = { readonly id: number; readonly job: StormRenderJob };
export type StormWorkerResponse = { readonly id: number; readonly left: Float32Array; readonly right: Float32Array; readonly sampleRate: number; readonly ms: number } | { readonly id: number; readonly error: string };

/** Renders one storm sound job (shared by the worker and the main-thread fallback). */
export function renderStormJob(job: StormRenderJob): StereoBuffer {
  if (job.kind === 'thunder') return renderThunder(job.spec);
  if (job.kind === 'crack') return renderCrack(job.spec);
  if (job.kind === 'noise') return renderNoise(job.color, job.seconds, job.seed, job.sampleRate);
  return renderRainTexture(job.surface, job.seconds, job.seed, job.sampleRate);
}

/**
 * Long stereo noise loops for the weather beds (independent left and right, longer than the
 * shared two-second noise so filtered rain and wind never audibly repeat). Pink by Paul Kellet's
 * filter, brown by a leaky integrator; the loop seam is crossfaded.
 */
export function renderNoise(color: 'white' | 'pink' | 'brown', seconds: number, seed: number, sampleRate: number): StereoBuffer {
  const n = Math.round(seconds * sampleRate);
  const make = (ch: number): Float32Array => {
    const x = new Float32Array(n);
    let s = (seed * 2654435761 + ch * 40503 + 1) >>> 0 || 1;
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const w = ((s >>> 0) / 4294967296) * 2 - 1;
      if (color === 'white') x[i] = w * 0.5;
      else if (color === 'brown') {
        br = (br + w * 0.02) * 0.998;
        x[i] = br * 3.2;
      } else {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
    // Crossfade the last 80 ms into the start so the loop has no seam.
    const f = Math.min(n >> 2, Math.round(0.08 * sampleRate));
    for (let i = 0; i < f; i++) {
      const k = i / f;
      x[i] = x[i]! * k + x[n - f + i]! * (1 - k);
    }
    return x.subarray(0, n - f).slice();
  };
  return { left: make(0), right: make(1), sampleRate };
}
