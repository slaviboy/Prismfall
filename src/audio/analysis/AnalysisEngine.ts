import workletUrl from './analysis.worklet.ts?worker&url';
import type { AudioEngine } from '../engine/AudioEngine';
import type { AudioFeatures } from './features';
import { AnalyserFrameBuilder } from './dsp/analyserFrame';
import { FeatureProcessor, type ProcessorTuning } from './dsp/featureProcessor';
import { FRAME } from './dsp/frameAnalyzer';

export type AnalysisPath = 'worklet' | 'analyser' | 'none';

const HOP = 512;
const SHORT_FFT = 2048;
const MAX_QUEUE = 256;

interface QueuedFrame {
  time: number;
  frame: Float32Array;
}

/**
 * Music Analysis Engine (brief §24). Taps the music bus before the volume fader and turns the
 * signal into AudioFeatures, via an AudioWorklet (fixed hop, preferred) or an AnalyserNode
 * (read once per render frame). Either way frames are queued with their audio-clock time and
 * applied when they are *heard* (output latency compensated), so visuals stay in sync.
 */
export class AnalysisEngine {
  path: AnalysisPath = 'none';
  processor = new FeatureProcessor(HOP / 48000);
  private hopSeconds = HOP / 48000;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private builder: AnalyserFrameBuilder | null = null;
  private readonly queue: QueuedFrame[] = [];
  private readonly pool: Float32Array[] = [];
  private freq: Float32Array<ArrayBuffer> = new Float32Array(0);
  private time: Float32Array<ArrayBuffer> = new Float32Array(0);
  private lastCaptureTime = -1;
  private lastAppliedTime = -1;
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
    this.builder = new AnalyserFrameBuilder(ctx.sampleRate, fftSize);
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

  private enqueue(time: number): Float32Array {
    const frame = this.pool.pop() ?? new Float32Array(FRAME.size);
    this.queue.push({ time, frame });
    // Never let the queue grow unbounded (e.g. while the tab is hidden).
    while (this.queue.length > MAX_QUEUE) this.pool.push((this.queue.shift() as QueuedFrame).frame);
    return frame;
  }

  private receive(frames: Float32Array, times: Float64Array): void {
    for (let i = 0; i < times.length; i++) this.enqueue(times[i] as number).set(frames.subarray(i * FRAME.size, (i + 1) * FRAME.size));
  }

  /** Analyser path: captures the current block (skipped when the audio clock hasn't advanced). */
  private capture(): void {
    const a = this.analyser;
    const builder = this.builder;
    if (!a || !builder) return;
    const t = this.engine.now;
    if (t <= this.lastCaptureTime) return;
    this.lastCaptureTime = t;
    a.getFloatFrequencyData(this.freq);
    a.getFloatTimeDomainData(this.time);
    builder.build(this.freq, this.time, this.enqueue(t));
  }

  setTuning(t: ProcessorTuning): void {
    this.processor.setTuning(t);
  }

  /** Applies every analysis frame that has been heard by `perfNow`. */
  update(f: AudioFeatures, perfNow: number, dt: number): void {
    void dt;
    const t0 = performance.now();
    if (this.path === 'analyser') this.capture();
    if (this.path !== 'none') {
      while (this.queue.length > 0) {
        const q = this.queue[0] as QueuedFrame;
        if (this.engine.heardAt(q.time) > perfNow) break;
        this.queue.shift();
        // Worklet frames are a fixed hop apart; analyser frames are one render frame apart.
        const step = this.path === 'worklet' || this.lastAppliedTime < 0 ? this.hopSeconds : Math.max(1 / 480, Math.min(0.1, q.time - this.lastAppliedTime));
        this.lastAppliedTime = q.time;
        this.processor.process(q.frame, q.time, f, step);
        this.pool.push(q.frame);
        this.framesProcessed++;
      }
    }
    this.processMs = this.processMs * 0.95 + (performance.now() - t0) * 0.05;
    if (perfNow - this.statsWindowStart > 1000) {
      this.framesPerSecond = (this.framesProcessed * 1000) / (perfNow - this.statsWindowStart);
      this.framesProcessed = 0;
      this.statsWindowStart = perfNow;
    }
  }

  teardown(): void {
    this.node?.disconnect();
    this.node = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.builder = null;
    for (const q of this.queue) this.pool.push(q.frame);
    this.queue.length = 0;
    this.lastCaptureTime = -1;
    this.lastAppliedTime = -1;
    this.path = 'none';
  }
}
