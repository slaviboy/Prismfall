import type { ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { toast, useApp } from '../../app/stores';
import { recommendPreset } from '../../settings/presets';
import { updateSection } from '../../settings/store';
import { usePerf } from '../../rendering/renderer/perfStore';
import { Button } from '../components/controls';
import { registerCustomPanel } from './customPanels';

function GraphicsInfo(): ReactNode {
  const renderer = useApp((s) => s.renderer);
  const perf = usePerf((p) => p);
  return (
    <dl className="info-grid" data-testid="graphics-info">
      <div>
        <dt>Renderer</dt>
        <dd>{renderer ? `${renderer.backend === 'webgpu' ? 'WebGPU' : renderer.backend === 'webgl2' ? 'WebGL 2' : 'Canvas 2D'}` : '…'}</dd>
      </div>
      <div>
        <dt>Graphics adapter</dt>
        <dd>{renderer?.adapter ?? '…'}</dd>
      </div>
      <div>
        <dt>Display</dt>
        <dd>
          {perf.displayWidth} × {perf.displayHeight} at {perf.refreshHz} Hz
        </dd>
      </div>
      <div>
        <dt>Rendering</dt>
        <dd>
          {perf.renderWidth} × {perf.renderHeight} ({Math.round(perf.renderScale * 100)}% of the window)
        </dd>
      </div>
    </dl>
  );
}

function GraphicsActions(): ReactNode {
  const restore = (): void => {
    const sys = shell.renderSystem;
    const preset = recommendPreset(
      sys ? { backend: sys.adapter.backend, vendor: sys.adapter.vendor, architecture: sys.adapter.architecture, description: sys.adapter.description, isFallbackAdapter: sys.adapter.isFallbackAdapter } : null,
    );
    updateSection('graphics', { preset, upscaler: 'fsr1', dynamicResolution: false, fpsCap: 'display', motionBlur: 0 });
    toast(`Recommended settings applied (${preset[0]?.toUpperCase()}${preset.slice(1)})`, 'success');
  };
  return (
    <div className="settings-actions">
      <Button onClick={restore} testId="graphics-recommended">
        Restore recommended graphics
      </Button>
      <Button onClick={() => void document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen was blocked by the browser.', 'warning'))} testId="graphics-fullscreen">
        Enter fullscreen
      </Button>
    </div>
  );
}

registerCustomPanel('graphicsInfo', GraphicsInfo);
registerCustomPanel('graphicsActions', GraphicsActions);
