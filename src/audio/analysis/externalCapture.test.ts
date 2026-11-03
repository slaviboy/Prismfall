import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../engine/AudioEngine';
import { ExternalCapture } from './externalCapture';

class FakeTrack extends EventTarget {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

function setup(audioTracks: number) {
  const audio = Array.from({ length: audioTracks }, () => new FakeTrack());
  const video = [new FakeTrack()];
  const stream = { getAudioTracks: () => audio, getVideoTracks: () => video, getTracks: () => [...audio, ...video] };
  const source = { disconnect: vi.fn() };
  const engine = { ctx: { createMediaStreamSource: vi.fn(() => source) }, setAnalysisInput: vi.fn() };
  const getDisplayMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  return { audio, video, source, engine, getDisplayMedia };
}

afterEach(() => vi.unstubAllGlobals());

describe('ExternalCapture', () => {
  it('routes shared audio into analysis only and restores the music on stop', async () => {
    const { audio, video, source, engine } = setup(1);
    const capture = new ExternalCapture(engine as unknown as AudioEngine);
    expect(await capture.start()).toBe('ok');
    expect(video[0]!.stopped).toBe(true);
    expect(engine.setAnalysisInput).toHaveBeenLastCalledWith(source);
    capture.stop();
    expect(engine.setAnalysisInput).toHaveBeenLastCalledWith(null);
    expect(audio[0]!.stopped).toBe(true);
    expect(capture.active).toBe(false);
  });

  it('reports a share without audio and keeps the game music', async () => {
    const { engine } = setup(0);
    const capture = new ExternalCapture(engine as unknown as AudioEngine);
    expect(await capture.start()).toBe('no-audio');
    expect(engine.setAnalysisInput).not.toHaveBeenCalled();
  });

  it('stops by itself when sharing ends in the browser', async () => {
    const { audio, engine } = setup(1);
    const ended = vi.fn();
    const capture = new ExternalCapture(engine as unknown as AudioEngine, ended);
    await capture.start();
    audio[0]!.dispatchEvent(new Event('ended'));
    expect(ended).toHaveBeenCalled();
    expect(engine.setAnalysisInput).toHaveBeenLastCalledWith(null);
  });

  it('treats a dismissed prompt as cancelled', async () => {
    const { engine, getDisplayMedia } = setup(1);
    getDisplayMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    expect(await new ExternalCapture(engine as unknown as AudioEngine).start()).toBe('cancelled');
  });
});
