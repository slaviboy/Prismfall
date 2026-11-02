import { describe, expect, it } from 'vitest';
import { estimateOffset } from './LatencyCalibrator';

describe('latency calibration estimate', () => {
  it('needs enough taps', () => {
    expect(estimateOffset([10, 12, 11])).toBeNull();
  });

  it('takes the median, so a few stray taps do not move the result', () => {
    const deltas = [31, 29, 35, 28, 33, 30, 32, 120, -90, 30, 31];
    const r = estimateOffset(deltas);
    expect(r?.offsetMs).toBe(31);
    expect(r?.spreadMs).toBeLessThanOrEqual(3);
    expect(r?.count).toBe(11);
  });

  it('reports uneven tapping as a large spread', () => {
    const r = estimateOffset([0, 80, -60, 40, -20, 100, -90, 10, 60]);
    expect(r?.spreadMs).toBeGreaterThan(40);
  });
});
