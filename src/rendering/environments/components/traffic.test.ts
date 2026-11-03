import { describe, expect, it } from 'vitest';
import nights from '../../../../content/stages/future-nights/stage.json';
import { aircraftComponent, sightToWorld } from './aircraft';
import { citySchema, placeTowers } from './city';
import { seeded } from './common';
import { matteComponent } from './matte';
import { arcLanes, cityStreets, expresswayLanes, streetLanes, trafficComponent } from './traffic';

const layer = (type: string) => {
  const l = nights.environment.layers.find((x) => x.type === type);
  if (!l) throw new Error(`no ${type} layer`);
  return l;
};

describe('city street traffic', () => {
  const city = citySchema.parse({ count: 400, near: 120, far: 560, grid: 26, street: 7, exclude: [{ center: [0, -20], radius: 100 }], seed: 9 });
  const towers = placeTowers(city, 1, seeded(city.seed * 271 + 3));
  const byCell = new Map(towers.map((t) => [`${Math.round(t.x / city.grid)},${Math.round(t.z / city.grid)}`, t]));

  it('places towers deterministically on the grid', () => {
    expect(placeTowers(city, 1, seeded(city.seed * 271 + 3))).toEqual(towers);
    expect(towers.length).toBeGreaterThan(300);
    for (const t of towers) {
      expect(t.x / city.grid).toBeCloseTo(Math.round(t.x / city.grid), 9);
      expect(t.w).toBeLessThanOrEqual(city.grid - city.street + 1e-9);
    }
  });

  it('runs every lane along a street, clear of every tower footprint', () => {
    const t = trafficComponent.schema.parse({ city });
    const streets = cityStreets(towers, city.grid, t.viewer, t.range);
    expect(streets.length).toBeGreaterThan(30);
    const lanes = streetLanes(streets, t.laneOffset);
    expect(lanes).toHaveLength(streets.length * 2);
    for (const lane of lanes) {
      const dir = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ][lane.dir] as [number, number];
      for (let s = 0; s <= lane.length; s += 4) {
        const x = lane.x + dir[0] * s;
        const z = lane.z + dir[1] * s;
        // Towers sit on grid points and are narrower than a cell, so only the nearest one can contain it.
        const b = byCell.get(`${Math.round(x / city.grid)},${Math.round(z / city.grid)}`);
        if (b) expect(Math.abs(x - b.x) < b.w / 2 && Math.abs(z - b.z) < b.d / 2).toBe(false);
      }
    }
    // Right-hand traffic: heading +z (towards the viewer) on the -x side of its street.
    const ns = streets.find((s) => s.x0 === s.x1)!;
    const toward = streetLanes([ns], 1.7).find((l) => l.dir === 1)!;
    expect(toward.x).toBeLessThan(ns.x0);
  });

  it('keeps an expressway in the open plaza in front of the towers', () => {
    const t = trafficComponent.schema.parse({ city, expressway: { center: [0, -98] } });
    const nearest = Math.max(...towers.map((b) => b.z + b.d / 2));
    for (const l of expresswayLanes(t.expressway!)) expect(l.z).toBeGreaterThan(nearest + 2);
  });
});

describe('Future Nights (Shanghai Bund panorama)', () => {
  const sky = layer('sky').params as unknown as { panorama: { offset: number; occlude: number; detail: { uRange: [number, number] } } };
  const traffic = trafficComponent.schema.parse(layer('traffic').params);
  const matte = matteComponent.schema.parse(layer('matte').params);
  const air = aircraftComponent.schema.parse(layer('aircraft').params);

  it('ends the river at the far bank: the matte inside the photo occlusion, the road inside the matte', () => {
    expect(matte.radius).toBeLessThan(sky.panorama.occlude);
    for (const r of traffic.roads) {
      expect(r.radius + 1.2 + r.lanes * r.laneWidth).toBeLessThan(matte.radius);
      // On the photo's embankment (just below the horizon), above the 3D water's far edge.
      expect(r.elevation).toBeLessThan(0);
      expect(r.elevation).toBeGreaterThan(-1);
    }
    const lanes = arcLanes(traffic.roads, traffic.eyeY);
    expect(lanes).toHaveLength(traffic.roads.reduce((n, r) => n + r.lanes * 2, 0));
    for (const l of lanes) expect(l.arc!.y).toBeGreaterThan((layer('water').params as { y: number }).y);
  });

  it('flies the aircraft in front of the photo, outside the clear cone, behind its measured skyline', () => {
    expect(air.skyline).toBeDefined();
    expect(air.skyline!.offset).toBe(sky.panorama.offset);
    expect(air.skyline!.uRange).toEqual(sky.panorama.detail.uRange);
    expect(air.skyline!.elevations.length).toBeGreaterThan(100);
    for (const r of air.routes) {
      for (const s of [r.from, r.to]) expect(s[2]).toBeLessThan(sky.panorama.occlude);
      for (let k = 0; k <= 20; k++) {
        const t = k / 20;
        const a = sightToWorld(air.viewer, r.from);
        const b = sightToWorld(air.viewer, r.to);
        const x = a[0] + (b[0] - a[0]) * t - air.viewer[0];
        const z = air.viewer[2] - (a[2] + (b[2] - a[2]) * t);
        const azimuth = (Math.atan2(Math.abs(x), z) * 180) / Math.PI;
        expect(azimuth - air.jitter).toBeGreaterThan(22);
      }
    }
  });

  it('converts sights to world positions', () => {
    const [x, y, z] = sightToWorld([0, 1, 30], [0, 0, 100]);
    expect([x, y, z].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, -70]);
    const up = sightToWorld([0, 1, 30], [90, 30, 10]);
    expect(up[0]).toBeCloseTo(Math.cos(Math.PI / 6) * 10, 6);
    expect(up[1]).toBeCloseTo(6, 6);
  });
});
