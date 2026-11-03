import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { toast, useApp } from '../../app/stores';
import type { PadInfo } from '../../input/types';
import { controlLabel } from '../../input/mappings/bindings';
import { getSettings, updateSection, useSettings } from '../../settings/store';
import { Button, ChoiceRow } from '../components/controls';
import { registerCustomPanel } from './customPanels';

/** Logical standard-mapping controls the wizard asks for, in order. */
const WIZARD_STEPS: readonly { logical: string; prompt: string }[] = [
  { logical: 'button:0', prompt: 'the bottom face button (Cross / A)' },
  { logical: 'button:1', prompt: 'the right face button (Circle / B)' },
  { logical: 'button:2', prompt: 'the left face button (Square / X)' },
  { logical: 'button:3', prompt: 'the top face button (Triangle / Y)' },
  { logical: 'button:4', prompt: 'the left shoulder button' },
  { logical: 'button:5', prompt: 'the right shoulder button' },
  { logical: 'button:6', prompt: 'the left trigger' },
  { logical: 'button:7', prompt: 'the right trigger' },
  { logical: 'button:8', prompt: 'Select / Share / View' },
  { logical: 'button:9', prompt: 'Start / Options / Menu' },
  { logical: 'button:12', prompt: 'D-pad up' },
  { logical: 'button:13', prompt: 'D-pad down' },
  { logical: 'button:14', prompt: 'D-pad left' },
  { logical: 'button:15', prompt: 'D-pad right' },
  { logical: 'axis:0', prompt: 'the left stick to the right' },
  { logical: 'axis:1', prompt: 'the left stick down' },
];

/** Live view of one pad's buttons and sticks (controller test). */
function PadTester(props: { pad: PadInfo }): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const override = useSettings((s) => s.controller.profiles[props.pad.id]?.family);
  const family = override && override !== 'auto' ? override : props.pad.family;
  useEffect(
    () =>
      shell.onFrame(() => {
        const el = root.current;
        const controls = shell.input.gamepad.logicalSnapshot(props.pad.index);
        const raw = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads()[props.pad.index] : null;
        if (!el || !controls) return;
        el.querySelectorAll<HTMLElement>('[data-control]').forEach((n) => n.classList.toggle('is-down', controls.get(n.dataset.control ?? '') === true));
        el.querySelectorAll<HTMLElement>('[data-stick]').forEach((n) => {
          const i = Number(n.dataset.stick) * 2;
          const x = raw?.axes[i] ?? 0;
          const y = raw?.axes[i + 1] ?? 0;
          (n.firstElementChild as HTMLElement | null)?.style.setProperty('transform', `translate(${x * 22}px, ${y * 22}px)`);
        });
      }),
    [props.pad.index],
  );
  return (
    <div className="pad-tester" ref={root} data-testid="pad-tester">
      <div className="pad-buttons">
        {Array.from({ length: 16 }, (_, i) => (
          <span key={i} className="pad-button" data-control={`button:${i}`}>
            {controlLabel(`button:${i}`, family)}
          </span>
        ))}
      </div>
      <div className="pad-sticks">
        {[0, 1].map((s) => (
          <span key={s} className="pad-stick" data-stick={s} title={s === 0 ? 'Left stick' : 'Right stick'}>
            <span />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Steps through the standard controls, recording the raw control the pad reports for each. */
function MappingWizard(props: { pad: PadInfo; onDone: () => void }): ReactNode {
  const [step, setStep] = useState(0);
  const map = useRef<Record<string, string>>({});
  const current = WIZARD_STEPS[step];
  useEffect(() => {
    const finish = (): void => {
      const c = getSettings().controller;
      const existing = c.profiles[props.pad.id];
      updateSection('controller', { profiles: { ...c.profiles, [props.pad.id]: { name: existing?.name ?? props.pad.name, family: existing?.family ?? 'auto', rawMap: { ...map.current } } } });
      toast(`${props.pad.name} mapped`, 'success');
      props.onDone();
    };
    if (!current) {
      finish();
      return;
    }
    shell.input.gamepad.rawCaptureListener = (padIndex, control) => {
      if (padIndex !== props.pad.index) return;
      map.current[current.logical] = control;
      setStep((s) => s + 1);
    };
    return () => {
      shell.input.gamepad.rawCaptureListener = null;
    };
  }, [current, props]);
  if (!current) return null;
  return (
    <div className="confirm-box wizard" role="status" data-testid="mapping-wizard">
      <p>
        Step {step + 1} of {WIZARD_STEPS.length}: press {current.prompt}.
      </p>
      <div className="settings-actions">
        <Button onClick={() => setStep((s) => s + 1)} testId="wizard-skip">
          Skip this control
        </Button>
        <Button onClick={props.onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/** Connected controllers: active/ignored pads, button-name style, mapping, rumble and a live tester. */
function ControllerPanel(): ReactNode {
  const pads = useApp((s) => s.pads);
  const controller = useSettings((s) => s.controller);
  const [wizard, setWizard] = useState<PadInfo | null>(null);
  const [testing, setTesting] = useState<number | null>(null);

  if (pads.length === 0) {
    return (
      <div className="controller-panel" data-testid="controller-panel">
        <p className="menu-note">No controller detected. Connect one and press any button; PlayStation, Xbox and most standard controllers work over USB or Bluetooth.</p>
      </div>
    );
  }

  const setProfileFamily = (pad: PadInfo, family: 'auto' | 'playstation' | 'xbox' | 'generic'): void => {
    const existing = controller.profiles[pad.id];
    updateSection('controller', { profiles: { ...controller.profiles, [pad.id]: { name: existing?.name ?? pad.name, family, rawMap: existing?.rawMap ?? {} } } });
  };

  return (
    <div className="controller-panel" data-testid="controller-panel">
      {pads.map((pad) => {
        const ignored = controller.ignoredPadIds.includes(pad.id);
        const active = controller.activePadId === pad.id;
        const profile = controller.profiles[pad.id];
        return (
          <section key={`${pad.index}-${pad.id}`} className="pad-card" data-testid={`pad-${pad.index}`}>
            <h3 className="settings-group">
              {pad.name}
              {active ? ' (active)' : ''}
              {ignored ? ' (ignored)' : ''}
            </h3>
            <p className="pad-meta">
              {pad.standard ? 'Standard layout' : 'Non-standard layout: run the mapping wizard'}
              {pad.vibration ? ', rumble supported' : ', no rumble'}
              {profile && Object.keys(profile.rawMap).length > 0 ? ', custom mapping' : ''}
            </p>
            <ChoiceRow
              label="Button names"
              value={profile?.family ?? 'auto'}
              options={[
                { value: 'auto', label: `Automatic (${pad.family === 'playstation' ? 'PlayStation' : pad.family === 'xbox' ? 'Xbox' : 'generic'})` },
                { value: 'playstation', label: 'PlayStation' },
                { value: 'xbox', label: 'Xbox' },
                { value: 'generic', label: 'Generic' },
              ]}
              onChange={(v) => setProfileFamily(pad, v)}
              testId={`pad-family-${pad.index}`}
            />
            <div className="settings-actions">
              {pads.length > 1 ? (
                <Button onClick={() => updateSection('controller', { activePadId: active ? null : pad.id })} testId={`pad-active-${pad.index}`}>
                  {active ? 'Use any controller' : 'Use only this controller'}
                </Button>
              ) : null}
              <Button
                onClick={() => updateSection('controller', { ignoredPadIds: ignored ? controller.ignoredPadIds.filter((id) => id !== pad.id) : [...controller.ignoredPadIds, pad.id] })}
                testId={`pad-ignore-${pad.index}`}
                title="For duplicates created by Steam Input or DS4Windows"
              >
                {ignored ? 'Stop ignoring' : 'Ignore this controller'}
              </Button>
              <Button onClick={() => setWizard(pad)} testId={`pad-map-${pad.index}`}>
                Map buttons
              </Button>
              {profile && Object.keys(profile.rawMap).length > 0 ? (
                <Button onClick={() => updateSection('controller', { profiles: { ...controller.profiles, [pad.id]: { ...profile, rawMap: {} } } })}>Clear mapping</Button>
              ) : null}
              <Button onClick={() => setTesting(testing === pad.index ? null : pad.index)} testId={`pad-test-${pad.index}`}>
                {testing === pad.index ? 'Hide tester' : 'Test buttons'}
              </Button>
              {pad.vibration ? (
                <Button onClick={() => shell.input.gamepad.rumble(0.8 * controller.rumbleStrength, 0.6 * controller.rumbleStrength, 260)} testId={`pad-rumble-${pad.index}`}>
                  Test rumble
                </Button>
              ) : null}
            </div>
            {wizard?.index === pad.index ? <MappingWizard pad={pad} onDone={() => setWizard(null)} /> : null}
            {testing === pad.index ? <PadTester pad={pad} /> : null}
          </section>
        );
      })}
    </div>
  );
}

registerCustomPanel('controller', ControllerPanel);
