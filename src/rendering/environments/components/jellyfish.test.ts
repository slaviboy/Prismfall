import { describe, expect, it } from 'vitest';
import abyss from '../../../../content/stages/the-abyss/stage.json';
import { seeded } from './common';
import { jellyfishComponent, placeJellies, screenGap, type JellyHome } from './jellyfish';

/** Same seed the component uses for its layout. */
const layout = (raw: unknown): { p: ReturnType<typeof jellyfishComponent.schema.parse>; homes: JellyHome[] } => {
  const p = jellyfishComponent.schema.parse(raw);
  return { p, homes: placeJellies(p, seeded(p.seed * 9173 + 11)) };
};

describe('jellyfish placement', () => {
  it('keeps every bell and its wander outside the clear cone around the view axis', () => {
    for (const seed of [1, 2, 3, 8, 42, 99]) {
      const { p, homes } = layout({ count: 8, seed });
      expect(homes).toHaveLength(8);
      for (const h of homes) {
        const cone = p.area.clearance * (p.area.viewZ - h.z);
        expect(Math.abs(h.x) - h.radius - p.wander).toBeGreaterThan(cone);
      }
    }
  });

  it('alternates sides and keeps sizes and pulse rates in range', () => {
    const { p, homes } = layout({ count: 6, size: [3, 5], pulseRate: 0.8, seed: 5 });
    const left = homes.filter((h) => h.x < 0).length;
    expect(Math.abs(left - (homes.length - left))).toBeLessThanOrEqual(1);
    for (const h of homes) {
      expect(h.radius * 2).toBeGreaterThanOrEqual(p.size[0]);
      expect(h.radius * 2).toBeLessThanOrEqual(p.size[1]);
      expect(h.freq).toBeGreaterThanOrEqual(0.8 * 0.8);
      expect(h.freq).toBeLessThanOrEqual(0.8 * 1.2);
    }
  });

  it('does not overlap the shipped Abyss jellies on screen (bell to visible tentacles)', () => {
    const layers = abyss.environment.layers.filter((l) => l.type === 'jellyfish');
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) {
      const { p, homes } = layout(layer.params);
      for (let i = 0; i < homes.length; i++) {
        for (let j = i + 1; j < homes.length; j++) expect(screenGap(homes[i] as JellyHome, homes[j] as JellyHome, p)).toBeGreaterThan(0);
      }
    }
  });

  it('reports overlap for jellies stacked in front of each other', () => {
    const p = jellyfishComponent.schema.parse({});
    const a = { x: 40, y: 5, z: -40, radius: 2.5 };
    expect(screenGap(a, { ...a, y: 8 }, p)).toBeLessThan(0);
    expect(screenGap(a, { ...a, x: -40 }, p)).toBeGreaterThan(0);
  });
});
