import { useRef, useState, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { progressStore } from '../../app/progressStore';
import { toast } from '../../app/stores';
import { defaultSettings } from '../../settings/schema';
import { replaceSettings, updateSection, useSettings } from '../../settings/store';
import { emptyProgress, exportSave, importSave } from '../../storage/repositories';
import { Button, ToggleRow } from '../components/controls';

export function DataPanel(): ReactNode {
  const unlockAll = useSettings((s) => s.setup.unlockAll);
  const developer = useSettings((s) => s.developer.enabled);
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<'progress' | 'settings' | null>(null);

  const doExport = async (): Promise<void> => {
    const data = await exportSave(shell.backend);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `prismfall-save-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Save exported', 'success');
  };

  const doImport = async (file: File): Promise<void> => {
    try {
      await importSave(shell.backend, JSON.parse(await file.text()));
      const { settings } = await shell.settingsRepo.load();
      replaceSettings(settings);
      progressStore.setState({ progress: await shell.progressRepo.load(), lifetime: await shell.statsRepo.load() });
      toast('Save imported', 'success');
    } catch (err) {
      console.error(err);
      toast('That file is not a Prismfall save.', 'warning');
    }
  };

  const doReset = async (what: 'progress' | 'settings'): Promise<void> => {
    if (what === 'progress') {
      await shell.saveProgress(emptyProgress());
      toast('Progress reset', 'success');
    } else {
      replaceSettings(defaultSettings());
      toast('Settings restored to defaults', 'success');
    }
    setConfirming(null);
  };

  return (
    <div className="data-panel">
      <ToggleRow
        label="Unlock every stage"
        description="Skips progression requirements. Completion records are unaffected."
        value={unlockAll}
        onChange={(v) => updateSection('setup', { unlockAll: v })}
        testId="setting-unlock-all"
      />
      <ToggleRow
        label="Developer tools"
        description="Adds the Developer tab: audio analysis dashboard and detailed performance data."
        value={developer}
        onChange={(v) => updateSection('developer', { enabled: v })}
        testId="setting-developer"
      />
      <div className="data-actions">
        <Button onClick={() => void doExport()} testId="data-export">Export save file</Button>
        <Button onClick={() => fileRef.current?.click()} testId="data-import">Import save file</Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
            e.target.value = '';
          }}
        />
      </div>
      <p className="setting-desc">Saves live in this browser ({shell.backend?.kind ?? 'unknown'} storage) for this address and port. Export a file to back them up or move them.</p>
      {confirming ? (
        <div className="confirm-box" role="alertdialog">
          <p>{confirming === 'progress' ? 'Erase stage progress and unlocks? High scores and settings stay.' : 'Restore every setting, including controls, to its default?'}</p>
          <div className="data-actions">
            <Button tone="danger" onClick={() => void doReset(confirming)} autoFocus testId="data-confirm-reset">
              {confirming === 'progress' ? 'Erase progress' : 'Restore defaults'}
            </Button>
            <Button onClick={() => setConfirming(null)}>Keep everything</Button>
          </div>
        </div>
      ) : (
        <div className="data-actions">
          <Button tone="danger" onClick={() => setConfirming('progress')} testId="data-reset-progress">Erase progress</Button>
          <Button tone="danger" onClick={() => setConfirming('settings')} testId="data-reset-settings">Restore all settings</Button>
        </div>
      )}
    </div>
  );
}
