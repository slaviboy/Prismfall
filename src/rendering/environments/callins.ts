/**
 * The Environment Event Director (brief §40.4D and §40.6): the moments that call a layer to act.
 * A creature passes close by, plays a clip or shows itself, a target swells and settles (`pulse`),
 * a wave of light rolls out through the world (`wave`), a flock startles...
 *
 * Calls come from three kinds of trigger:
 * - **the game**: clears, combos, back-to-back, spins, level-ups, danger, progress and heat crossings;
 * - **the music**: sections (`section:<kind>`) and, since SDK 1.7, the Environment Music Director's
 *   cues (`music:accent`, `music:phrase`, `music:build`, `music:drop`, `music:peak`, `music:calm`...);
 * - **ambient timers** (`ambient`, since SDK 1.7): random intervals in `every: [min, max]` seconds,
 *   a little shorter when the music is busy, so a world keeps something happening in quiet play.
 *
 * Variety: entries that share a `group` take turns. When their trigger fires (or their shared timer
 * comes round), one entry is picked by `weight`, never the one picked last time, and `vary` varies
 * the strength. `when` limits an entry to some sections, to an intensity range, or to calm music.
 * Every call is quantised to the music (the next beat, bar or phrase) and respects its cooldown.
 *
 * Rates follow two settings: World events (accessibility: calm halves the chance and doubles the
 * cooldown, off stops everything) and the Background intensity event frequency (`frequency`:
 * cooldowns and ambient intervals divide by it, below 1 it also lowers the chance, 0 stops events).
 *
 * Pure TypeScript: the stage environment feeds it presented events, beats, sections, music cues and
 * the music state, and delivers what it returns.
 */
import type { StageGameEvent } from '../../sdk/types';
import type { MusicCueKind } from '../../stages/music';
import { parseTrigger, type CallAction, type CallTrigger, type Quantize } from '../../stages/triggers';

export { CALL_ACTIONS, parseTrigger, type CallAction, type CallTrigger, type Quantize } from '../../stages/triggers';

/** One `events` entry (after schema defaults; the SDK 1.7 fields are optional). */
export interface CallInSpec {
  readonly layer: string;
  readonly on: string;
  readonly quantize: Quantize;
  /** Seconds before this entry may fire again (counted from when it fired). */
  readonly cooldown: number;
  /** Probability that a trigger fires at all (0..1). */
  readonly chance: number;
  readonly action: CallAction;
  readonly params: Readonly<Record<string, unknown>>;
  /** Ambient interval [min, max] seconds. */
  readonly every?: readonly [number, number];
  readonly group?: string;
  readonly weight?: number;
  readonly vary?: number;
  readonly when?: { readonly section?: readonly string[]; readonly minIntensity?: number; readonly maxIntensity?: number; readonly calm?: boolean };
}

/** A call ready for delivery to the layers `layer` selects. */
export interface DispatchedCall {
  readonly layer: string;
  readonly action: CallAction;
  readonly params: Readonly<Record<string, unknown>>;
  /** The trigger text that caused it. */
  readonly trigger: string;
  /** Size of the moment 0..1.5 (the clear's strength; 1 for other triggers, varied by `vary`). */
  readonly strength: number;
  readonly time: number;
}

interface Entry {
  readonly index: number;
  readonly spec: CallInSpec;
  readonly trigger: CallTrigger;
  lastFired: number;
  pending: { armed: number; strength: number } | null;
}

export interface BeatTick {
  readonly bar: number;
  readonly downbeat: boolean;
}

/** What the director needs to know about the music right now (from the music drive). */
export interface MusicState {
  readonly section: string;
  readonly sectionKind: string;
  readonly intensity: number;
  readonly calm: number;
}

/** Longest wait for a quantised moment before a call goes anyway (no music, or beats stalled). */
export function maxWait(quantize: Quantize, bpm: number, beatsPerBar: number, phraseBars: number): number {
  const beat = 60 / Math.max(30, Math.min(300, bpm || 120));
  if (quantize === 'beat') return beat * 1.5;
  if (quantize === 'bar') return beat * beatsPerBar + 0.25;
  if (quantize === 'phrase') return Math.min(16, beat * beatsPerBar * phraseBars + 0.25);
  return 0;
}

/** A shared ambient timer: one per group, or per ungrouped ambient entry. */
interface AmbientTimer {
  readonly entries: Entry[];
  readonly every: readonly [number, number];
  next: number;
}

export class EnvironmentEventDirector {
  private readonly entries: Entry[] = [];
  private readonly out: DispatchedCall[] = [];
  private readonly timers: AmbientTimer[] = [];
  private readonly lastPick = new Map<string, number>();
  private lastProgress = 0;
  private lastHeat = 0;
  private timersStarted = false;
  /** 1 full, 0.5 calm (rarer: half the chance, double the cooldown), 0 off (no call-ins). */
  worldEvents = 1;
  /** Background intensity event frequency (0..2, 1 as authored). */
  frequency = 1;
  bpm = 120;
  beatsPerBar = 4;
  private music: MusicState = { section: '', sectionKind: '', intensity: 0, calm: 0 };
  readonly errors: string[] = [];

  constructor(
    specs: readonly CallInSpec[],
    private readonly phraseBars = 4,
    private readonly random: () => number = Math.random,
  ) {
    const groups = new Map<string, AmbientTimer>();
    specs.forEach((spec, index) => {
      const trigger = parseTrigger(spec.on);
      if (!trigger) {
        this.errors.push(`event "${spec.on}": unknown trigger`);
        return;
      }
      if (trigger.kind === 'ambient' && !spec.every) {
        this.errors.push(`event "${spec.on}" on "${spec.layer}": an ambient call needs every: [min, max]`);
        return;
      }
      const entry: Entry = { index, spec, trigger, lastFired: -1e9, pending: null };
      this.entries.push(entry);
      if (trigger.kind === 'ambient' && spec.every) {
        const key = spec.group ? `g:${spec.group}` : `e:${index}`;
        let timer = groups.get(key);
        if (!timer) {
          timer = { entries: [], every: spec.every, next: Infinity };
          groups.set(key, timer);
          this.timers.push(timer);
        }
        timer.entries.push(entry);
      }
    });
  }

  get size(): number {
    return this.entries.length;
  }

  /** Whether `e` may fire now: world events, frequency, cooldown and `when`. Chance is separate. */
  private allowed(e: Entry, time: number): boolean {
    if (this.worldEvents <= 0 || this.frequency <= 0 || e.pending) return false;
    const freq = Math.max(0.25, this.frequency);
    const cooldown = (e.spec.cooldown * (this.worldEvents < 1 ? 2 : 1)) / freq;
    if (time - e.lastFired < cooldown) return false;
    const w = e.spec.when;
    if (w) {
      const m = this.music;
      if (w.section && !w.section.includes(m.sectionKind) && !w.section.includes(m.section)) return false;
      if (w.minIntensity !== undefined && m.intensity < w.minIntensity) return false;
      if (w.maxIntensity !== undefined && m.intensity > w.maxIntensity) return false;
      if (w.calm === true && m.calm < 0.5) return false;
      if (w.calm === false && m.calm >= 0.5) return false;
    }
    return true;
  }

  private rollChance(e: Entry): boolean {
    const chance = e.spec.chance * (this.worldEvents < 1 ? 0.5 : 1) * Math.min(1, this.frequency);
    return chance >= 1 || this.random() < chance;
  }

  private arm(e: Entry, time: number, strength: number): void {
    const vary = Math.max(0, Math.min(1, e.spec.vary ?? 0));
    const s = vary > 0 ? strength * (1 - vary + 2 * vary * this.random()) : strength;
    if (e.spec.quantize === 'none') this.fire(e, time, s);
    else e.pending = { armed: time, strength: s };
  }

  private fire(e: Entry, time: number, strength: number): void {
    e.pending = null;
    e.lastFired = time;
    if (e.spec.group) this.lastPick.set(e.spec.group, e.index);
    this.out.push({ layer: e.spec.layer, action: e.spec.action, params: e.spec.params, trigger: e.spec.on, strength, time });
  }

  /** Weighted pick among allowed entries, avoiding the group's last pick when another is possible. */
  private pick(candidates: readonly Entry[], group: string | undefined): Entry | null {
    if (candidates.length === 0) return null;
    let pool = candidates;
    if (group && candidates.length > 1) {
      const last = this.lastPick.get(group);
      const fresh = candidates.filter((c) => c.index !== last);
      if (fresh.length > 0) pool = fresh;
    }
    const total = pool.reduce((sum, c) => sum + Math.max(0, c.spec.weight ?? 1), 0);
    if (total <= 0) return pool[0] ?? null;
    let r = this.random() * total;
    for (const c of pool) {
      r -= Math.max(0, c.spec.weight ?? 1);
      if (r <= 0) return c;
    }
    return pool[pool.length - 1] ?? null;
  }

  /** Arms what a trigger hit: ungrouped entries each, one entry per group. */
  private hits(hit: readonly Entry[], time: number, strength: number): void {
    const groups = new Map<string, Entry[]>();
    for (const e of hit) {
      if (!this.allowed(e, time)) continue;
      const g = e.spec.group;
      if (!g) {
        if (this.rollChance(e)) this.arm(e, time, strength);
        continue;
      }
      const list = groups.get(g) ?? [];
      list.push(e);
      groups.set(g, list);
    }
    for (const [g, list] of groups) {
      const chosen = this.pick(list, g);
      if (chosen && this.rollChance(chosen)) this.arm(chosen, time, strength);
    }
  }

  /** A presented game moment (see StageGameEvent). */
  onGameEvent(ev: StageGameEvent, time: number, strength = 1): void {
    const hit: Entry[] = [];
    for (const e of this.entries) {
      const t = e.trigger;
      let ok = false;
      if (ev.kind === 'clear') {
        const lines = ev.perfectClear ? Math.max(4, ev.lines) : ev.lines;
        if (t.kind === 'clear') ok = lines >= t.min;
        else if (t.kind === 'combo') ok = ev.combo >= t.min;
        else if (t.kind === 'b2b') ok = ev.backToBack;
        else if (t.kind === 'perfect') ok = ev.perfectClear;
        else if (t.kind === 'spin') ok = ev.spin;
      } else if (ev.kind === 'levelUp') ok = t.kind === 'levelUp';
      else if (ev.kind === 'danger') ok = t.kind === 'danger' && ev.active;
      if (ok) hit.push(e);
    }
    if (hit.length > 0) this.hits(hit, time, ev.kind === 'clear' ? strength : 1);
  }

  /** The music entered a section (`kind` such as drop, `name` the composition's own name). */
  onSection(kind: string, name: string, time: number): void {
    const hit = this.entries.filter((e) => e.trigger.kind === 'section' && (e.trigger.section === kind || e.trigger.section === name));
    if (hit.length > 0) this.hits(hit, time, 1);
  }

  /** A cue of the Environment Music Director (since SDK 1.7). */
  onMusicCue(kind: MusicCueKind, strength: number, time: number): void {
    const hit = this.entries.filter((e) => e.trigger.kind === 'music' && e.trigger.cue === kind);
    if (hit.length > 0) this.hits(hit, time, strength);
  }

  /** The music right now, for `when` and for ambient rates and strengths. */
  onMusicState(state: MusicState): void {
    this.music = state;
  }

  /** Progress and heat crossings (each fires when the value rises through the threshold). */
  onSignals(progress: number, heat: number, time: number): void {
    const hit: Entry[] = [];
    for (const e of this.entries) {
      const t = e.trigger;
      if (t.kind === 'progress' && this.lastProgress < t.min && progress >= t.min) hit.push(e);
      if (t.kind === 'heat' && this.lastHeat < t.min && heat >= t.min) hit.push(e);
    }
    this.lastProgress = progress;
    this.lastHeat = heat;
    if (hit.length > 0) this.hits(hit, time, 1);
  }

  /** A beat was heard: releases calls waiting for it. */
  onBeat(beat: BeatTick, time: number): void {
    for (const e of this.entries) {
      const p = e.pending;
      if (!p) continue;
      const q = e.spec.quantize;
      const ok = q === 'beat' || (q === 'bar' && beat.downbeat) || (q === 'phrase' && beat.downbeat && ((beat.bar % this.phraseBars) + this.phraseBars) % this.phraseBars === 0);
      if (ok) this.fire(e, time, p.strength);
    }
  }

  /** Seconds until an ambient timer's next call: busier music shortens it, the frequency divides it. */
  private interval(timer: AmbientTimer): number {
    const [lo, hi] = timer.every;
    const base = lo + (hi - lo) * this.random();
    const busy = 0.7 + 0.6 * Math.max(0, Math.min(1, this.music.intensity));
    return base / (Math.max(0.05, this.frequency) * busy);
  }

  /** Ambient timers: each due timer calls one of its entries. */
  private ambient(time: number): void {
    if (!this.timersStarted) {
      this.timersStarted = true;
      // The first call of each timer comes part-way into its interval, not at once.
      for (const t of this.timers) t.next = time + this.interval(t) * (0.35 + 0.4 * this.random());
    }
    for (const t of this.timers) {
      if (time < t.next) continue;
      if (this.worldEvents <= 0 || this.frequency <= 0) {
        t.next = time + 2;
        continue;
      }
      t.next = time + this.interval(t);
      const allowed = t.entries.filter((e) => this.allowed(e, time));
      const group = t.entries[0]?.spec.group;
      const chosen = this.pick(allowed, group);
      if (chosen && this.rollChance(chosen)) this.arm(chosen, time, 0.75 + 0.5 * Math.max(0, Math.min(1, this.music.intensity)));
    }
  }

  /** Runs the ambient timers, releases calls whose quantised moment never came, and returns everything due. */
  update(time: number): readonly DispatchedCall[] {
    if (this.timers.length > 0) this.ambient(time);
    for (const e of this.entries) {
      const p = e.pending;
      if (p && time - p.armed >= maxWait(e.spec.quantize, this.bpm, this.beatsPerBar, this.phraseBars)) this.fire(e, time, p.strength);
    }
    if (this.out.length === 0) return EMPTY;
    const calls = this.out.slice();
    this.out.length = 0;
    return calls;
  }

  /** Progress restarts (a new game): crossings can fire again. */
  resetSignals(progress = 0): void {
    this.lastProgress = progress;
    this.lastHeat = 0;
  }
}

/** The SDK 1.5 name of the director. */
export { EnvironmentEventDirector as CallInDispatcher };

const EMPTY: readonly DispatchedCall[] = [];
