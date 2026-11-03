import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { defaultSettings, migrateSettings } from '../settings/schema';
import { applyPreset, detectPreset, recommendPreset } from '../settings/presets';
import { emptyStats } from '../game/core/types';
import { openSaveBackend } from './backend';
import { HighScoreRepository, ProgressRepository, SettingsRepository, StatsRepository, exportSave, importSave, type HighScoreEntry } from './repositories';

let dbCounter = 0;
const fresh = () => openSaveBackend(new IDBFactory(), `prismfall-test-${dbCounter++}`);

function entry(id: string, score: number, timeMs = 60000): HighScoreEntry {
  return { id, key: 'marathon:150', score, timeMs, lines: 10, level: 2, stageId: 's', date: '2026-01-01', seed: 1, stats: emptyStats(), replayId: null };
}

describe('settings schema', () => {
  it('fills defaults for empty and partial objects', () => {
    const d = defaultSettings();
    expect(d.gameplay.dasMs).toBe(167);
    const { settings, valid } = migrateSettings({ gameplay: { dasMs: 100 } });
    expect(valid).toBe(true);
    expect(settings.gameplay.dasMs).toBe(100);
    expect(settings.gameplay.arrMs).toBe(33);
    expect(settings.keyboard.hardDrop).toEqual(['Space']);
  });

  it('replaces invalid values with defaults instead of failing', () => {
    const { settings } = migrateSettings({ gameplay: { dasMs: 'fast', arrMs: -5 }, graphics: { preset: 'insane' } });
    expect(settings.gameplay.dasMs).toBe(167);
    expect(settings.gameplay.arrMs).toBe(33);
    expect(settings.graphics.preset).toBe('high');
  });

  it('loads an M5-era settings save (old-save fixture): new fields default, custom values survive', () => {
    const m5 = {
      version: 1,
      keyboard: { moveLeft: ['KeyA'], moveRight: ['KeyD'], hardDrop: ['KeyW'], pause: ['Escape'] },
      gamepad: { hold: ['button:3'] },
      controller: { deadzoneInner: 0.3, profiles: { 'pad-1': { name: 'Old pad', family: 'generic', rawMap: { 'button:0': 'button:2' } } } },
      graphics: { preset: 'ultra', motionBlur: 0.5 },
      audio: { master: 0.4 },
      reactivity: { preset: 'hypnotic' },
    };
    const { settings, valid } = migrateSettings(m5);
    expect(valid).toBe(true);
    expect(settings.keyboard.hardDrop).toEqual(['KeyW']);
    expect(settings.keyboard.practiceUndo).toEqual(['Backspace']);
    expect(settings.gamepad.hold).toEqual(['button:3']);
    expect(settings.controller.deadzoneInner).toBe(0.3);
    expect(settings.controller.profiles['pad-1']?.family).toBe('generic');
    expect(settings.graphics.blockGlow).toBeCloseTo(0.6);
    expect(settings.audio.master).toBe(0.4);
    expect(settings.audio.musicPreview).toBe(true);
    expect(settings.reactivity.preset).toBe('hypnotic');
    expect(settings.setup.music).toBe('stage');
  });

  it('detects quality presets and custom changes', () => {
    const g = applyPreset(defaultSettings().graphics, 'ultra');
    expect(detectPreset(g)).toBe('ultra');
    expect(detectPreset({ ...g, bloom: 0.3 })).toBe('custom');
    expect(recommendPreset({ backend: 'webgpu', vendor: 'amd', architecture: 'rdna-4', description: 'AMD Radeon RX 9070 XT', isFallbackAdapter: false })).toBe('ultra');
    expect(recommendPreset({ backend: 'webgl2', vendor: 'Google', architecture: '', description: 'SwiftShader', isFallbackAdapter: false })).toBe('low');
  });
});

describe('storage', () => {
  it('round-trips settings and recovers from corrupt data', async () => {
    const backend = await fresh();
    const repo = new SettingsRepository(backend);
    const s = defaultSettings();
    s.gameplay.arrMs = 0;
    await repo.save(s);
    expect((await repo.load()).settings.gameplay.arrMs).toBe(0);
    await backend.putKV('settings', 'garbage');
    const loaded = await repo.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.settings.gameplay.arrMs).toBe(33);
  });

  it('keeps old progress readable when new stages are added (old-save fixture)', async () => {
    const backend = await fresh();
    // A save written before any newer stages existed, with an extra unknown field.
    await backend.putKV('progress', { version: 1, stages: { 'luminous-tide': { unlocked: true, completed: true, bestScore: 5000 }, 'removed-stage': { unlocked: true } }, legacyField: 1 });
    const progress = await new ProgressRepository(backend).load();
    expect(progress.stages['luminous-tide']?.completed).toBe(true);
    expect(progress.stages['folded-sky']).toBeUndefined();
    expect(progress.voyage.completedLegs).toEqual([]);
  });

  it('ranks and caps high scores', async () => {
    const backend = await fresh();
    const repo = new HighScoreRepository(backend);
    for (let i = 0; i < 12; i++) await repo.add(entry(`e${i}`, i * 100), false);
    const top = await repo.top('marathon:150', false);
    expect(top).toHaveLength(10);
    expect(top[0]?.score).toBe(1100);
    expect(await repo.add(entry('low', 50), false)).toBeNull();
    expect(await repo.add(entry('best', 9999), false)).toBe(1);
    // Sprint ranks by time, lower is better.
    const sprint = [entry('a', 0, 50000), entry('b', 0, 40000)].map((e) => ({ ...e, key: 'sprint:40' }));
    for (const e of sprint) await repo.add(e, true);
    expect((await repo.top('sprint:40', true))[0]?.id).toBe('b');
  });

  it('accumulates lifetime stats', async () => {
    const backend = await fresh();
    const repo = new StatsRepository(backend);
    await repo.add({ ...emptyStats(), lines: 10, maxCombo: 3 }, 1000);
    const total = await repo.add({ ...emptyStats(), lines: 5, maxCombo: 2 }, 500);
    expect(total.lines).toBe(15);
    expect(total.maxCombo).toBe(3);
    expect(total.games).toBe(2);
    expect(total.playTimeMs).toBe(1500);
  });

  it('exports and imports a save', async () => {
    const a = await fresh();
    await new SettingsRepository(a).save({ ...defaultSettings(), gameplay: { ...defaultSettings().gameplay, dasMs: 90 } });
    await new HighScoreRepository(a).add(entry('x', 1234), false);
    const dump = JSON.parse(JSON.stringify(await exportSave(a)));
    const b = await fresh();
    await importSave(b, dump);
    expect((await new SettingsRepository(b).load()).settings.gameplay.dasMs).toBe(90);
    expect((await new HighScoreRepository(b).top('marathon:150', false))[0]?.score).toBe(1234);
  });

  it('falls back to web storage without IndexedDB', async () => {
    const backend = await openSaveBackend(null);
    expect(['localstorage', 'memory']).toContain(backend.kind);
    await backend.putKV('k', { a: 1 });
    expect(await backend.getKV('k')).toEqual({ a: 1 });
  });
});
