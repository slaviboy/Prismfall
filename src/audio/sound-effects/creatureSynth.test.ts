import { describe, expect, it } from 'vitest';
import { renderCrawl, renderSilk, renderSkitter, renderWebHum, WEB_HUM_HZ } from './creatureSynth';
import { Biquad, IMPACT_CEILING_DB, type StereoSamples } from './impactSynth';
import { CREATURE_WEIGHTS, MATERIAL_JOBS, SHARED_JOB_IDS } from './materialJobs';
import { MATERIAL_PROFILES } from './materialAudio';

const SR = 48000;

function stats(s: StereoSamples): { peak: number; dc: number; nan: boolean } {
  let peak = 0;
  let dc = 0;
  let nan = false;
  for (const d of [s.left, s.right]) {
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!;
      if (!Number.isFinite(v)) nan = true;
      peak = Math.max(peak, Math.abs(v));
      dc += v;
    }
  }
  return { peak, dc: dc / (s.left.length * 2), nan };
}

/** Share of the left channel's energy below `hz` (low-pass) or above it (high-pass). */
function share(s: StereoSamples, type: 'lowpass' | 'highpass', hz: number): number {
  const f = new Biquad(type, hz, 0.7, SR);
  let part = 0;
  let all = 0;
  for (let i = 0; i < s.left.length; i++) {
    const v = s.left[i]!;
    part += f.process(v) ** 2;
    all += v * v;
  }
  return part / Math.max(1e-12, all);
}

/** Power of the left channel at `hz` over its first `seconds` (Goertzel). */
function power(s: StereoSamples, hz: number, seconds: number): number {
  const n = Math.min(s.left.length, Math.round(seconds * SR));
  const k = 2 * Math.cos((2 * Math.PI * hz) / SR);
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const c = s.left[i]! + k * a - b;
    b = a;
    a = c;
  }
  return a * a + b * b - k * a * b;
}

describe('creature sounds', () => {
  it('render cleanly under the ceiling and audibly, for every variant', () => {
    const ceiling = Math.pow(10, IMPACT_CEILING_DB / 20) + 1e-6;
    for (const id of SHARED_JOB_IDS) {
      const job = MATERIAL_JOBS[id]!;
      for (let v = 0; v < job.variants; v++) {
        const out = job.render(MATERIAL_PROFILES.glass!, v + 1, SR)!;
        const st = stats(out);
        expect(st.nan, `${id}/${v}`).toBe(false);
        expect(st.peak, `${id}/${v}`).toBeLessThanOrEqual(ceiling);
        expect(20 * Math.log10(st.peak), `${id}/${v} audible`).toBeGreaterThan(-30);
        expect(Math.abs(st.dc), `${id}/${v}`).toBeLessThan(0.002);
        expect(out.left.length / SR, `${id}/${v}`).toBeLessThan(2.5);
      }
    }
  });

  it('ignore the block material', () => {
    for (const id of SHARED_JOB_IDS) {
      const a = MATERIAL_JOBS[id]!.render(MATERIAL_PROFILES.glass!, 1, SR)!;
      const b = MATERIAL_JOBS[id]!.render(MATERIAL_PROFILES.obsidian!, 1, SR)!;
      expect(Array.from(a.left.slice(0, 4000)), id).toEqual(Array.from(b.left.slice(0, 4000)));
    }
  });

  it('are deterministic per seed and vary between seeds', () => {
    for (const render of [(s: number) => renderSkitter(0.5, s, SR), (s: number) => renderCrawl(0.5, s, SR), (s: number) => renderSilk(s, SR), (s: number) => renderWebHum(s, SR)]) {
      const a = render(1);
      const b = render(1);
      const c = render(2);
      expect(Array.from(a.left.slice(0, 3000))).toEqual(Array.from(b.left.slice(0, 3000)));
      const n = Math.min(a.left.length, c.left.length);
      let diff = 0;
      for (let i = 0; i < n; i++) diff += Math.abs(a.left[i]! - c.left[i]!);
      expect(diff).toBeGreaterThan(0.1);
    }
  });

  it('a skitter is bright and its ticks come irregularly, never as a steady click track', () => {
    for (const seed of [1, 2, 3, 4]) {
      const s = renderSkitter(0.4, seed, SR);
      expect(share(s, 'highpass', 2000)).toBeGreaterThan(0.6);
      // Tick onsets: 1 ms frames whose peak jumps well above the frame before (4 ms apart at least).
      const frame = Math.round(SR * 0.001);
      const frames: number[] = [];
      for (let i = 0; i + frame <= s.left.length; i += frame) {
        let m = 0;
        for (let j = i; j < i + frame; j++) m = Math.max(m, Math.abs(s.left[j]!) + Math.abs(s.right[j]!));
        frames.push(m);
      }
      const top = Math.max(...frames);
      const onsets: number[] = [];
      for (let f = 1; f < frames.length; f++) {
        if (frames[f]! > top * 0.2 && frames[f]! > frames[f - 1]! * 2 && (onsets.length === 0 || f / 1000 - onsets[onsets.length - 1]! >= 0.004)) onsets.push(f / 1000);
      }
      expect(onsets.length, `seed ${seed} ticks`).toBeGreaterThanOrEqual(4);
      const gaps = onsets.slice(1).map((t, i) => t - onsets[i]!);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
      expect(sd / mean, `seed ${seed} interval spread`).toBeGreaterThan(0.3);
    }
  });

  it('a heavier crawl is deeper and carries less claw than a light one', () => {
    let lightLow = 0;
    let heavyLow = 0;
    let lightHigh = 0;
    let heavyHigh = 0;
    for (const seed of [1, 2, 3]) {
      const light = renderCrawl(0.1, seed, SR);
      const heavy = renderCrawl(1, seed, SR);
      lightLow += share(light, 'lowpass', 150);
      heavyLow += share(heavy, 'lowpass', 150);
      lightHigh += share(light, 'highpass', 2000);
      heavyHigh += share(heavy, 'highpass', 2000);
    }
    expect(heavyLow).toBeGreaterThan(lightLow);
    expect(lightHigh).toBeGreaterThan(heavyHigh * 2);
    // The variants the bank renders run light to heavy.
    expect([...CREATURE_WEIGHTS]).toEqual([...CREATURE_WEIGHTS].sort((a, b) => a - b));
  });

  it('a web hum rings at its rendered pitch and fades', () => {
    for (const seed of [1, 2, 3]) {
      const s = renderWebHum(seed, SR);
      const on = power(s, WEB_HUM_HZ, 0.5);
      expect(on, `seed ${seed}`).toBeGreaterThan(power(s, WEB_HUM_HZ * 0.94, 0.5) * 4);
      expect(on, `seed ${seed}`).toBeGreaterThan(power(s, WEB_HUM_HZ * 1.06, 0.5) * 4);
      const tail = s.left.slice(s.left.length - Math.round(0.3 * SR));
      const head = s.left.slice(0, Math.round(0.3 * SR));
      const e = (d: Float32Array): number => d.reduce((a, v) => a + v * v, 0);
      expect(e(tail)).toBeLessThan(e(head) / 100);
    }
  });

  it('silk is soft and airy (mostly above 1 kHz, quieter than a crawl)', () => {
    const silk = renderSilk(1, SR);
    const crawl = renderCrawl(1, 1, SR);
    expect(share(silk, 'highpass', 1000)).toBeGreaterThan(0.7);
    expect(stats(silk).peak).toBeLessThan(stats(crawl).peak);
  });
});
