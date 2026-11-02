import { useEffect, useState, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { goBack, navigate, useApp } from '../../app/stores';
import { useProgress } from '../../app/progressStore';
import { MODES, getMode, getVariant, highScoreKey, type ModeId } from '../../game/modes/modes';
import { getSettings, updateSection, useSettings } from '../../settings/store';
import type { HighScoreEntry } from '../../storage/repositories';
import { Button, ChoiceRow, MenuItem, MenuList } from '../components/controls';
import { formatDate, formatDuration, formatScore, formatTime, piecesPerSecond } from '../format';
import { useConfirmBackLabels } from '../hints';
import { ControlHints, MenuScreen } from './MenuScreen';
import { useNavScope } from '../navigation/useNavScope';
import { BRAND } from '../../config/branding';
import { useLatest } from '../useLatest';
import { availableStages, getStage } from '../../stages/registry';
import { isStageUnlocked, unlockHint } from '../../stages/progression';

function useHints(extra: readonly { keys: string; label: string }[] = []): readonly { keys: string; label: string }[] {
  const { confirm, back } = useConfirmBackLabels();
  return [{ keys: confirm, label: 'Select' }, { keys: back, label: 'Back' }, ...extra];
}

// ----------------------------------------------------------------------------- boot

export function BootScreen(props: { onStart: () => void }): ReactNode {
  const ref = useNavScope<HTMLDivElement>({ autoFocus: true });
  const { confirm } = useConfirmBackLabels();
  const onStart = useLatest(props.onStart);
  useEffect(
    () =>
      // Any key or controller button begins (Esc is not a user gesture for audio, so it is ignored).
      shell.input.onAnyInput((e) => {
        if (e.control !== 'Escape') onStart.current();
      }),
    [onStart],
  );
  return (
    <div className="boot-screen" data-nav-scope ref={ref} data-testid="boot-screen">
      <div className="boot-title-block">
        <h1 className="boot-title">{BRAND.title}</h1>
        <p className="boot-tagline">{BRAND.tagline}</p>
      </div>
      <button type="button" className="boot-start" data-focusable data-autofocus onClick={props.onStart} data-testid="boot-start">
        Press {confirm}, any key or click to begin
      </button>
      <p className="boot-note">Audio starts after your first input — browsers require it.</p>
    </div>
  );
}

// ----------------------------------------------------------------------------- main menu

export function MainMenu(): ReactNode {
  const hints = useHints();
  const lifetime = useProgress((s) => s.lifetime);
  return (
    <MenuScreen testId="main-menu" footer={<ControlHints hints={hints} />}>
      <h1 className="brand-mark">{BRAND.title}</h1>
      <MenuList>
        <MenuItem label="Play" description="Choose a mode and a world to play in." onSelect={() => navigate('modes')} autoFocus testId="menu-play" />
        <MenuItem label="High scores" description="Your best runs in every mode, with replays." onSelect={() => navigate('highscores')} testId="menu-highscores" />
        <MenuItem label="Settings" description="Controls, graphics, audio, camera and accessibility." onSelect={() => navigate('settings')} testId="menu-settings" />
        <MenuItem label="Credits" description="Who made what, and the licences of every asset." onSelect={() => navigate('credits')} testId="menu-credits" />
      </MenuList>
      {lifetime.games > 0 ? (
        <p className="menu-note">
          {lifetime.games} games, {formatScore(lifetime.lines)} lines and {formatDuration(lifetime.playTimeMs)} played so far
        </p>
      ) : null}
    </MenuScreen>
  );
}

// ----------------------------------------------------------------------------- modes

export function ModeSelectScreen(props: { onPick: (id: ModeId) => void }): ReactNode {
  const hints = useHints();
  const last = useSettings((s) => s.setup.lastMode);
  const modes = MODES.filter((m) => m.id !== 'voyage');
  return (
    <MenuScreen title="Play" onBack={() => goBack()} testId="mode-select" footer={<ControlHints hints={hints} />}>
      <MenuList>
        {modes.map((m) => (
          <MenuItem key={m.id} label={m.name} description={m.description} onSelect={() => props.onPick(m.id)} autoFocus={m.id === last} testId={`mode-${m.id}`} />
        ))}
      </MenuList>
    </MenuScreen>
  );
}

/** Stage choice with live preview behind the menu. */
function WorldRow(): ReactNode {
  const stageId = useSettings((s) => s.setup.stageId);
  const unlockAll = useSettings((s) => s.setup.unlockAll);
  const progress = useProgress((s) => s.progress);
  const stages = availableStages();
  if (stages.length === 0) return null;
  const current = getStage(stageId)?.manifest ?? stages[0]?.manifest;
  const locked = current ? !isStageUnlocked(current, progress, unlockAll) : false;
  const name = (id: string): string => getStage(id)?.manifest?.name ?? id;
  return (
    <ChoiceRow
      label="World"
      description={locked && current ? unlockHint(current, name) : (current?.description ?? '')}
      value={current?.id ?? stageId}
      options={stages.map((st) => ({
        value: st.id,
        label: `${st.manifest?.name ?? st.id}${st.manifest && !isStageUnlocked(st.manifest, progress, unlockAll) ? ' (locked)' : ''}`,
      }))}
      onChange={(id) => {
        updateSection('setup', { stageId: id });
        shell.stageManager?.preview(id);
      }}
      testId="setup-world"
    />
  );
}

export function useSelectedStageLocked(): boolean {
  const stageId = useSettings((s) => s.setup.stageId);
  const unlockAll = useSettings((s) => s.setup.unlockAll);
  const progress = useProgress((s) => s.progress);
  const m = getStage(stageId)?.manifest;
  return m ? !isStageUnlocked(m, progress, unlockAll) : false;
}

export function LoadingScreen(): ReactNode {
  const loading = useApp((s) => s.loading);
  return (
    <div className="loading-screen" data-testid="loading-screen" role="status">
      <p className="loading-kicker">Entering</p>
      <h1 className="loading-title">{loading?.label ?? ''}</h1>
      <div className="loading-bar" aria-hidden>
        <span style={{ width: `${Math.round((loading?.progress ?? 0) * 100)}%` }} />
      </div>
    </div>
  );
}

export function ModeSetupScreen(props: { modeId: ModeId; onStart: () => void }): ReactNode {
  const hints = useHints();
  const mode = getMode(props.modeId);
  const locked = useSelectedStageLocked();
  const variants = useSettings((s) => s.setup.variants);
  const variantId = getVariant(mode, variants[mode.id] ?? mode.defaultVariant).id;
  const [best, setBest] = useState<HighScoreEntry | null>(null);
  useEffect(() => {
    void shell.highScores.top(highScoreKey(mode.id, variantId), mode.lowerIsBetter, 1).then((t) => setBest(t[0] ?? null));
  }, [mode, variantId]);
  const variant = getVariant(mode, variantId);
  return (
    <MenuScreen title={mode.name} subtitle={mode.tagline} onBack={() => goBack()} testId="mode-setup" footer={<ControlHints hints={hints} />}>
      <div className="setup-rows">
        {mode.stageSelectable ? <WorldRow /> : null}
        {mode.variants.length > 1 ? (
          <ChoiceRow
            label="Rules"
            description={variant.description}
            value={variantId}
            options={mode.variants.map((v) => ({ value: v.id, label: v.label }))}
            onChange={(v) => updateSection('setup', { variants: { ...getSettings().setup.variants, [mode.id]: v } })}
            testId="setup-variant"
          />
        ) : (
          <p className="setup-desc">{mode.description}</p>
        )}
        {best ? (
          <p className="setup-best">
            Best: <strong>{mode.metric === 'time' ? formatTime(best.timeMs) : formatScore(best.score)}</strong> on {formatDate(best.date)}
          </p>
        ) : mode.metric !== 'none' ? (
          <p className="setup-best">No record yet — this run sets it.</p>
        ) : null}
      </div>
      <div className="setup-actions">
        <Button tone="primary" onClick={props.onStart} autoFocus disabled={mode.stageSelectable && locked} testId="setup-start">
          Start
        </Button>
      </div>
    </MenuScreen>
  );
}

// ----------------------------------------------------------------------------- results

export function ResultsScreen(): ReactNode {
  const r = useApp((s) => s.results);
  const hints = useHints();
  if (!r) return null;
  const mode = getMode(r.modeId);
  const variant = getVariant(mode, r.variantId);
  const headline =
    r.outcome === 'complete' ? (mode.metric === 'time' ? formatTime(r.timeMs) : formatScore(r.score)) : formatScore(r.score);
  const verdict =
    r.outcome === 'complete'
      ? mode.id === 'sprint'
        ? `${variant.label} cleared`
        : mode.id === 'ultra'
          ? 'Time is up'
          : 'Goal reached'
      : 'The stack reached the top';
  const s = r.stats;
  return (
    <MenuScreen title={verdict} subtitle={`${mode.name}, ${variant.label}`} onBack={() => shell.quitToMenu()} testId="results-screen" footer={<ControlHints hints={hints} />}>
      <div className="results-hero">
        <span className="results-number" data-testid="results-headline">{headline}</span>
        {r.isPersonalBest ? <span className="results-badge">New personal best</span> : r.rank ? <span className="results-badge quiet">Rank {r.rank} of 10</span> : null}
      </div>
      <dl className="results-stats">
        <div><dt>Score</dt><dd>{formatScore(r.score)}</dd></div>
        <div><dt>Time</dt><dd>{formatTime(r.timeMs)}</dd></div>
        <div><dt>Lines</dt><dd>{r.lines}</dd></div>
        <div><dt>Level</dt><dd>{r.level}</dd></div>
        <div><dt>Pieces</dt><dd>{s.pieces} ({piecesPerSecond(s.pieces, r.timeMs)}/s)</dd></div>
        <div><dt>Quads</dt><dd>{s.quads}</dd></div>
        <div><dt>T-spins</dt><dd>{s.tSpins + s.tSpinMinis}</dd></div>
        <div><dt>Best combo</dt><dd>{Math.max(0, s.maxCombo)}</dd></div>
        <div><dt>Back-to-back</dt><dd>{Math.max(0, s.maxBackToBack)}</dd></div>
        <div><dt>Perfect clears</dt><dd>{s.perfectClears}</dd></div>
      </dl>
      <MenuList className="results-actions">
        <MenuItem label="Play again" onSelect={() => shell.restart()} autoFocus testId="results-retry" />
        {r.replayId ? <MenuItem label="Watch replay" onSelect={() => void shell.watchReplay(r.replayId as string, r.stageId)} testId="results-replay" /> : null}
        <MenuItem label="Main menu" onSelect={() => shell.quitToMenu()} testId="results-menu" />
      </MenuList>
    </MenuScreen>
  );
}

// ----------------------------------------------------------------------------- high scores

export function HighScoresScreen(): ReactNode {
  const ranked = MODES.flatMap((m) => (m.metric === 'none' ? [] : m.variants.map((v) => ({ mode: m, variant: v }))));
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; list: HighScoreEntry[] } | null>(null);
  const current = ranked[index] ?? ranked[0]!;
  const key = highScoreKey(current.mode.id, current.variant.id);
  const entries = loaded?.key === key ? loaded.list : null;
  const hints = useHints([{ keys: 'Q / E', label: 'Change table' }]);
  useEffect(() => {
    void shell.highScores.top(key, current.mode.lowerIsBetter).then((list) => setLoaded({ key, list }));
  }, [key, current.mode.lowerIsBetter]);
  const step = (d: number): void => setIndex((i) => (i + d + ranked.length) % ranked.length);
  return (
    <MenuScreen title="High scores" onBack={() => goBack()} onTab={step} wide testId="highscores-screen" footer={<ControlHints hints={hints} />}>
      <ChoiceRow
        label="Table"
        value={index}
        options={ranked.map((r, i) => ({ value: i, label: `${r.mode.name}: ${r.variant.label}` }))}
        onChange={setIndex}
        testId="highscores-table"
      />
      {entries === null ? (
        <p className="menu-note">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="menu-note">No runs recorded yet. Play {current.mode.name} to set the first one.</p>
      ) : (
        <ol className="score-table" data-testid="highscores-list">
          {entries.map((e, i) => (
            <li key={e.id}>
              <span className="rank">{i + 1}</span>
              <span className="primary">{current.mode.metric === 'time' ? formatTime(e.timeMs) : formatScore(e.score)}</span>
              <span className="secondary">{e.lines} lines, level {e.level}</span>
              <span className="secondary">{formatDate(e.date)}</span>
              {e.replayId ? (
                <Button onClick={() => void shell.watchReplay(e.replayId as string, e.stageId)}>Replay</Button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ol>
      )}
    </MenuScreen>
  );
}

// ----------------------------------------------------------------------------- credits

export function CreditsScreen(): ReactNode {
  const hints = useHints();
  return (
    <MenuScreen title="Credits" onBack={() => goBack()} testId="credits-screen" footer={<ControlHints hints={hints} />}>
      <div className="prose">
        <p>{BRAND.title} is a personal project. Every stage, piece of music, sound effect, 3D model and line of code is original to this project.</p>
        <p>Built with three.js (MIT), React (MIT), Zustand (MIT), Zod (MIT) and idb (ISC). Interface type is Unbounded and Atkinson Hyperlegible Next, both under the SIL Open Font License 1.1.</p>
        <p>The complete asset and licence record lives in ASSET_LICENSES.md in the project folder.</p>
      </div>
      <MenuList>
        <MenuItem label="Back" onSelect={() => goBack()} autoFocus />
      </MenuList>
    </MenuScreen>
  );
}
