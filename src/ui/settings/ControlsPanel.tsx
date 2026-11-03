import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { appStore, toast, useApp } from '../../app/stores';
import { ACTION_LABELS, assignBinding, clearBinding, controlLabel, findConflicts, REQUIRED_ACTIONS, type Bindings, type ConflictResolution } from '../../input/mappings/bindings';
import { DEFAULT_GAMEPAD, DEFAULT_KEYBOARD, type InputAction } from '../../settings/schema';
import { getSettings, updateSection, useSettings } from '../../settings/store';
import { Button, Tabs } from '../components/controls';
import { registerCustomPanel } from './customPanels';
import { Glyph } from '../components/Glyph';

type Device = 'keyboard' | 'gamepad';

const GROUPS: readonly { label: string; actions: readonly InputAction[] }[] = [
  { label: 'Movement', actions: ['moveLeft', 'moveRight', 'softDrop', 'hardDrop'] },
  { label: 'Rotation and hold', actions: ['rotateCW', 'rotateCCW', 'rotate180', 'hold'] },
  { label: 'Game', actions: ['pause', 'practiceUndo', 'practiceReset'] },
  { label: 'Menus', actions: ['confirm', 'back'] },
];

interface Capture {
  readonly device: Device;
  readonly action: InputAction;
  readonly slot: number;
}

interface Conflict extends Capture {
  readonly control: string;
  readonly others: readonly InputAction[];
}

/**
 * Rebinding for keyboard and controller: two controls per action, captured from the device.
 * Conflicts in the same context offer swap or replace; required actions can't be left unbound.
 */
function ControlsPanel(): ReactNode {
  const [device, setDevice] = useState<Device>(() => (appStore.getState().device === 'gamepad' ? 'gamepad' : 'keyboard'));
  const keyboard = useSettings((s) => s.keyboard);
  const gamepad = useSettings((s) => s.gamepad);
  const family = useApp((s) => s.padFamily);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bindings: Bindings = device === 'keyboard' ? keyboard : gamepad;

  const stopCapture = (): void => {
    shell.input.endCapture();
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setCapture(null);
  };
  useEffect(() => () => stopCapture(), []);

  const save = (dev: Device, next: Record<InputAction, string[]>): void => updateSection(dev, next);

  const apply = (c: Capture, control: string, resolution: ConflictResolution): void => {
    const current = getSettings()[c.device];
    save(c.device, assignBinding(current, c.action, c.slot, control, resolution));
    toast(`${ACTION_LABELS[c.action]}: ${controlLabel(control, family)}`, 'success');
  };

  const begin = (c: Capture): void => {
    setConflict(null);
    setCapture(c);
    // Every raw press goes to the capture; the target device's press is bound.
    shell.input.beginCapture((e) => {
      if (e.device === 'keyboard' && e.control === 'Escape') {
        stopCapture();
        return;
      }
      if (e.device === 'keyboard' && e.control === 'Delete') {
        const next = clearBinding(getSettings()[c.device], c.action, c.slot);
        if (next) save(c.device, next);
        else toast(`${ACTION_LABELS[c.action]} needs at least one control.`, 'warning');
        stopCapture();
        return;
      }
      if (e.device !== c.device) return;
      stopCapture();
      const others = findConflicts(getSettings()[c.device], c.action, e.control);
      if (others.length > 0) setConflict({ ...c, control: e.control, others });
      else apply(c, e.control, 'replace');
    });
    // A controller can't press Escape: give up after a while instead.
    timer.current = setTimeout(stopCapture, 8000);
  };

  const resolve = (resolution: ConflictResolution | 'cancel'): void => {
    const c = conflict;
    setConflict(null);
    if (!c || resolution === 'cancel') return;
    // Replacing must not strip a required action of its last control.
    if (resolution === 'replace' && c.others.some((o) => REQUIRED_ACTIONS.includes(o) && getSettings()[c.device][o].length <= 1)) {
      toast('That would leave a required action without a control; swapping instead.', 'warning');
      apply(c, c.control, 'swap');
      return;
    }
    apply(c, c.control, resolution);
  };

  return (
    <div className="controls-panel" data-testid="controls-panel">
      <Tabs
        tabs={[
          { id: 'keyboard', label: 'Keyboard' },
          { id: 'gamepad', label: 'Controller' },
        ]}
        value={device}
        onChange={(d) => {
          stopCapture();
          setConflict(null);
          setDevice(d);
        }}
      />
      {capture ? (
        <p className="capture-prompt" role="status" data-testid="capture-prompt">
          {device === 'keyboard' ? 'Press a key' : 'Press a controller button or move a stick'} for {ACTION_LABELS[capture.action]}. Escape cancels, Delete clears this slot.
        </p>
      ) : null}
      {conflict ? (
        <div className="confirm-box" role="alertdialog" data-testid="binding-conflict">
          <p>
            {controlLabel(conflict.control, family)} is already used by {conflict.others.map((o) => ACTION_LABELS[o]).join(' and ')}.
          </p>
          <div className="settings-actions">
            <Button tone="primary" onClick={() => resolve('swap')} autoFocus testId="conflict-swap">
              Swap
            </Button>
            <Button onClick={() => resolve('replace')} testId="conflict-replace">
              Replace
            </Button>
            <Button onClick={() => resolve('cancel')} testId="conflict-cancel">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {GROUPS.map((g) => (
        <section key={g.label} className="binding-group">
          <h3 className="settings-group">{g.label}</h3>
          {g.actions.map((action) => (
            <div key={action} className="binding-row">
              <span className="binding-label">{ACTION_LABELS[action]}</span>
              {[0, 1].map((slot) => {
                const control = bindings[action][slot];
                const active = capture?.action === action && capture.slot === slot;
                return (
                  <button
                    key={slot}
                    type="button"
                    className={`binding-slot${active ? ' is-capturing' : ''}${control ? '' : ' is-empty'}`}
                    data-focusable
                    data-testid={`bind-${device}-${action}-${slot}`}
                    onClick={() => begin({ device, action, slot })}
                  >
                    {active ? 'Press…' : control ? device === 'gamepad' ? <Glyph label={controlLabel(control, family)} /> : controlLabel(control) : 'Add'}
                  </button>
                );
              })}
            </div>
          ))}
        </section>
      ))}
      <div className="settings-actions">
        <Button
          onClick={() => {
            stopCapture();
            save(device, structuredClone(device === 'keyboard' ? DEFAULT_KEYBOARD : DEFAULT_GAMEPAD));
            toast(`${device === 'keyboard' ? 'Keyboard' : 'Controller'} controls restored`, 'success');
          }}
          testId="bindings-reset"
        >
          Restore default {device === 'keyboard' ? 'keys' : 'buttons'}
        </Button>
      </div>
    </div>
  );
}

registerCustomPanel('controls', ControlsPanel);
