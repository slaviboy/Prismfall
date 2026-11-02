import { useState, type ReactNode } from 'react';
import { goBack } from '../../app/stores';
import type { Settings, SettingsSection } from '../../settings/schema';
import { resetSection, updateSection, useSettings } from '../../settings/store';
import { Button, ChoiceRow, SliderRow, Tabs, ToggleRow } from '../components/controls';
import { useNavScope } from '../navigation/useNavScope';
import { ControlHints } from '../menus/MenuScreen';
import { useConfirmBackLabels } from '../hints';
import { TABS, type SettingDef, type TabId } from './definitions';
import { DataPanel } from './DataPanel';
import { CUSTOM_PANELS } from './customPanels';

function readValue(s: Settings, section: SettingsSection, key: string): unknown {
  return (s[section] as Record<string, unknown>)[key];
}

function Row(props: { def: SettingDef; settings: Settings }): ReactNode {
  const { def, settings } = props;
  if (def.kind === 'group') return <h3 className="settings-group">{def.label}</h3>;
  if (def.kind === 'custom') {
    if (def.id === 'data') return <DataPanel />;
    const Panel = CUSTOM_PANELS[def.id];
    return Panel ? <Panel /> : null;
  }
  if (def.when && !def.when(settings)) return null;
  const value = readValue(settings, def.section, def.key);
  const set = (v: unknown): void => updateSection(def.section, { [def.key]: v } as Partial<Settings[typeof def.section]>);
  const testId = `setting-${def.section}-${def.key}`;
  if (def.kind === 'toggle') return <ToggleRow label={def.label} description={def.description} value={Boolean(value)} onChange={set} testId={testId} />;
  if (def.kind === 'slider')
    return (
      <SliderRow
        label={def.label}
        description={def.description}
        value={Number(value)}
        min={def.min}
        max={def.max}
        step={def.step}
        format={def.format}
        onChange={set}
        testId={testId}
      />
    );
  return <ChoiceRow label={def.label} description={def.description} value={value as string | number} options={def.options} onChange={set} testId={testId} />;
}

/** The settings UI; used full-screen from the menu and as a panel from the pause menu. */
export function SettingsPanel(props: { inGame?: boolean; onClose: () => void }): ReactNode {
  const settings = useSettings((s) => s);
  const developer = settings.developer.enabled;
  const tabs = TABS.filter((t) => (props.inGame ? t.inGame : true) && (t.id !== 'developer' || developer));
  const [tabId, setTabId] = useState<TabId>(tabs[0]?.id ?? 'gameplay');
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];
  const step = (d: number): void => {
    const i = tabs.findIndex((t) => t.id === tabId);
    const next = tabs[(i + d + tabs.length) % tabs.length];
    if (next) setTabId(next.id);
  };
  const ref = useNavScope<HTMLDivElement>({ onBack: props.onClose, onTab: step });
  const { confirm, back } = useConfirmBackLabels();
  if (!tab) return null;
  return (
    <div className="settings-panel" data-nav-scope data-nav-modal={props.inGame ? '' : undefined} ref={ref} data-testid="settings-panel">
      <header className="settings-header">
        <h1 className="menu-title">Settings</h1>
        <Tabs tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} value={tab.id} onChange={setTabId} />
      </header>
      <div className="settings-rows" key={tab.id} data-testid={`settings-tab-${tab.id}`}>
        {tab.rows.map((def, i) => (
          <Row key={`${tab.id}-${i}`} def={def} settings={settings} />
        ))}
        <div className="settings-actions">
          {tab.resets ? (
            <Button onClick={() => tab.resets?.forEach((section) => resetSection(section))} testId="settings-reset-tab">
              Restore defaults for {tab.label.toLowerCase()}
            </Button>
          ) : null}
          <Button onClick={props.onClose} testId="settings-close">
            Done
          </Button>
        </div>
      </div>
      <ControlHints
        hints={[
          { keys: confirm, label: 'Change' },
          { keys: back, label: 'Done' },
          { keys: 'Q / E', label: 'Switch tab' },
        ]}
      />
    </div>
  );
}

export function SettingsScreen(): ReactNode {
  return (
    <div className="settings-screen">
      <div className="menu-scrim" aria-hidden />
      <SettingsPanel onClose={() => goBack()} />
    </div>
  );
}
