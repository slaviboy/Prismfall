import workletUrl from './analysis.worklet.ts?worker&url';
import type { AudioEngine } from '../engine/AudioEngine';
import type { AudioFeatures } from './features';
import { BandMapper, DEFAULT_BANDS, logBars, powerToDb } from './dsp/bands';
import { FeatureProcessor, type ProcessorTuning } from './dsp/featureProcessor';
import { BAND_COUNT, BAR_COUNT, FRAME, fluxCompress, rectifiedFlux } from './dsp/frameAnalyzer';

export type AnalysisPath = 'worklet' | 'analyser' | 'none';

const HOP = 512;
const SHORT_FFT = 2048;
/** Analyser magnitudes (|X|/N, Blackman) scaled to the worklet's calibration (full-scale sine ≈ 0.8). */
const ANALYSER_MAG_SCALE = 3.9;

interface QueuedFrame {
  time: number;
  frame: Float32Array;
}

/**
 * Music Analysis Engine (brief §24). Taps the music bus before the volume fader and turns the
 * signal into AudioFeatures, via an AudioWorklet (fixed hop, preferred) or an AnalyserNode.
 * Frames are applied when they are *heard* (output latency compensated), so visuals stay in sync.
 */
export class AnalysisEngine {
  path: AnalysisPath = 'none';
  processor = new FeatureProcessor(HOP / 48000);
  private readonly bandOut = new Float32Array(BAND_COUNT);
  private readonly barOut = new Float32Array(BAR_COUNT);
  private hopSeconds = HOP / 48000;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly queue: QueuedFrame[] = [];
  private readonly pool: Float32Array[] = [];
  private freq: Float32Array<ArrayBuffer> = new Float32Array(0);
  private time: Float32Array<ArrayBuffer> = new Float32Array(0);
  private prevLog: Float32Array = new Float32Array(0);
  private curLog: Float32Array = new Float32Array(0);
  private bands: BandMapper | null = null;
  private bars: BandMapper | null = null;
  private readonly frame = new Float32Array(FRAME.size);
  private readonly power: Float32Array[] = [];
  private framesProcessed = 0;
  private statsWindowStart = performance.now();
  framesPerSecond = 0;
  processMs = 0;
  fftSize = 4096;
  /** Exposes the raw analyser for the developer dashboard spectrum. */
  get analyserNode(): AnalyserNode | null {
    return this.analyser;
  }

  constructor(private readonly engine: AudioEngine) {}

  async setup(preference: 'auto' | 'worklet' | 'analyser', fftSize: 2048 | 4096): Promise<AnalysisPath> {
    const ctx = this.engine.ctx;
    if (!ctx) return 'none';
    this.teardown();
    this.fftSize = fftSize;
    // The analyser always exists (dashboard spectrum, fallback path).
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -110;
    analyser.maxDecibels = -10;
    this.engine.analysisTap.connect(analyser);
    this.analyser = analyser;
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.time = new Float32Array(fftSize);
    this.prevLog = new Float32Array(analyser.frequencyBinCount);
    this.curLog = new Float32Array(analyser.frequencyBinCount);
    this.bands = new BandMapper(ctx.sampleRate, fftSize, DEFAULT_BANDS);
    this.bars = new BandMapper(ctx.sampleRate, fftSize, logBars(BAR_COUNT));
    // Rebuild the processor for the real sample rate (hop duration drives tempo estimation).
    const tuning = this.processor.tuning;
    this.hopSeconds = HOP / ctx.sampleRate;
    this.processor = new FeatureProcessor(this.hopSeconds);
    this.processor.setTuning(tuning);

    if (preference !== 'analyser' && typeof AudioWorkletNode !== 'undefined') {
      try {
        await ctx.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(ctx, 'prismfall-analysis', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 2,
          channelCountMode: 'explicit',
          processorOptions: { longSize: fftSize, shortSize: SHORT_FFT, hop: HOP },
        });
        node.port.onmessage = (e: MessageEvent<{ frames: Float32Array<ArrayBuffer>; times: Float64Array<ArrayBuffer> }>) => {
          this.receive(e.data.frames, e.data.times);
          // Hand the batch buffers back so the audio thread never allocates.
          node.port.postMessage({ frames: e.data.frames, times: e.data.times }, [e.data.frames.buffer, e.data.times.buffer]);
        };
        this.processor.onsetLatencyS = (SHORT_FFT + HOP) / 2 / ctx.sampleRate;
        this.engine.analysisTap.connect(node);
        this.node = node;
        this.path = 'worklet';
        return this.path;
      } catch (err) {
        console.warn('[analysis] AudioWorklet unavailable, using AnalyserNode', err);
      }
    }
    this.path = 'analyser';
    this.processor.onsetLatencyS = fftSize / 2 / ctx.sampleRate;
    return this.path;
  }

  private receive(frames: Float32Array, times: Float64Array): void {
    for (let i = 0; i < times.length; i++) {
      const frame = this.pool.pop() ?? new Float32Array(FRAME.size);
      frame.set(frames.subarray(i * FRAME.size, (i + 1) * FRAME.size));
      this.queue.push({ time: times[i] as number, frame });
    }
    // Never let the queue grow unbounded (e.g. while the tab is hidden).
    while (this.queue.length > 256) this.pool.push((this.queue.shift() as QueuedFrame).frame);
  }

  setTuning(t: ProcessorTuning): void {
    this.processor.setTuning(t);
  }

  /** Applies all frames heard by `perfNow` (worklet) or analyses the current block (analyser). */
  update(f: AudioFeatures, perfNow: number, dt: number): void {
    const t0 = performance.now();
    if (this.path === 'worklet') {
      while (this.queue.length > 0) {
        const q = this.queue[0] as QueuedFrame;
        if (this.engine.heardAt(q.time) > perfNow) break;
        this.queue.shift();
        this.processor.process(q.frame, q.time, f, this.hopSeconds);
        this.pool.push(q.frame);
        this.framesProcessed++;
      }
    } else if (this.path === 'analyser' && this.analyser && this.bands && this.bars) {
      this.analyseBlock(f, dt);
      this.framesProcessed++;
    }
    this.processMs = this.processMs * 0.95 + (performance.now() - t0) * 0.05;
    if (perfNow - this.statsWindowStart > 1000) {
      this.framesPerSecond = (this.framesProcessed * 1000) / (perfNow - this.statsWindowStart);
      this.framesProcessed = 0;
      this.statsWindowStart = perfNow;
    }
  }

  private analyseBlock(f: AudioFeatures, dt: number): void {
    const a = this.analyser as AnalyserNode;
    a.getFloatFrequencyData(this.freq);
    a.getFloatTimeDomainData(this.time);
    const n = this.freq.length;
    if (this.power.length === 0) this.power.push(new Float32Array(n + 1));
    const power = this.power[0] as Float32Array;
    let wsum = 0;
    let psum = 0;
    const binHz = (this.engine.ctx?.sampleRate ?? 48000) / this.fftSize;
    for (let k = 0; k < n; k++) {
      const db = this.freq[k] as number;
      const p = Math.pow(10, db / 10);
      power[k] = p;
      this.curLog[k] = fluxCompress(ANALYSER_MAG_SCALE * Math.sqrt(p));
      wsum += k * binHz * p;
      psum += p;
    }
    const flux = rectifiedFlux(this.curLog, this.prevLog, 1);
    (this.bands as BandMapper).energies(power, this.bandOut);
    for (let b = 0; b < BAND_COUNT; b++) this.frame[FRAME.bands + b] = powerToDb((this.bandOut[b] as number) * 2);
    (this.bars as BandMapper).energies(power, this.barOut);
    for (let b = 0; b < BAR_COUNT; b++) this.frame[FRAME.bars + b] = powerToDb((this.barOut[b] as number) * 2);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = this.time[i] as number;
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    this.frame[FRAME.rms] = 20 * Math.log10(Math.max(1e-7, Math.sqrt(sum / this.time.length)));
    this.frame[FRAME.peak] = 20 * Math.log10(Math.max(1e-7, peak));
    this.frame[FRAME.flux] = flux;
    this.frame[FRAME.centroid] = psum > 0 ? wsum / psum : 0;
    this.processor.process(this.frame, this.engine.now, f, Math.max(1 / 480, dt));
  }

  teardown(): void {
    this.node?.disconnect();
    this.node = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.queue.length = 0;
    this.path = 'none';
  }
}
