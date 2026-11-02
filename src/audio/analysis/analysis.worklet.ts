import { FRAME, FrameAnalyzer } from './dsp/frameAnalyzer';

const BATCH = 4;

interface Options {
  longSize: number;
  shortSize: number;
  hop: number;
}

/**
 * Audio-thread analysis: downmixes the music bus to mono and runs the shared DSP core at a
 * fixed hop (512 samples ≈ 10.7 ms), independent of the render frame rate. Frames are stamped
 * with audio-clock time and posted to the main thread in small batches.
 */
class PrismfallAnalysisProcessor extends AudioWorkletProcessor {
  private analyzer: FrameAnalyzer;
  private hop: number;
  private buffer: Float32Array;
  private fill = 0;
  private frames: Float32Array;
  private times: Float64Array;
  private count = 0;

  constructor(options: { processorOptions?: Options }) {
    super();
    const o = options.processorOptions ?? { longSize: 4096, shortSize: 1024, hop: 512 };
    this.hop = o.hop;
    this.analyzer = new FrameAnalyzer(sampleRate, o.longSize, o.shortSize, o.hop);
    this.buffer = new Float32Array(o.hop);
    this.frames = new Float32Array(FRAME.size * BATCH);
    this.times = new Float64Array(BATCH);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0] as Float32Array;
    const right = (input[1] ?? left) as Float32Array;
    for (let i = 0; i < left.length; i++) {
      this.buffer[this.fill++] = ((left[i] as number) + (right[i] as number)) * 0.5;
      if (this.fill === this.hop) {
        this.fill = 0;
        this.analyzer.process(this.buffer, this.frames.subarray(this.count * FRAME.size, (this.count + 1) * FRAME.size));
        this.times[this.count] = currentTime + (i + 1) / sampleRate;
        this.count++;
        if (this.count === BATCH) {
          this.port.postMessage({ frames: this.frames, times: this.times }, [this.frames.buffer, this.times.buffer]);
          this.frames = new Float32Array(FRAME.size * BATCH);
          this.times = new Float64Array(BATCH);
          this.count = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('prismfall-analysis', PrismfallAnalysisProcessor);
