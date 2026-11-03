import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { shell, type CatalogTrack } from '../../app/GameShell';
import { goBack, navigate, toast } from '../../app/stores';
import { useProgress } from '../../app/progressStore';
import { BLOCK_DESIGNS, getBlockDesign } from '../../rendering/materials/blockDesigns';
import type { CustomLevel } from '../../settings/schema';
import { getSettings, updateSection, useSettings } from '../../settings/store';
import { isStageUnlocked } from '../../stages/progression';
import { getStage } from '../../stages/registry';
import { Button, ChoiceRow, MenuItem, MenuList } from '../components/controls';
import { hoverFocus } from '../navigation/hoverFocus';
import { useConfirmBackLabels } from '../hints';
import { ControlHints, MenuScreen } from './MenuScreen';
import { StageArt, orderedStages } from './StageSelect';

const WORLD_MUSIC = 'stage';
const WORLD_BLOCKS = 'stage';

/** "World, track, blocks" summary of a level, for lists and the preview card. */
export function describeLevel(level: CustomLevel, tracks: readonly CatalogTrack[]): string {
  const world = getStage(level.stageId)?.manifest?.name ?? level.stageId;
  const music = level.music === WORLD_MUSIC ? 'its own music' : (tracks.find((t) => t.id === level.music)?.title ?? 'its own music');
  const blocks = level.blocks === WORLD_BLOCKS ? 'its own blocks' : `${getBlockDesign(level.blocks)?.name ?? 'its own'} blocks`;
  return `${world}, ${music}, ${blocks}`;
}

function useHints(): readonly { keys: string; label: string }[] {
  const { confirm, back } = useConfirmBackLabels();
  return [
    { keys: confirm, label: 'Select' },
    { keys: back, label: 'Back' },
  ];
}

function saveLevels(levels: CustomLevel[]): void {
  updateSection('creator', { levels });
}

function newId(): string {
  return `lvl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Level creator: the player's own levels, each a world with any world's music (or their own
 * files) and any block design. Levels are saved with the settings and played in any mode.
 */
export function LevelCreatorScreen(): ReactNode {
  const levels = useSettings((s) => s.creator.levels);
  const [editing, setEditing] = useState<CustomLevel | null>(null);
  const [tracks, setTracks] = useState<CatalogTrack[]>([]);
  const hints = useHints();

  useEffect(() => {
    void shell.catalog().then(setTracks);
    // Leaving the creator returns to the world's music and the selected world.
    return () => {
      void shell.playTrack(null);
      shell.stageManager?.preview(getSettings().setup.stageId, 0);
    };
  }, []);

  const startNew = (): void => {
    const stageId = getSettings().setup.stageId;
    setEditing({ id: newId(), name: `Level ${levels.length + 1}`, stageId, music: WORLD_MUSIC, blocks: WORLD_BLOCKS, created: Date.now() });
  };

  if (editing) {
    return <LevelEditor level={editing} tracks={tracks} isNew={!levels.some((l) => l.id === editing.id)} onDone={() => setEditing(null)} />;
  }
  return (
    <MenuScreen title="Level creator" subtitle="Your own levels: a world, the music you want and the blocks you like." onBack={() => goBack()} testId="level-creator" footer={<ControlHints hints={hints} />}>
      <MenuList>
        <MenuItem label="New level" description="Choose a world, its music and its blocks." onSelect={startNew} autoFocus={levels.length === 0} testId="creator-new" />
        {levels.map((l, i) => (
          <MenuItem key={l.id} label={l.name} description={describeLevel(l, tracks)} onSelect={() => setEditing(l)} autoFocus={i === 0} testId={`creator-level-${i}`} />
        ))}
      </MenuList>
      {levels.length === 0 ? <p className="menu-note">Levels you make are saved with your settings and can be played in Marathon, Sprint, Ultra, Zen and Practice.</p> : null}
    </MenuScreen>
  );
}

function LevelEditor(props: { level: CustomLevel; tracks: readonly CatalogTrack[]; isNew: boolean; onDone: () => void }): ReactNode {
  const [level, setLevel] = useState(props.level);
  const unlockAll = useSettings((s) => s.setup.unlockAll);
  const progress = useProgress((s) => s.progress);
  const hints = useHints();
  const worlds = orderedStages().filter((st) => st.manifest && isStageUnlocked(st.manifest, progress, unlockAll));
  const update = (patch: Partial<CustomLevel>): void => setLevel((l) => ({ ...l, ...patch }));

  // The world shows live behind the menu, like the world list.
  useEffect(() => {
    shell.stageManager?.preview(level.stageId);
  }, [level.stageId]);

  const pickMusic = (id: string): void => {
    update({ music: id });
    shell.unlockAudio();
    void shell.playTrack(id === WORLD_MUSIC ? null : id);
  };

  const store = (): CustomLevel => {
    const name = level.name.trim() || 'My level';
    const saved = { ...level, name };
    const others = getSettings().creator.levels.filter((l) => l.id !== saved.id);
    saveLevels(props.isNew ? [...others, saved] : getSettings().creator.levels.map((l) => (l.id === saved.id ? saved : l)));
    return saved;
  };

  const save = (): void => {
    const saved = store();
    toast(`Saved ${saved.name}`, 'success');
    props.onDone();
  };

  const play = (): void => {
    const saved = store();
    updateSection('setup', { levelId: saved.id, stageId: saved.stageId });
    navigate('modes');
  };

  const remove = (): void => {
    saveLevels(getSettings().creator.levels.filter((l) => l.id !== level.id));
    if (getSettings().setup.levelId === level.id) updateSection('setup', { levelId: '' });
    toast(`Deleted ${level.name}`);
    props.onDone();
  };

  const world = getStage(level.stageId);
  const design = getBlockDesign(level.blocks);
  const track = props.tracks.find((t) => t.id === level.music);
  const musicOptions = [{ value: WORLD_MUSIC, label: "The world's music" }, ...props.tracks.map((t) => ({ value: t.id, label: `${t.title} (${t.subtitle})` }))];
  const blockOptions = [{ value: WORLD_BLOCKS, label: "The world's blocks" }, ...BLOCK_DESIGNS.map((d) => ({ value: d.id, label: d.name }))];

  return (
    <MenuScreen
      title={props.isNew ? 'New level' : 'Edit level'}
      onBack={props.onDone}
      testId="level-editor"
      footer={<ControlHints hints={hints} />}
      aside={
        <div className="world-details" data-testid="level-preview">
          <StageArt info={world} className="level-preview-art" />
          <h2 className="world-details-name">{level.name.trim() || 'My level'}</h2>
          <p className="world-details-desc">{world?.manifest?.description ?? ''}</p>
          <p className="world-details-music">Music: {level.music === WORLD_MUSIC ? "the world's own" : (track?.title ?? "the world's own")}</p>
          <p className="world-details-music">Blocks: {design ? `${design.name}. ${design.description}` : "the world's own"}</p>
        </div>
      }
    >
      <div className="setup-rows">
        <label className="setting-row level-name-row" onMouseEnter={hoverFocus}>
          <span className="setting-text">
            <span className="setting-label">Name</span>
          </span>
          <input
            className="level-name-input"
            data-focusable
            data-autofocus
            data-testid="level-name"
            maxLength={40}
            value={level.name}
            onChange={(e) => update({ name: e.target.value })}
            onKeyDown={leaveFieldWithArrows}
            spellCheck={false}
          />
        </label>
        <ChoiceRow
          label="World"
          description={world?.manifest?.name ? 'Its landscape, light and weather.' : undefined}
          value={level.stageId}
          options={worlds.map((st) => ({ value: st.id, label: st.manifest?.name ?? st.id }))}
          onChange={(v) => update({ stageId: v })}
          testId="level-world"
        />
        <ChoiceRow label="Music" description="Any world's music, or your own from the Music Room. Plays as you choose." value={level.music} options={musicOptions} onChange={pickMusic} testId="level-music" />
        <ChoiceRow label="Blocks" description={design?.description ?? 'The blocks this world comes with.'} value={level.blocks} options={blockOptions} onChange={(v) => update({ blocks: v })} testId="level-blocks" />
      </div>
      <div className="setup-actions">
        <Button tone="primary" onClick={play} testId="level-play">
          Play this level
        </Button>
        <Button onClick={save} testId="level-save">
          Save
        </Button>
        {props.isNew ? null : (
          <Button tone="danger" onClick={remove} testId="level-delete">
            Delete
          </Button>
        )}
      </div>
    </MenuScreen>
  );
}

/** Arrow keys and Enter move on from the name field (the menu navigator ignores text fields). */
function leaveFieldWithArrows(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  const scope = e.currentTarget.closest('[data-nav-scope]');
  if (!scope) return;
  const items = Array.from(scope.querySelectorAll<HTMLElement>('[data-focusable]')).filter((el) => !(el as HTMLButtonElement).disabled);
  const i = items.indexOf(e.currentTarget);
  const next = items[e.key === 'ArrowUp' ? i - 1 : i + 1];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}
