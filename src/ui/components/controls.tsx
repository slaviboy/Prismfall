import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useNavAdjust } from '../navigation/useNavScope';
import { useLatest } from '../useLatest';

/** A primary menu entry: large display type, shows its description while focused. */
export function MenuItem(props: {
  label: string;
  description?: string;
  onSelect: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  badge?: string;
  testId?: string;
}): ReactNode {
  return (
    <button
      type="button"
      className="menu-item"
      data-focusable
      data-autofocus={props.autoFocus ? '' : undefined}
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onSelect}
      onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
    >
      <span className="menu-item-label">{props.label}</span>
      {props.badge ? <span className="menu-item-badge">{props.badge}</span> : null}
      {props.description ? <span className="menu-item-desc">{props.description}</span> : null}
    </button>
  );
}

/** Vertical list with the spectral rail; the caret glides to the focused item. */
export function MenuList(props: { children: ReactNode; className?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<{ top: number; height: number } | null>(null);

  const place = useCallback((target: HTMLElement | null) => {
    const list = ref.current;
    if (!list || !target || !list.contains(target)) return;
    const label = target.querySelector<HTMLElement>('.menu-item-label') ?? target;
    const lr = list.getBoundingClientRect();
    const r = label.getBoundingClientRect();
    setCaret({ top: r.top - lr.top + list.scrollTop, height: r.height });
  }, []);

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const onFocus = (e: FocusEvent): void => place(e.target as HTMLElement);
    list.addEventListener('focusin', onFocus);
    if (document.activeElement instanceof HTMLElement) place(document.activeElement);
    return () => list.removeEventListener('focusin', onFocus);
  }, [place]);

  return (
    <div className={`menu-list ${props.className ?? ''}`} ref={ref}>
      <div className="rail" aria-hidden>
        {caret ? <div className="rail-caret" style={{ transform: `translateY(${caret.top}px)`, height: caret.height }} /> : null}
      </div>
      {props.children}
    </div>
  );
}

/** Plain secondary button (row actions, dialogs). */
export function Button(props: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  autoFocus?: boolean;
  testId?: string;
  title?: string;
}): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn-${props.tone ?? 'default'}`}
      data-focusable
      data-autofocus={props.autoFocus ? '' : undefined}
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.title}
      onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
    >
      {props.children}
    </button>
  );
}

interface RowProps {
  label: string;
  description?: string;
  testId?: string;
}

/** On/off switch row. Confirm toggles; left/right also set it. */
export function ToggleRow(props: RowProps & { value: boolean; onChange: (v: boolean) => void }): ReactNode {
  const ref = useNavAdjust<HTMLButtonElement>((d) => props.onChange(d > 0));
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={props.value}
      className="setting-row"
      data-focusable
      data-nav-adjust
      data-testid={props.testId}
      onClick={() => props.onChange(!props.value)}
      onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
    >
      <span className="setting-text">
        <span className="setting-label">{props.label}</span>
        {props.description ? <span className="setting-desc">{props.description}</span> : null}
      </span>
      <span className={`switch ${props.value ? 'on' : ''}`} aria-hidden>
        <span className="switch-knob" />
      </span>
    </button>
  );
}

/** Numeric slider row driven by left/right or the pointer. */
export function SliderRow(
  props: RowProps & {
    value: number;
    min: number;
    max: number;
    step: number;
    format?: (v: number) => string;
    onChange: (v: number) => void;
  },
): ReactNode {
  const { min, max, step, value, onChange } = props;
  const clamp = (v: number): number => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const ref = useNavAdjust<HTMLDivElement>((d) => onChange(clamp(value + d * step)));
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = ((value - min) / (max - min)) * 100;
  const fromPointer = (clientX: number): void => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return;
    onChange(clamp(min + ((clientX - r.left) / r.width) * (max - min)));
  };
  return (
    <div
      ref={ref}
      className="setting-row"
      role="slider"
      tabIndex={0}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={props.label}
      data-focusable
      data-nav-adjust
      data-testid={props.testId}
      onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
    >
      <span className="setting-text">
        <span className="setting-label">{props.label}</span>
        {props.description ? <span className="setting-desc">{props.description}</span> : null}
      </span>
      <span className="slider">
        <span
          className="slider-track"
          ref={trackRef}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            fromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) fromPointer(e.clientX);
          }}
        >
          <span className="slider-fill" style={{ width: `${pct}%` }} />
          <span className="slider-thumb" style={{ left: `${pct}%` }} />
        </span>
        <span className="slider-value">{props.format ? props.format(value) : String(value)}</span>
      </span>
    </div>
  );
}

/** Choice row: cycles options with left/right or confirm. */
export function ChoiceRow<T extends string | number>(
  props: RowProps & { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void },
): ReactNode {
  const idx = Math.max(0, props.options.findIndex((o) => o.value === props.value));
  const step = (d: number): void => {
    const next = props.options[(idx + d + props.options.length) % props.options.length];
    if (next) props.onChange(next.value);
  };
  const ref = useNavAdjust<HTMLButtonElement>(step);
  return (
    <button
      ref={ref}
      type="button"
      className="setting-row"
      data-focusable
      data-nav-adjust
      data-testid={props.testId}
      onClick={() => step(1)}
      onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
    >
      <span className="setting-text">
        <span className="setting-label">{props.label}</span>
        {props.description ? <span className="setting-desc">{props.description}</span> : null}
      </span>
      <span className="choice">
        <span className="choice-arrow" aria-hidden onClick={(e) => { e.stopPropagation(); step(-1); }}>‹</span>
        <span className="choice-value">{props.options[idx]?.label ?? ''}</span>
        <span className="choice-arrow" aria-hidden onClick={(e) => { e.stopPropagation(); step(1); }}>›</span>
      </span>
    </button>
  );
}

/** Horizontal tab strip; L/R (tabPrev/tabNext) handled by the parent scope. */
export function Tabs<T extends string>(props: { tabs: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void }): ReactNode {
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === props.value}
          className={`tab ${t.id === props.value ? 'active' : ''}`}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Keeps a value in sync with a setInterval-driven reader without React re-renders. */
export function useTicker(read: () => string, intervalMs: number): React.RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement>(null);
  const reader = useLatest(read);
  useEffect(() => {
    const id = setInterval(() => {
      if (ref.current) ref.current.textContent = reader.current();
    }, intervalMs);
    if (ref.current) ref.current.textContent = reader.current();
    return () => clearInterval(id);
  }, [intervalMs, reader]);
  return ref;
}
