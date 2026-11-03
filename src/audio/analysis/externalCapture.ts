import type { AudioEngine } from '../engine/AudioEngine';

export type CaptureResult = 'ok' | 'no-audio' | 'cancelled' | 'unsupported';

/**
 * Experimental (developer tools): analyse audio from outside the game, such as a music player in
 * another tab or the whole system. A page cannot listen to other applications on its own, so the
 * player picks what to share in the browser's screen-sharing prompt and must include its audio.
 * The captured sound replaces the game music as the analysis input; it is never played back.
 */
export class ExternalCapture {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(
    private readonly engine: AudioEngine,
    private readonly onEnded: () => void = () => undefined,
  ) {}

  static supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  get active(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<CaptureResult> {
    const ctx = this.engine.ctx;
    if (!ctx || !ExternalCapture.supported()) return 'unsupported';
    this.stop();
    let stream: MediaStream;
    try {
      // Chrome only offers audio together with a video surface; the video track is dropped at once.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch {
      return 'cancelled';
    }
    const audio = stream.getAudioTracks();
    stream.getVideoTracks().forEach((t) => t.stop());
    if (audio.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      return 'no-audio';
    }
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.engine.setAnalysisInput(this.source);
    // Sharing stopped from the browser's own "Stop sharing" bar.
    audio[0]!.addEventListener('ended', () => {
      if (this.stream === stream) {
        this.stop();
        this.onEnded();
      }
    });
    return 'ok';
  }

  stop(): void {
    if (!this.stream) return;
    this.engine.setAnalysisInput(null);
    this.source?.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
  }
}
