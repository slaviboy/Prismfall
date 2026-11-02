import type { ReactNode } from 'react';
import { discoverStages } from '../../stages/registry';
import { registerCustomPanel } from './customPanels';

/** Content validation report: every discovered stage with its errors and warnings. */
function ContentReport(): ReactNode {
  const stages = discoverStages();
  const unavailable = stages.filter((s) => !s.available).length;
  return (
    <div className="content-report" data-testid="content-report">
      <h3 className="settings-group">Content</h3>
      <p className="content-report-summary">
        {stages.length} stages found, {stages.length - unavailable} available{unavailable ? `, ${unavailable} unavailable` : ''}.
      </p>
      <ul>
        {stages.map((s) => (
          <li key={s.dir} className={s.available ? 'is-ok' : 'is-error'}>
            <strong>{s.manifest?.name ?? s.id}</strong> <span className="content-report-path">{s.dir}</span>
            {s.manifest?.placeholder ? <span className="content-report-flag">Placeholder</span> : null}
            {s.errors.map((e) => (
              <div key={e} className="content-report-error">
                {e}
              </div>
            ))}
            {s.warnings.map((w) => (
              <div key={w} className="content-report-warning">
                {w}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

registerCustomPanel('contentReport', ContentReport);
