import { useState, type CSSProperties, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { goBack, toast } from '../../app/stores';
import { useProgress } from '../../app/progressStore';
import type { Progress } from '../../storage/repositories';
import { isStageUnlocked, unlockHint } from '../../stages/progression';
import { availableStages, getStage, resolveAsset, type StageInfo } from '../../stages/registry';
import type { StageManifest } from '../../stages/schema';
import { getSettings, updateSection, useSettings } from '../../settings/store';
import { MenuList } from '../components/controls';
import { formatScore } from '../format';
import { useConfirmBackLabels } from '../hints';
import { ControlHints, MenuScreen } from './MenuScreen';
import { hoverFocus } from '../navigation/hoverFocus';

/** Stages in play order (manifest `order`, then name). */
export function orderedStages(): StageInfo[] {
  return [...availableStages()].sort((a, b) => (a.manifest?.order ?? 1000) - (b.manifest?.order ?? 1000) || (a.manifest?.name ?? a.id).localeCompare(b.manifest?.name ?? b.id));
}

export function thumbnailUrl(info: StageInfo | undefined): string | null {
  const m = info?.manifest;
  return m?.thumbnail && info ? resolveAsset(info.dir, m.thumbnail) : null;
}

/** Artwork: the rendered thumbnail, or a card painted from the stage palette when none exists. */
export function StageArt(props: { info: StageInfo | undefined; className?: string }): ReactNode {
  const url = thumbnailUrl(props.info);
  const p = props.info?.manifest?.palette;
  const style = { '--art-a': p?.accent ?? '#6e8bff', '--art-b': p?.fog ?? '#120f2a' } as CSSProperties;
  return url ? <img className={`stage-art ${props.className ?? ''}`} src={url} alt="" loading="lazy" /> : <span className={`stage-art generated ${props.className ?? ''}`} style={style} aria-hidden />;
}

function statusLine(m: StageManifest, progress: Progress, locked: boolean): string {
  if (locked) return 'Locked';
  const rec = progress.stages[m.id];
  if (!rec || rec.plays === 0) return 'Not played yet';
  return `Best ${formatScore(rec.bestScore)}, ${rec.plays} ${rec.plays === 1 ? 'play' : 'plays'}`;
}

/** Details of the focused world, shown over its live preview. */
function WorldDetails(props: { info: StageInfo | undefined; locked: boolean }): ReactNode {
  const m = props.info?.manifest;
  if (!m) return null;
  const track = m.music.tracks.find((t) => t.id === m.music.defaultTrack) ?? m.music.tracks[0];
  const name = (id: string): string => getStage(id)?.manifest?.name ?? id;
  return (
    <div className="world-details" data-testid="world-details">
      <h2 className="world-details-name">{m.name}</h2>
      <p className="world-details-desc">{m.description}</p>
      {track ? (
        <p className="world-details-music">
          Music: {track.title}, {m.music.bpm} BPM
        </p>
      ) : null}
      {props.locked ? <p className="world-details-lock">{unlockHint(m, name)}</p> : null}
    </div>
  );
}

/**
 * World selection: each card previews its world live behind the menu (debounced, at most two
 * environments resident) and, when enabled, crossfades to its music.
 */
export function StageSelectScreen(): ReactNode {
  const selected = useSettings((s) => s.setup.stageId);
  const unlockAll = useSettings((s) => s.setup.unlockAll);
  const progress = useProgress((s) => s.progress);
  const stages = orderedStages();
  const [focusId, setFocusId] = useState(selected);
  const { confirm, back } = useConfirmBackLabels();
  const focus = getStage(focusId) ?? stages[0];
  const lockedOf = (info: StageInfo): boolean => (info.manifest ? !isStageUnlocked(info.manifest, progress, unlockAll) : true);

  const cancel = (): void => {
    shell.stageManager?.preview(getSettings().setup.stageId, 0);
    goBack();
  };
  const choose = (info: StageInfo): void => {
    if (lockedOf(info) && info.manifest) {
      toast(unlockHint(info.manifest, (id) => getStage(id)?.manifest?.name ?? id), 'warning');
      return;
    }
    updateSection('setup', { stageId: info.id });
    goBack();
  };

  return (
    <MenuScreen
      title="Choose a world"
      onBack={cancel}
      testId="stage-select"
      aside={<WorldDetails info={focus} locked={focus ? lockedOf(focus) : false} />}
      footer={
        <ControlHints
          hints={[
            { keys: confirm, label: 'Choose' },
            { keys: back, label: 'Back' },
          ]}
        />
      }
    >
      <MenuList className="world-list">
        {stages.map((info) => {
          const m = info.manifest;
          if (!m) return null;
          const locked = lockedOf(info);
          return (
            <button
              key={info.id}
              type="button"
              className={`world-card${locked ? ' is-locked' : ''}${info.id === selected ? ' is-selected' : ''}`}
              data-focusable
              data-autofocus={info.id === selected ? '' : undefined}
              data-testid={`world-${info.id}`}
              onFocus={() => {
                setFocusId(info.id);
                shell.stageManager?.preview(info.id);
              }}
              onMouseEnter={hoverFocus}
              onClick={() => choose(info)}
            >
              <StageArt info={info} className="world-card-art" />
              <span className="world-card-text">
                <span className="world-card-name">{m.name}</span>
                <span className="world-card-meta">{statusLine(m, progress, locked)}</span>
              </span>
            </button>
          );
        })}
      </MenuList>
    </MenuScreen>
  );
}
