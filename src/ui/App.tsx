import { Component, type ErrorInfo, type ReactNode } from 'react';
import { shell } from '../app/GameShell';
import { goBack, navigate, useApp } from '../app/stores';
import { getSettings, updateSection, useSettings } from '../settings/store';
import type { ModeId } from '../game/modes/modes';
import { getMode, getVariant } from '../game/modes/modes';
import { Hud } from './hud/Hud';
import { PauseOverlay } from './menus/PauseOverlay';
import { BootScreen, CreditsScreen, HighScoresScreen, MainMenu, ModeSelectScreen, ModeSetupScreen, ResultsScreen } from './menus/screens';
import { SettingsScreen } from './settings/SettingsScreen';
import { useNavScope } from './navigation/useNavScope';
import { reducedMotion } from '../settings/store';
import { PerfOverlay } from './hud/PerfOverlay';
import './settings/graphicsPanels';

function Toasts(): ReactNode {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast tone-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function ReplayControls(): ReactNode {
  const ref = useNavScope<HTMLDivElement>({
    onBack: () => {
      shell.stopReplay();
      goBack();
    },
  });
  const r = shell.replaySession;
  return (
    <div className="replay-bar" data-nav-scope ref={ref} data-testid="replay-bar">
      <span>
        Replay: {r?.mode.name ?? ''}, {r ? getVariant(getMode(r.mode.id), r.replay.variantId).label : ''}
      </span>
      <button type="button" className="btn" data-focusable data-autofocus onClick={() => r?.togglePause(performance.now())}>
        Pause or play
      </button>
      <button
        type="button"
        className="btn"
        data-focusable
        onClick={() => {
          shell.stopReplay();
          goBack();
        }}
      >
        Close replay
      </button>
    </div>
  );
}

export function App(): ReactNode {
  const screen = useApp((s) => s.screen);
  const fatal = useApp((s) => s.fatalError);
  const lastMode = useSettings((s) => s.setup.lastMode);
  const animations = useSettings((s) => s.interface.menuAnimations && !reducedMotion(s));

  if (fatal) {
    return (
      <div className="fatal" role="alert">
        <h1>Prismfall could not start</h1>
        <p>{fatal}</p>
      </div>
    );
  }

  const pickMode = (id: ModeId): void => {
    updateSection('setup', { lastMode: id });
    navigate('setup');
  };

  const start = (): void => {
    const s = getSettings();
    const mode = getMode(s.setup.lastMode);
    const variantId = getVariant(mode, s.setup.variants[mode.id] ?? mode.defaultVariant).id;
    shell.startGame({ modeId: mode.id, variantId, stageId: s.setup.stageId });
  };

  return (
    <div className={`ui-layer ${animations ? 'animated' : 'still'}`} data-screen={screen}>
      {screen === 'boot' ? <BootScreen onStart={() => navigate('main', true)} /> : null}
      {screen === 'main' ? <MainMenu /> : null}
      {screen === 'modes' ? <ModeSelectScreen onPick={pickMode} /> : null}
      {screen === 'setup' ? <ModeSetupScreen modeId={lastMode} onStart={start} /> : null}
      {screen === 'results' ? <ResultsScreen /> : null}
      {screen === 'highscores' ? <HighScoresScreen /> : null}
      {screen === 'settings' ? <SettingsScreen /> : null}
      {screen === 'credits' ? <CreditsScreen /> : null}
      {screen === 'game' || screen === 'replay' ? <Hud /> : null}
      {screen === 'game' ? <PauseOverlay /> : null}
      {screen === 'replay' ? <ReplayControls /> : null}
      <PerfOverlay />
      <Toasts />
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="fatal" role="alert">
          <h1>The interface hit an error</h1>
          <p>{this.state.error.message}</p>
          <button type="button" className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
