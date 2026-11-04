import { createAudioFeatures, type BeatEvent } from '../analysis/features';
import { FeatureProcessor } from '../analysis/dsp/featureProcessor';
import { FRAME, FrameAnalyzer } from '../analysis/dsp/frameAnalyzer';
import type { Composition } from '../sequencer/composition';
import { EnvironmentMusicDirector } from '../../rendering/environments/living/musicDirector';
import { MUSIC_CUES, MUSIC_DRIVES, type MusicCueKind, type MusicDriveName } from '../../stages/music';
import { renderSpan, sectionTimeline } from './trackReport';

/**
 * How a track moves the Environment Music Director (dev/test builds only). The track's first pass
 * is rendered offline by the real synthesiser through the game's limiter, analysed by the game's
 * DSP core, given the composition's own beat grid and sections (as the Music Director publishes
 * them in play) and fed to the EnvironmentMusicDirector at 60 Hz. Per section it reports the mean
 * and 90th percentile of every drive and the rate of every cue: the measurements each world's
 * living.json is tuned against (MUSIC_REACTIVE_ENVIRONMENTS.md).
 */

const SR = 48000;
const HOP = 512;
const STEP = 1 / 60;

export interface DriveStats {
  readonly mean: Readonly<Record<MusicDriveName, number>>;
  readonly p90: Readonly<Record<MusicDriveName, number>>;
  /** Cues per minute. */
  readonly cues: Readonly<Record<MusicCueKind, number>>;
}

export interface DriveSection extends DriveStats {
  readonly name: string;
  readonly kind: string;
  readonly intensity: number;
  readonly startS: number;
  readonly endS: number;
}

export interface DriveReport extends DriveStats {
  readonly id: string;
  readonly title: string;
  readonly bpm: number;
  readonly seconds: number;
  readonly sections: readonly DriveSection[];
}

class Acc {
  readonly sum: Record<string, number> = Object.fromEntries(MUSIC_DRIVES.map((k) => [k, 0]));
  readonly hist: Record<string, Uint32Array> = Object.fromEntries(MUSIC_DRIVES.map((k) => [k, new Uint32Array(101)]));
  readonly cues: Record<string, number> = Object.fromEntries(MUSIC_CUES.map((k) => [k, 0]));
  n = 0;
  seconds = 0;

  add(drive: Readonly<Record<MusicDriveName, number>>): void {
    this.n++;
    this.seconds += STEP;
    for (const k of MUSIC_DRIVES) {
      const v = Math.max(0, Math.min(1, drive[k]));
      this.sum[k] = (this.sum[k] as number) + v;
      const h = this.hist[k] as Uint32Array;
      const bin = Math.round(v * 100);
      h[bin] = (h[bin] as number) + 1;
    }
  }

  stats(): DriveStats {
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const p90 = (h: Uint32Array): number => {
      let acc = 0;
      for (let i = 0; i < h.length; i++) {
        acc += h[i] as number;
        if (acc >= this.n * 0.9) return i / 100;
      }
      return 1;
    };
    const minutes = Math.max(1e-6, this.seconds / 60);
    return {
      mean: Object.fromEntries(MUSIC_DRIVES.map((k) => [k, r3((this.sum[k] as number) / Math.max(1, this.n))])) as Record<MusicDriveName, number>,
      p90: Object.fromEntries(MUSIC_DRIVES.map((k) => [k, p90(this.hist[k] as Uint32Array)])) as Record<MusicDriveName, number>,
      cues: Object.fromEntries(MUSIC_CUES.map((k) => [k, Math.round(((this.cues[k] as number) / minutes) * 10) / 10])) as Record<MusicCueKind, number>,
    };
  }
}

/** Measures how a composition moves the drives over its first pass (at most `maxSeconds`). */
export async function measureDrives(c: Composition, opts: { intensity?: number; maxSeconds?: number; flashReduction?: boolean } = {}): Promise<DriveReport> {
  const spb = 60 / c.bpm;
  const bpb = c.beatsPerBar;
  const timeline = sectionTimeline(c);
  const passS = timeline[timeline.length - 1]?.endS ?? 0;
  const totalS = Math.min(opts.maxSeconds ?? 300, passS);
  const analyzer = new FrameAnalyzer(SR, 4096, 2048, HOP);
  const processor = new FeatureProcessor(HOP / SR);
  processor.onsetLatencyS = (2048 + HOP) / 2 / SR;
  const f = createAudioFeatures();
  const frame = new Float32Array(FRAME.size);
  const hop = new Float32Array(HOP);
  let hopFill = 0;
  const director = new EnvironmentMusicDirector();
  const input = { active: true, flashReduction: opts.flashReduction ?? false, reducedMotion: false, beatsPerBar: bpb, phraseBars: 4 };
  const all = new Acc();
  const accs = timeline.map(() => new Acc());
  const sectionAt = (time: number): number => {
    for (let i = 0; i < timeline.length; i++) if (time < (timeline[i]?.endS ?? 0)) return i;
    return timeline.length - 1;
  };
  let sectionIntensity = timeline[0]?.intensity ?? 0.5;
  let clock = 0;
  let lastBeat = -1;
  const beats: BeatEvent[] = [];

  // The Music Director's timeline at time t (as it publishes it in play).
  const timelineAt = (t: number, dt: number): void => {
    const beat = t / spb;
    const last = Math.floor(beat);
    f.bpm = c.bpm;
    f.beat = last;
    f.beatPhase = beat - last;
    f.bar = Math.floor(beat / bpb);
    f.beatInBar = ((last % bpb) + bpb) % bpb;
    f.barPhase = (f.beatInBar + f.beatPhase) / bpb;
    f.beatConfidence = 1;
    const si = sectionAt(t);
    const s = timeline[si];
    const next = timeline[si + 1];
    f.section = s?.name ?? '';
    f.sectionKind = s?.kind ?? '';
    sectionIntensity += ((s?.intensity ?? 0.5) - sectionIntensity) * (1 - Math.exp(-dt / 1.5));
    f.sectionIntensity = sectionIntensity;
    if (next && s) {
      const beatsTo = next.startS / spb - beat;
      f.nextEvent = next.kind;
      f.timeToNextEvent = beatsTo * spb;
      f.anticipation = next.kind === 'drop' || next.kind === 'build' ? Math.max(0, Math.min(1, 1 - beatsTo / (bpb * 4))) : 0;
    } else {
      f.nextEvent = '';
      f.timeToNextEvent = Infinity;
      f.anticipation = 0;
    }
    beats.length = 0;
    while (lastBeat < last) {
      lastBeat++;
      beats.push({ beat: lastBeat, bar: Math.floor(lastBeat / bpb), beatInBar: ((lastBeat % bpb) + bpb) % bpb, downbeat: lastBeat % bpb === 0, time: t });
    }
  };

  const chunkS = 24;
  let t = 0;
  for (let from = 0; from < totalS - 1e-6; from += chunkS) {
    const seconds = Math.min(chunkS, totalS - from);
    const pre = from === 0 ? 0 : 6;
    const buffer = await renderSpan(c, from / spb, seconds, pre, opts.intensity ?? 0.65);
    const l = buffer.getChannelData(0);
    const r = buffer.getChannelData(1);
    const first = Math.round(pre * SR);
    const end = Math.min(l.length, first + Math.round(seconds * SR));
    for (let i = first; i < end; i++) {
      hop[hopFill++] = ((l[i] as number) + (r[i] as number)) / 2;
      if (hopFill < HOP) continue;
      hopFill = 0;
      const ht = t + (i - first + 1) / SR;
      analyzer.process(hop, frame);
      processor.process(frame, ht, f);
      // Step the director at 60 Hz up to this hop.
      while (clock + STEP <= ht) {
        clock += STEP;
        timelineAt(clock, STEP);
        const cues = director.update(STEP, clock, f, beats, input);
        const si = sectionAt(clock);
        const acc = accs[si] as Acc;
        acc.add(director.drive);
        all.add(director.drive);
        for (const cue of cues) {
          acc.cues[cue.kind] = (acc.cues[cue.kind] as number) + 1;
          all.cues[cue.kind] = (all.cues[cue.kind] as number) + 1;
        }
      }
    }
    t += (end - first) / SR;
  }
  const sections: DriveSection[] = timeline
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.startS < totalS)
    .map(({ s, i }) => ({ name: s.name, kind: s.kind, intensity: s.intensity, startS: Math.round(s.startS * 10) / 10, endS: Math.round(Math.min(s.endS, totalS) * 10) / 10, ...(accs[i] as Acc).stats() }));
  return { id: c.id, title: c.title, bpm: c.bpm, seconds: Math.round(totalS), sections, ...all.stats() };
}
