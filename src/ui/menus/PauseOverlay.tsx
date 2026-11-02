import type { ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { appStore, useApp } from '../../app/stores';
import { MenuItem, MenuList } from '../components/controls';
import { useNavScope } from '../navigation/useNavScope';
import { SettingsPanel } from '../settings/SettingsScreen';

export function PauseOverlay(): ReactNode {
  const paused = useApp((s) => s.paused);
  const view = useApp((s) => s.pauseView);
  if (!paused) return null;
  return view === 'settings' ? <PauseSettings /> : <PauseMenu />;
}

function PauseMenu(): ReactNode {
  const ref = useNavScope<HTMLDivElement>({ onBack: () => shell.resume() });
  const practice = shell.session?.mode.id === 'practice';
  return (
    <div className="pause-overlay" data-nav-scope data-nav-modal ref={ref} data-testid="pause-menu">
      <div className="pause-panel">
        <h2 className="pause-title">Paused</h2>
        <MenuList>
          <MenuItem label="Resume" onSelect={() => shell.resume()} autoFocus testId="pause-resume" />
          {practice ? <MenuItem label="Undo last piece" onSelect={() => shell.practiceUndo()} testId="pause-undo" /> : null}
          {practice ? <MenuItem label="Reset board" onSelect={() => shell.practiceReset()} testId="pause-reset" /> : null}
          <MenuItem label="Restart" onSelect={() => shell.restart()} testId="pause-restart" />
          <MenuItem label="Settings" onSelect={() => appStore.setState({ pauseView: 'settings' })} testId="pause-settings" />
          <MenuItem label="Quit to menu" onSelect={() => shell.quitToMenu()} testId="pause-quit" />
        </MenuList>
      </div>
    </div>
  );
}

function PauseSettings(): ReactNode {
  return (
    <div className="pause-overlay settings" data-testid="pause-settings-view">
      <SettingsPanel inGame onClose={() => appStore.setState({ pauseView: 'menu' })} />
    </div>
  );
}
