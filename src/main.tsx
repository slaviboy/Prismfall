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
  const navigator = new MenuNavigator(shell.input);
  navigator.attach();
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
  if (__PRISMFALL_HOOKS__) {
    (window as unknown as Record<string, unknown>).__PRISMFALL__ = { shell, appStore, hudStore, settingsStore, progressStore, navigator, updateSection, getSettings, perfStore };
  }
}

void boot();
