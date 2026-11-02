import type { ReactNode } from 'react';
import { usePerf } from '../../rendering/renderer/perfStore';
import { useSettings } from '../../settings/store';

/** Live performance readout (Graphics → Performance overlay). */
export function PerfOverlay(): ReactNode {
  const enabled = useSettings((s) => s.graphics.showPerfOverlay);
  const p = usePerf((s) => s);
  if (!enabled) return null;
  const cpu = Object.entries(p.cpu)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(', ');
  return (
    <div className="perf-overlay" data-testid="perf-overlay" aria-hidden>
      <strong>{p.fps.toFixed(0)} fps</strong>
      <span>
        frame {p.frameMs.toFixed(2)} ms, p95 {p.p95Ms.toFixed(2)}, p99 {p.p99Ms.toFixed(2)}
      </span>
      <span>GPU {p.gpuMs !== null ? `${p.gpuMs.toFixed(2)} ms` : 'n/a'}</span>
      <span>CPU ms: {cpu || 'n/a'}</span>
      <span>
        {p.drawCalls} draws, {(p.triangles / 1000).toFixed(1)}k tris, {p.geometries} geo, {p.textures} tex
      </span>
      <span>
        render {p.renderWidth}×{p.renderHeight}, display {p.displayWidth}×{p.displayHeight} @ {p.refreshHz} Hz
      </span>
      <span>
        {p.backend} on {p.adapter}
        {p.heapMb !== null ? `, heap ${p.heapMb.toFixed(0)} MB` : ''}
      </span>
      {p.stageLoadMs !== null ? (
        <span>
          stage load {p.stageLoadMs.toFixed(0)} ms, compile {p.stageCompileMs?.toFixed(0) ?? '?'} ms
        </span>
      ) : null}
    </div>
  );
}
