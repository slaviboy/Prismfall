/**
 * Event call-ins (manifest `events`): game and music moments that call a layer to act (a creature
 * passes close by, plays a clip, a flock shows itself, a burst...). Pure TypeScript: the dispatcher
 * gets the presented events, beats and section changes from the stage environment and returns the
 * calls to deliver, quantised to the music (the next beat, bar or phrase) so they land with it.
 */
import type { StageGameEvent } from '../../sdk/types';
import { parseTrigger, type CallAction, type CallTrigger, type Quantize } from '../../stages/triggers';

export { CALL_ACTIONS, parseTrigger, type CallAction, type CallTrigger, type Quantize } from '../../stages/triggers';

/** One manifest `events` entry (after schema defaults). */
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
}

/** A call ready for delivery to the layers `layer` selects. */
export interface DispatchedCall {
  readonly layer: string;
  readonly action: CallAction;
  readonly params: Readonly<Record<string, unknown>>;
  /** The trigger text that caused it. */
  readonly trigger: string;
  /** Size of the moment 0..1.5 (the clear's strength; 1 for other triggers). */
  readonly strength: number;
  readonly time: number;
}

interface Entry {
  readonly spec: CallInSpec;
  readonly trigger: CallTrigger;
  lastFired: number;
  pending: { armed: number; strength: number } | null;
}

export interface BeatTick {
  readonly bar: number;
  readonly downbeat: boolean;
}

/** Longest wait for a quantised moment before a call goes anyway (no music, or beats stalled). */
export function maxWait(quantize: Quantize, bpm: number, beatsPerBar: number, phraseBars: number): number {
  const beat = 60 / Math.max(30, Math.min(300, bpm || 120));
  if (quantize === 'beat') return beat * 1.5;
  if (quantize === 'bar') return beat * beatsPerBar + 0.25;
  if (quantize === 'phrase') return Math.min(16, beat * beatsPerBar * phraseBars + 0.25);
  return 0;
}

export class CallInDispatcher {
  private readonly entries: Entry[] = [];
  private readonly out: DispatchedCall[] = [];
  private lastProgress = 0;
  private lastHeat = 0;
  /** 1 full, 0.5 calm (rarer: half the chance, double the cooldown), 0 off (no call-ins). */
  worldEvents = 1;
  bpm = 120;
  beatsPerBar = 4;
  readonly errors: string[] = [];

  constructor(
    specs: readonly CallInSpec[],
    private readonly phraseBars = 4,
    private readonly random: () => number = Math.random,
  ) {
    for (const spec of specs) {
      const trigger = parseTrigger(spec.on);
      if (!trigger) {
        this.errors.push(`event "${spec.on}": unknown trigger`);
        continue;
      }
      this.entries.push({ spec, trigger, lastFired: -1e9, pending: null });
    }
  }

  get size(): number {
    return this.entries.length;
  }

  private arm(e: Entry, time: number, strength: number): void {
    if (this.worldEvents <= 0 || e.pending) return;
    const cooldown = e.spec.cooldown * (this.worldEvents < 1 ? 2 : 1);
    if (time - e.lastFired < cooldown) return;
    const chance = e.spec.chance * (this.worldEvents < 1 ? 0.5 : 1);
    if (chance < 1 && this.random() >= chance) return;
    if (e.spec.quantize === 'none') this.fire(e, time, strength);
    else e.pending = { armed: time, strength };
  }

  private fire(e: Entry, time: number, strength: number): void {
    e.pending = null;
    e.lastFired = time;
    this.out.push({ layer: e.spec.layer, action: e.spec.action, params: e.spec.params, trigger: e.spec.on, strength, time });
  }

  /** A presented game moment (see StageGameEvent). */
  onGameEvent(ev: StageGameEvent, time: number, strength = 1): void {
    for (const e of this.entries) {
      const t = e.trigger;
      let hit = false;
      if (ev.kind === 'clear') {
        const lines = ev.perfectClear ? Math.max(4, ev.lines) : ev.lines;
        if (t.kind === 'clear') hit = lines >= t.min;
        else if (t.kind === 'combo') hit = ev.combo >= t.min;
        else if (t.kind === 'b2b') hit = ev.backToBack;
        else if (t.kind === 'perfect') hit = ev.perfectClear;
        else if (t.kind === 'spin') hit = ev.spin;
      } else if (ev.kind === 'levelUp') hit = t.kind === 'levelUp';
      else if (ev.kind === 'danger') hit = t.kind === 'danger' && ev.active;
      if (hit) this.arm(e, time, ev.kind === 'clear' ? strength : 1);
    }
  }

  /** The music entered a section (`kind` such as drop, `name` the composition's own name). */
  onSection(kind: string, name: string, time: number): void {
    for (const e of this.entries) {
      if (e.trigger.kind === 'section' && (e.trigger.section === kind || e.trigger.section === name)) this.arm(e, time, 1);
    }
  }

  /** Progress and heat crossings (each fires when the value rises through the threshold). */
  onSignals(progress: number, heat: number, time: number): void {
    for (const e of this.entries) {
      const t = e.trigger;
      if (t.kind === 'progress' && this.lastProgress < t.min && progress >= t.min) this.arm(e, time, 1);
      if (t.kind === 'heat' && this.lastHeat < t.min && heat >= t.min) this.arm(e, time, 1);
    }
    this.lastProgress = progress;
    this.lastHeat = heat;
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

  /** Releases calls whose quantised moment never came (no music), and returns everything due. */
  update(time: number): readonly DispatchedCall[] {
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

const EMPTY: readonly DispatchedCall[] = [];
