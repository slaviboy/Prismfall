import type { ReactNode } from 'react';
import { useNavScope } from '../navigation/useNavScope';
import { Glyph, isGlyphLabel } from '../components/Glyph';
import { useApp } from '../../app/stores';

/** Shared layout for menu screens: left column of typography over a scrim, world visible on the right. */
export function MenuScreen(props: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  onTab?: (delta: number) => void;
  children: ReactNode;
  aside?: ReactNode;
  /** Full-screen layer behind the scrim (a world's picture). */
  backdrop?: ReactNode;
  wide?: boolean;
  testId?: string;
  footer?: ReactNode;
}): ReactNode {
  const ref = useNavScope<HTMLDivElement>({ onBack: props.onBack, onTab: props.onTab });
  return (
    <div className={`menu-screen ${props.wide ? 'wide' : ''}`} data-nav-scope ref={ref} data-testid={props.testId}>
      {props.backdrop}
      <div className="menu-scrim" aria-hidden />
      <section className="menu-column">
        {props.title ? (
          <header className="menu-header">
            <h1 className="menu-title">{props.title}</h1>
            {props.subtitle ? <p className="menu-subtitle">{props.subtitle}</p> : null}
          </header>
        ) : null}
        <div className="menu-body">{props.children}</div>
        {props.footer ? <footer className="menu-footer">{props.footer}</footer> : null}
      </section>
      {props.aside ? <aside className="menu-aside">{props.aside}</aside> : null}
    </div>
  );
}

/** Small hint line showing what confirm/back do on the current device. */
export function ControlHints(props: { hints: readonly { keys: string; label: string }[] }): ReactNode {
  // Glyphs only for controller buttons (a keyboard "A" or "X" stays a key).
  const pad = useApp((s) => s.device) === 'gamepad';
  return (
    <div className="control-hints">
      {props.hints.map((h) => (
        <span key={h.label} className="hint">
          {pad && isGlyphLabel(h.keys) ? <Glyph label={h.keys} /> : <kbd>{h.keys}</kbd>}
          {h.label}
        </span>
      ))}
    </div>
  );
}
