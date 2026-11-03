import { renderStormJob, type StormWorkerRequest, type StormWorkerResponse } from './stormJobs';

/** Thunder, cracks and rain loops are synthesised off the main thread (a thunder takes 0.1-0.2 s). */
self.onmessage = (e: MessageEvent<StormWorkerRequest>) => {
  const post = (msg: StormWorkerResponse, transfer: Transferable[] = []): void => (self as unknown as { postMessage(m: StormWorkerResponse, t: Transferable[]): void }).postMessage(msg, transfer);
  const t0 = performance.now();
  try {
    const b = renderStormJob(e.data.job);
    post({ id: e.data.id, left: b.left, right: b.right, sampleRate: b.sampleRate, ms: performance.now() - t0 }, [b.left.buffer, b.right.buffer]);
  } catch (err) {
    post({ id: e.data.id, error: err instanceof Error ? err.message : String(err) });
  }
};
