import '@fontsource-variable/unbounded';
import '@fontsource-variable/atkinson-hyperlegible-next';
import './ui/styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { shell } from './app/GameShell';
import { appStore, hudStore } from './app/stores';
import { progressStore } from './app/progressStore';
import { getSettings, settingsStore, updateSection } from './settings/store';
import { App, ErrorBoundary } from './ui/App';
import { MenuNavigator } from './ui/navigation/MenuNavigator';
import { perfStore } from './rendering/renderer/perfStore';

async function boot(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const root = createRoot(document.getElementById('root') as HTMLElement);
  try {
    await shell.init(canvas);
  } catch (err) {
    console.error('[boot] initialisation failed', err);
    appStore.setState({ fatalError: err instanceof Error ? err.message : String(err) });
  }
  // ?devtools turns on developer mode with the audio analysis dashboard; F9 toggles the dashboard.
  if (new URLSearchParams(location.search).has('devtools')) updateSection('developer', { enabled: true, audioDashboard: true });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F9' || !getSettings().developer.enabled) return;
    e.preventDefault();
    updateSection('developer', { audioDashboard: !getSettings().developer.audioDashboard });
  });
  const navigator = new MenuNavigator(shell.input);
  navigator.attach();
  navigator.onNavigate = (kind) => {
    if (kind === 'move' || kind === 'tab') shell.audio.play('menuMove');
    else if (kind === 'adjust') shell.audio.play('menuSelect');
    else if (kind === 'confirm') shell.audio.play('menuConfirm');
    else if (kind === 'back') shell.audio.play('menuBack');
  };
  // Any later input also tries to start audio (covers reloads that skip the boot screen).
  shell.input.onAnyInput((e) => {
    if (e.control !== 'Escape') shell.unlockAudio();
  });
  window.addEventListener('pointerdown', () => shell.unlockAudio());
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  if (__PRISMFALL_HOOKS__) {
    (window as unknown as Record<string, unknown>).__PRISMFALL__ = { shell, appStore, hudStore, settingsStore, progressStore, navigator, updateSection, getSettings, perfStore, lab: () => import('./audio/lab/AudioLab'), labProfile: () => import('./audio/lab/pathProfile'), blockPresets: () => import('./rendering/materials/blockPresets') };
  }
}

void boot();
