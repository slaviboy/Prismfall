import { describe, expect, it } from 'vitest';
import garden from '../../../../content/stages/ancient-garden/stage.json';
import { seeded } from './common';
import {
  ABDOMEN_JOINTS,
  dragonflyBodyGeometry,
  dragonfliesComponent,
  dragonflyWingGeometry,
  minJerk,
  placeTerritories,
  slotClock,
  slotRate,
  territoryMargin,
  wingOutline,
} from './dragonflies';

const shipped = () => {
  const layer = garden.environment.layers.find((l) => l.type === 'dragonflies');
  expect(layer).toBeDefined();
  return dragonfliesComponent.schema.parse(layer?.params);
};

describe('dragonfly beats', () => {
  it('keep every hover point, glide, drift and dart hop outside the clear cone around the board', () => {
    const base = shipped();
    for (const seed of [1, 3, 5, 8, 42, 99]) {
      const p = { ...base, seed };
      const beats = placeTerritories(p, 12, seeded(p.seed * 7411 + 5));
      expect(beats).toHaveLength(12);
      for (const t of beats) {
        const m = territoryMargin(t.len);
        // The beat's far edge, where the cone is widest.
        const reachX = Math.abs(t.x) - t.hx - m.xz;
        const farZ = t.z - t.hz - m.xz;
        expect(reachX).toBeGreaterThan(p.area.clearance * (p.area.viewZ - farZ));
      }
    }
  });

  it('alternate sides and stay on screen at 16:9 where the beat fits', () => {
    const p = shipped();
    const beats = placeTerritories(p, 6, seeded(p.seed * 7411 + 5));
    const left = beats.filter((t) => t.x < 0).length;
    expect(Math.abs(left - (beats.length - left))).toBeLessThanOrEqual(1);
    for (const t of beats) {
      const d = p.area.viewZ - t.z;
      expect(t.hx).toBeLessThanOrEqual(0.1 * d * 1.15 + 1e-9);
      expect(t.len).toBeGreaterThanOrEqual(p.length[0]);
      expect(t.len).toBeLessThanOrEqual(p.length[1]);
      expect(Math.abs(t.x) / d).toBeLessThan(0.85);
    }
  });
});

describe('dragonfly flight', () => {
  it('darts on a minimum-jerk profile: leaves and arrives at rest', () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5, 6);
    const h = 1e-4;
    expect((minJerk(h) - minJerk(0)) / h).toBeLessThan(1e-3);
    expect((minJerk(1) - minJerk(1 - h)) / h).toBeLessThan(1e-3);
    let prev = 0;
    for (let s = 0.01; s <= 1; s += 0.01) {
      expect(minJerk(s)).toBeGreaterThanOrEqual(prev);
      prev = minJerk(s);
    }
  });

  it('runs a slot clock that never stops, with hovers from short to long pauses', () => {
    const p = shipped();
    for (const seed of [0.1, 0.37, 0.8]) {
      const slot = p.slot;
      // The rate is the true derivative and always positive.
      for (let t = 0; t < 200; t += 0.37) {
        const d = (slotClock(t + 1e-3, slot, seed) - slotClock(t - 1e-3, slot, seed)) / 2e-3;
        expect(slotRate(t, slot, seed)).toBeCloseTo(d, 3);
        expect(slotRate(t, slot, seed)).toBeGreaterThan(0.4 / slot);
      }
      // Slot lengths (time between darts) vary: some short, some long pauses.
      const ends: number[] = [];
      let k = Math.floor(slotClock(0, slot, seed));
      for (let t = 0; t < 600; t += 0.01) {
        const kk = Math.floor(slotClock(t, slot, seed));
        if (kk !== k) ends.push(t);
        k = kk;
      }
      const lengths = ends.slice(1).map((e, i) => e - (ends[i] as number));
      expect(Math.min(...lengths)).toBeGreaterThan(1.2);
      expect(Math.max(...lengths)).toBeLessThan(9);
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeGreaterThan(1.5);
    }
  });
});

describe('dragonfly anatomy', () => {
  it('has a one-unit body facing -Z with a ten-segment abdomen, cheap enough to instance', () => {
    const g = dragonflyBodyGeometry();
    const box = g.boundingBox!;
    expect(box.max.z - box.min.z).toBeGreaterThan(0.98);
    expect(box.max.z - box.min.z).toBeLessThan(1.08);
    // Head (wide eyes) in front, the slender abdomen behind.
    expect(box.min.z).toBeLessThan(-0.3);
    expect(box.max.x - box.min.x).toBeLessThan(0.22);
    expect(g.getAttribute('position').count).toBeLessThan(3000);
    expect(ABDOMEN_JOINTS).toHaveLength(10);
  });

  it('has four wings per blur copy; hind wings broader at the base, all rounded at the tip', () => {
    const copies = 6;
    const g = dragonflyWingGeometry(copies);
    const wing = g.getAttribute('wing');
    const seen = new Set<string>();
    for (let i = 0; i < wing.count; i++) seen.add(`${wing.getX(i)}:${wing.getY(i)}`);
    expect(seen.size).toBe(4 * copies);
    expect(wingOutline(0.12, true).chord).toBeGreaterThan(wingOutline(0.12, false).chord * 1.5);
    for (const hind of [false, true]) {
      expect(wingOutline(1, hind).chord).toBeCloseTo(0, 6);
      for (let u = 0; u <= 1; u += 0.05) expect(wingOutline(u, hind).chord).toBeGreaterThanOrEqual(0);
      // Long and narrow, as in real Libellulid wings.
      expect(wingOutline(0.5, hind).chord).toBeLessThan(0.3);
    }
  });
});
