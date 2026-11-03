import type { ReactNode } from 'react';

const PS: Record<string, { color: string; shape: ReactNode }> = {
  Cross: { color: '#7fa6ff', shape: <path d="M8 8 L16 16 M16 8 L8 16" /> },
  Circle: { color: '#ff7a8a', shape: <circle cx="12" cy="12" r="4.6" /> },
  Square: { color: '#ff9bd6', shape: <rect x="7.6" y="7.6" width="8.8" height="8.8" /> },
  Triangle: { color: '#6fe0b0', shape: <path d="M12 7 L17 16 L7 16 Z" /> },
};

const XBOX: Record<string, string> = { A: '#6cc24a', B: '#e6463d', X: '#3d8be6', Y: '#f2c12e' };

/**
 * Original face-button glyphs (PlayStation symbols, Xbox letters) for a button name;
 * any other control name is shown as text.
 */
export function Glyph(props: { label: string }): ReactNode {
  const ps = PS[props.label];
  if (ps) {
    return (
      <svg className="glyph" viewBox="0 0 24 24" role="img" aria-label={props.label}>
        <circle cx="12" cy="12" r="11" className="glyph-ring" />
        <g fill="none" stroke={ps.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {ps.shape}
        </g>
      </svg>
    );
  }
  const xb = XBOX[props.label];
  if (xb) {
    return (
      <svg className="glyph" viewBox="0 0 24 24" role="img" aria-label={props.label}>
        <circle cx="12" cy="12" r="11" fill={xb} />
        <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="700" fill="#111">
          {props.label}
        </text>
      </svg>
    );
  }
  return <>{props.label}</>;
}

export function isGlyphLabel(label: string): boolean {
  return label in PS || label in XBOX;
}
