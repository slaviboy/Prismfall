import { describe, expect, it } from 'vitest';
import { IMPACT_CEILING_DB, renderGrains, renderImpact } from './impactSynth';
import { MATERIAL_PROFILES, resolveMaterialAudio, withOverrides } from './materialAudio';

const SR = 48000;

function stats(s: { left: Float32Array; right: Float32Array }): { peak: number; rms: number; dc: number; nan: boolean } {
  let peak = 0;
  let sum = 0;
  let dc = 0;
  let nan = false;
  for (const d of [s.left, s.right]) {
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!;
      if (!Number.isFinite(v)) nan = true;
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
      dc += v;
    }
  }
  const n = s.left.length * 2;
  return { peak, rms: Math.sqrt(sum / n), dc: dc / n, nan };
}

/** Energy in the first `ms` milliseconds relative to the whole sound. */
function attackShare(s: { left: Float32Array }, ms: number): number {
  const n = Math.round((ms / 1000) * SR);
  let head = 0;
  let all = 0;
  for (let i = 0; i < s.left.length; i++) {
    const e = s.left[i]! ** 2;
    all += e;
    if (i < n) head += e;
  }
  return head / Math.max(1e-12, all);
}

describe('material impact synthesis', () => {
  it('renders every built-in material cleanly under the ceiling', () => {
    const ceiling = Math.pow(10, IMPACT_CEILING_DB / 20) + 1e-6;
    for (const [name, profile] of Object.entries(MATERIAL_PROFILES)) {
      for (const strength of [0.2, 0.6, 1]) {
        const out = renderImpact(profile, strength, 3, SR);
        const st = stats(out);
        expect(st.nan, name).toBe(false);
        expect(st.peak, name).toBeLessThanOrEqual(ceiling);
        expect(st.peak, name).toBeGreaterThan(0.01);
        expect(Math.abs(st.dc), name).toBeLessThan(0.002);
        expect(out.left.length / SR, name).toBeLessThan(2.7);
      }
    }
  });

  it('is deterministic per seed and varies between seeds', () => {
    const p = MATERIAL_PROFILES.sandstone!;
    const a = renderImpact(p, 0.8, 1, SR);
    const b = renderImpact(p, 0.8, 1, SR);
    const c = renderImpact(p, 0.8, 2, SR);
    expect(Array.from(a.left.slice(0, 2000))).toEqual(Array.from(b.left.slice(0, 2000)));
    let diff = 0;
    for (let i = 0; i < 4000; i++) diff += Math.abs(a.left[i]! - c.left[i]!);
    expect(diff).toBeGreaterThan(1);
  });

  it('makes harder hits louder before normalisation headroom kicks in', () => {
    const p = { ...MATERIAL_PROFILES.wood!, gain: 0.3 };
    const soft = stats(renderImpact(p, 0.2, 5, SR));
    const hard = stats(renderImpact(p, 1, 5, SR));
    expect(hard.rms).toBeGreaterThan(soft.rms * 1.5);
  });

  it('gives sand a long granular tail and wood a short knock', () => {
    const sand = renderImpact(MATERIAL_PROFILES.sandstone!, 1, 9, SR);
    const wood = renderImpact(MATERIAL_PROFILES.wood!, 1, 9, SR);
    expect(attackShare(sand, 60)).toBeLessThan(attackShare(wood, 60));
  });

  it('renders signature and response overrides', () => {
    const p = MATERIAL_PROFILES.sandstone!;
    const sig = renderImpact(withOverrides(p, p.signature), 1, 4, SR);
    expect(sig.left.length / SR).toBeGreaterThan(1.5);
    const resp = stats(renderImpact(withOverrides(p, p.response), 0.8, 4, SR));
    expect(resp.peak).toBeGreaterThan(0.005);
  });

  it('renders light grains for soft drops', () => {
    const g = stats(renderGrains(MATERIAL_PROFILES.ice!, 3, 0.04, 1, SR, 0.4));
    expect(g.nan).toBe(false);
    expect(g.peak).toBeGreaterThan(0.001);
  });

  it('resolves names, inline profiles and unknown names', () => {
    expect(resolveMaterialAudio('ice')).toBe(MATERIAL_PROFILES.ice);
    expect(resolveMaterialAudio('nope')).toBe(MATERIAL_PROFILES.glass);
    expect(resolveMaterialAudio({ body: { baseHz: 99 } }).body.baseHz).toBe(99);
  });
});
