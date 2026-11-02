import { z } from 'zod';
import type { SessionStats } from '../game/core/types';
import { emptyStats } from '../game/core/types';
import type { ReplayData } from '../game/simulation/replay';
import { deserializeReplay, serializeReplay } from '../game/simulation/replay';
import { migrateSettings, type Settings } from '../settings/schema';
import type { SaveBackend } from './backend';

// ----------------------------------------------------------------------------- settings

export class SettingsRepository {
  constructor(private readonly backend: SaveBackend) {}

  async load(): Promise<{ settings: Settings; recovered: boolean }> {
    const raw = await this.backend.getKV<unknown>('settings');
    const { settings, valid } = migrateSettings(raw);
    if (!valid && raw !== undefined) {
      // Keep the unreadable data for manual recovery, then continue with defaults.
      await this.backend.putKV(`settings-corrupt-${Date.now()}`, raw);
    }
    return { settings, recovered: !valid && raw !== undefined };
  }

  async save(settings: Settings): Promise<void> {
    await this.backend.putKV('settings', settings);
  }
}

// ----------------------------------------------------------------------------- progress

const stageProgressSchema = z.object({
  unlocked: z.boolean().catch(false).default(false),
  completed: z.boolean().catch(false).default(false),
  plays: z.number().catch(0).default(0),
  bestScore: z.number().catch(0).default(0),
  bestLines: z.number().catch(0).default(0),
  lastPlayed: z.string().nullable().catch(null).default(null),
});

export const progressSchema = z.object({
  version: z.number().catch(1).default(1),
  /** Keyed by stage id. Unknown ids (removed stages) are kept but ignored. */
  stages: z.record(z.string(), stageProgressSchema).catch({}).default({}),
  voyage: z
    .object({
      completedLegs: z.array(z.string()).catch([]).default([]),
      completedAreas: z.array(z.string()).catch([]).default([]),
      bestScores: z.record(z.string(), z.number()).catch({}).default({}),
    })
    .prefault({}),
  modesPlayed: z.record(z.string(), z.number()).catch({}).default({}),
  /** Best score per mode (score-based unlock requirements). */
  bestByMode: z.record(z.string(), z.number()).catch({}).default({}),
});

export type Progress = z.infer<typeof progressSchema>;
export type StageProgress = z.infer<typeof stageProgressSchema>;

export function emptyProgress(): Progress {
  return progressSchema.parse({});
}

export class ProgressRepository {
  constructor(private readonly backend: SaveBackend) {}

  async load(): Promise<Progress> {
    const raw = await this.backend.getKV<unknown>('progress');
    const parsed = progressSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : emptyProgress();
  }

  async save(progress: Progress): Promise<void> {
    await this.backend.putKV('progress', progress);
  }
}

// ----------------------------------------------------------------------------- high scores

export interface HighScoreEntry {
  readonly id: string;
  /** `${modeId}:${variantId}` */
  readonly key: string;
  readonly score: number;
  readonly timeMs: number;
  readonly lines: number;
  readonly level: number;
  readonly stageId: string;
  readonly date: string;
  readonly seed: number;
  readonly stats: SessionStats;
  readonly replayId: string | null;
}

export const HIGH_SCORE_LIMIT = 10;

export function compareEntries(lowerIsBetter: boolean) {
  return (a: HighScoreEntry, b: HighScoreEntry): number => {
    if (lowerIsBetter) return a.timeMs - b.timeMs || b.score - a.score;
    return b.score - a.score || a.timeMs - b.timeMs;
  };
}

export class HighScoreRepository {
  constructor(private readonly backend: SaveBackend) {}

  async top(key: string, lowerIsBetter: boolean, limit = HIGH_SCORE_LIMIT): Promise<HighScoreEntry[]> {
    const all = await this.backend.getAll<HighScoreEntry>('highscores');
    return all.filter((e) => e.key === key).sort(compareEntries(lowerIsBetter)).slice(0, limit);
  }

  /** Inserts the entry; returns its 1-based rank, or null if it didn't make the table. */
  async add(entry: HighScoreEntry, lowerIsBetter: boolean): Promise<number | null> {
    const all = (await this.backend.getAll<HighScoreEntry>('highscores')).filter((e) => e.key === entry.key);
    const ranked = [...all, entry].sort(compareEntries(lowerIsBetter));
    const rank = ranked.findIndex((e) => e.id === entry.id) + 1;
    if (rank > HIGH_SCORE_LIMIT) return null;
    await this.backend.put('highscores', entry);
    for (const dropped of ranked.slice(HIGH_SCORE_LIMIT)) {
      if (dropped.id !== entry.id) await this.backend.delete('highscores', dropped.id);
    }
    return rank;
  }

  async all(): Promise<HighScoreEntry[]> {
    return this.backend.getAll<HighScoreEntry>('highscores');
  }
}

// ----------------------------------------------------------------------------- replays

interface StoredReplay {
  readonly id: string;
  readonly date: string;
  readonly modeId: string;
  readonly variantId: string;
  readonly pinned: boolean;
  readonly data: string;
}

export const REPLAY_LIMIT = 40;

export class ReplayRepository {
  constructor(private readonly backend: SaveBackend) {}

  async save(id: string, replay: ReplayData, pinned: boolean): Promise<void> {
    await this.backend.put('replays', {
      id,
      date: replay.recordedAt,
      modeId: replay.modeId,
      variantId: replay.variantId,
      pinned,
      data: serializeReplay(replay),
    } satisfies StoredReplay);
    const all = (await this.backend.getAll<StoredReplay>('replays')).filter((r) => !r.pinned).sort((a, b) => b.date.localeCompare(a.date));
    for (const old of all.slice(REPLAY_LIMIT)) await this.backend.delete('replays', old.id);
  }

  async load(id: string): Promise<ReplayData | null> {
    const row = await this.backend.get<StoredReplay>('replays', id);
    return row ? deserializeReplay(row.data) : null;
  }

  async pin(id: string): Promise<void> {
    const row = await this.backend.get<StoredReplay>('replays', id);
    if (row) await this.backend.put('replays', { ...row, pinned: true });
  }
}

// ----------------------------------------------------------------------------- lifetime stats

export interface LifetimeStats extends SessionStats {
  games: number;
  playTimeMs: number;
}

export class StatsRepository {
  constructor(private readonly backend: SaveBackend) {}

  async load(): Promise<LifetimeStats> {
    const raw = await this.backend.getKV<Partial<LifetimeStats>>('lifetimeStats');
    return { ...emptyStats(), games: 0, playTimeMs: 0, ...(raw ?? {}) };
  }

  async add(session: SessionStats, playTimeMs: number): Promise<LifetimeStats> {
    const current = await this.load();
    const next: LifetimeStats = { ...current, games: current.games + 1, playTimeMs: current.playTimeMs + playTimeMs };
    for (const k of Object.keys(session) as (keyof SessionStats)[]) {
      if (k === 'maxCombo' || k === 'maxBackToBack') next[k] = Math.max(current[k], session[k]);
      else next[k] = current[k] + session[k];
    }
    await this.backend.putKV('lifetimeStats', next);
    return next;
  }
}

// ----------------------------------------------------------------------------- export / import

export interface SaveExport {
  readonly app: 'prismfall';
  readonly exportedAt: string;
  readonly settings: unknown;
  readonly progress: unknown;
  readonly lifetimeStats: unknown;
  readonly highscores: unknown[];
}

export async function exportSave(backend: SaveBackend): Promise<SaveExport> {
  return {
    app: 'prismfall',
    exportedAt: new Date().toISOString(),
    settings: await backend.getKV('settings'),
    progress: await backend.getKV('progress'),
    lifetimeStats: await backend.getKV('lifetimeStats'),
    highscores: await backend.getAll('highscores'),
  };
}

export async function importSave(backend: SaveBackend, data: unknown): Promise<void> {
  const parsed = z
    .object({ app: z.literal('prismfall'), settings: z.unknown().optional(), progress: z.unknown().optional(), lifetimeStats: z.unknown().optional(), highscores: z.array(z.object({ id: z.string() }).passthrough()) })
    .parse(data);
  if (parsed.settings !== undefined) await backend.putKV('settings', migrateSettings(parsed.settings).settings);
  if (parsed.progress !== undefined) await backend.putKV('progress', progressSchema.parse(parsed.progress));
  if (parsed.lifetimeStats !== undefined) await backend.putKV('lifetimeStats', parsed.lifetimeStats);
  for (const entry of parsed.highscores) await backend.put('highscores', entry as { id: string });
}
