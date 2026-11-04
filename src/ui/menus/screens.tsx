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
import { getCampaign, getStage } from '../../stages/registry';
import { isStageUnlocked, unlockHint } from '../../stages/progression';
import { PracticeOptions } from './PracticeOptions';
import { StageArt, WorldBackdrop, orderedStages } from './StageSelect';
import { hoverFocus } from '../navigation/hoverFocus';
import { activeLevel } from '../../app/levels';
import { VRMenuItem } from '../vr/VRControls';

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
        <MenuItem label="Voyage" description="A journey through the worlds, one after another, as the music carries you on." onSelect={() => navigate('voyage')} testId="menu-voyage" />
        <MenuItem label="Play" description="Choose a mode and a world to play in." onSelect={() => navigate('modes')} autoFocus testId="menu-play" />
        <VRMenuItem />
        <MenuItem label="Level creator" description="Make your own levels: any world, any music and any blocks." onSelect={() => navigate('creator')} testId="menu-creator" />
        <MenuItem label="Music Room" description="Listen to every world's music, add your own and choose what plays in free play." onSelect={() => navigate('musicRoom')} testId="menu-music" />
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

/** The chosen world as a card; opens world selection. */
function WorldRow(): ReactNode {
  const stageId = useSettings((s) => s.setup.stageId);
  const unlockAll = useSettings((s) => s.setup.unlockAll);
  const level = useSettings(activeLevel);
  const progress = useProgress((s) => s.progress);
  const stages = orderedStages();
  if (stages.length === 0) return null;
  const info = getStage(level?.stageId ?? stageId) ?? stages[0];
  const m = info?.manifest;
  const locked = m ? !isStageUnlocked(m, progress, unlockAll) : false;
  const name = (id: string): string => getStage(id)?.manifest?.name ?? id;
  return (
    <>
      <button type="button" className="setup-world" data-focusable onClick={() => navigate('stages')} onMouseEnter={hoverFocus} data-testid="setup-world">
        <StageArt info={info} className="setup-world-art" />
        <span className="setup-world-text">
          <span className="setup-world-label">{level ? 'Your level' : 'World'}</span>
          <span className="setup-world-name">{level ? level.name : (m?.name ?? stageId)}</span>
          <span className="setup-world-desc">{locked && m ? unlockHint(m, name) : level ? `In ${m?.name ?? level.stageId}. Change world` : 'Change world'}</span>
        </span>
      </button>
      {level ? (
        <Button onClick={() => updateSection('setup', { levelId: '' })} testId="setup-clear-level">
          Play {m?.name ?? 'the world'} as it is
        </Button>
      ) : null}
    </>
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
  // Without live previews the chosen world is built when the game starts; until then its picture
  // stands in for the world still on screen.
  const stageId = useSettings((s) => s.setup.stageId);
  const live = useSettings((s) => s.interface.liveWorldPreviews);
  const picture = mode.stageSelectable && !live && shell.stageManager?.activeId !== stageId;
  return (
    <MenuScreen
      title={mode.name}
      subtitle={mode.tagline}
      onBack={() => goBack()}
      testId="mode-setup"
      backdrop={picture ? <WorldBackdrop info={getStage(stageId)} /> : undefined}
      footer={<ControlHints hints={hints} />}
    >
      <div className="setup-rows">
        {mode.stageSelectable ? <WorldRow /> : null}
        {mode.id === 'practice' ? <PracticeOptions /> : null}
        {mode.variants.length > 1 ? (
          <ChoiceRow
            label="Rules"
            description={variant.description}
            value={variantId}
            options={mode.variants.map((v) => ({ value: v.id, label: v.label }))}
            onChange={(v) => updateSection('setup', { variants: { ...getSettings().setup.variants, [mode.id]: v } })}
            testId="setup-variant"
          />
        ) : mode.id === 'practice' ? null : (
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
    r.voyage
      ? r.outcome === 'complete'
        ? 'Voyage complete'
        : `The voyage ended in ${r.voyage.lastStage}`
      : r.outcome === 'complete'
      ? mode.id === 'sprint'
        ? `${variant.label} cleared`
        : mode.id === 'ultra'
          ? 'Time is up'
          : 'Goal reached'
      : 'The stack reached the top';
  const s = r.stats;
  return (
    <MenuScreen
      title={verdict}
      subtitle={r.voyage ? `Voyage from ${r.voyage.areaName}, ${variant.label}` : `${mode.name}, ${variant.label}`}
      onBack={() => shell.quitToMenu()}
      testId="results-screen"
      footer={<ControlHints hints={hints} />}
    >
      <div className="results-hero">
        <span className="results-number" data-testid="results-headline">{headline}</span>
        {r.isPersonalBest ? <span className="results-badge">New personal best</span> : r.rank ? <span className="results-badge quiet">Rank {r.rank} of 10</span> : null}
      </div>
      {r.unlocked.length > 0 ? (
        <p className="results-unlocked" data-testid="results-unlocked">
          Unlocked: {r.unlocked.join(', ')}
        </p>
      ) : null}
      <dl className="results-stats">
        {r.voyage ? <div><dt>Worlds cleared</dt><dd data-testid="results-legs">{r.voyage.legsCleared} of {r.voyage.legs}</dd></div> : null}
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
  const campaign = getCampaign('voyage').campaign;
  const ranked = MODES.flatMap((m) => {
    if (m.metric === 'none') return [];
    if (m.id === 'voyage') {
      // One table per start area and difficulty.
      return (campaign?.areas ?? []).flatMap((a) => m.variants.map((v) => ({ mode: m, variant: { ...v, id: `${v.id}@${a.id}`, label: `${a.name}, ${v.label}` } })));
    }
    return m.variants.map((v) => ({ mode: m, variant: v }));
  });
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
        <p>{BRAND.title} is a personal project. The music, sound effects, block designs, procedural worlds and code are original to this project.</p>
        <p>Real-world imagery: landscape panoramas and photoscanned rocks and trees from Poly Haven (CC0; by Andreas Mischok, Greg Zaal, Dario Barresi, James Ray Cock, Rico Cilliers and Jenelle van Heerden). Deep Cosmos: the Milky Way from &ldquo;The Milky Way panorama&rdquo;, ESO/S. Brunier (CC BY 4.0); the giant planet&rsquo;s surface from Cassini&rsquo;s maps of Jupiter, NASA/JPL/Space Science Institute.</p>
        <p>The Lost Kingdom: Sketchfab models &ldquo;El Palacio Palenque/Palenque&rsquo;s Palace&rdquo; by Daniel Bolaños (sketchfab.com/3d-models/el-palacio-palenquepalenques-palace-4f143d7d1718414fb70609607a7f528c) and &ldquo;Structure B1, Cahal Pech, Belize&rdquo; by csantasilia (sketchfab.com/3d-models/structure-b1-cahal-pech-belize-b543785d9b324280b56a72a3136a0271), CC BY 4.0, simplified and relit; &ldquo;Scarlet Macaw&rdquo; by Mateus Schwaab (sketchfab.com/3d-models/scarlet-macaw-0bb61160866b4811bd79b6d11e3d8907), &ldquo;Toucan Bird&rdquo; by sevketkabatas (sketchfab.com/3d-models/toucan-bird-eb77223ebfd946e69fb58ffe9ad32adf), &ldquo;Hummingbird &ndash; Rigged, 6 Animations (Open Bill)&rdquo; by Animal Animator (sketchfab.com/3d-models/hummingbird-rigged-6-animations-open-bill-d9b448ac1025485e843d54bebf35390a) and &ldquo;Animated Flying Fluttering Butterfly Loop&rdquo; by LasquetiSpice (sketchfab.com/3d-models/animated-flying-fluttering-butterfly-loop-80f8d9a6dadc411e89ca366cb0cfb0d9), CC BY 4.0, and &ldquo;Ulysses Butterfly&rdquo; by eb78 (sketchfab.com/3d-models/ulysses-butterfly-1155effb97564974aa0553db3d5eed57), CC BY-SA 4.0, all converted to particles; &ldquo;Mexico Maya Relief: K&rsquo;inich Ahkal&rdquo; by Aphva (CC0). The rainforest photograph, stone textures and plant scans are from Poly Haven (CC0; by Dimitrios Savva, Jarod Guest, Rob Tuytel, Amal Kumar, Rico Cilliers and Charlotte Baglioni).</p>
        <p>The Last Frontier: Sketchfab models &ldquo;Horse&rdquo; by Henry S (sketchfab.com/3d-models/horse-a6f860e43e364619bccb174a1ac7d0c9), &ldquo;Western Cowboy (Rigged)&rdquo; by human being (sketchfab.com/3d-models/western-cowboy-rigged-160bf043b71c458984c81c717b7483c9), &ldquo;Gunslinger&rdquo; by archiebattley (sketchfab.com/3d-models/gunslinger-95336de7a15145238c151388ee84d22b), &ldquo;Conestoga Wagon&rdquo; by Ursei (sketchfab.com/3d-models/conestoga-wagon-2bfd8f4232054fd982b29e4df0f367d1) and &ldquo;US Mail Stagecoach&rdquo; by tony chopper (sketchfab.com/3d-models/us-mail-stagecoach-17d0e94cc0ef4691a0a088ccc33f9b19), all CC BY 4.0; the riders posed in the saddle, and everything converted to particles. The Goegap Road panorama (Greg Zaal and James Ray Cock), the ground, timber and metal textures and the shrub scan are from Poly Haven (CC0); the sign lettering uses Rye, Alfa Slab One and Old Standard TT (SIL OFL 1.1) and Ultra (Apache 2.0).</p>
        <p>Particle animals in Northern Lights, Moving Sands, The Abyss, Frozen Kingdom, Dead Acre, Alpine Horizon, Enchanted Wilderness and Tradewind Cove: Sketchfab models &ldquo;Realistic Animated Elk 3D Model&rdquo; by WildMesh 3D (sketchfab.com/3d-models/realistic-animated-elk-3d-model-787834f9caa2474d9f1814b807c072d7), &ldquo;Camel&rdquo; by eb78 (sketchfab.com/3d-models/camel-99af7daa5baf450ea7b809937937e6d5), &ldquo;Blue whale&rdquo; by dannzjs (sketchfab.com/3d-models/blue-whale-a7969d8046754fa1b90f989ef451df1c), &ldquo;Humpback Whale (Idle)&rdquo; by Connlan_Immure (sketchfab.com/3d-models/humpback-whale-idle-bd64878acb0844b2be796ee91855c69e), &ldquo;Model 53A - Flatback Sea Turtle&rdquo; by DigitalLife3D (sketchfab.com/3d-models/model-53a-flatback-sea-turtle-442372b7f02b4730882d41d959726156), &ldquo;Alpha wolf&rdquo; by PrinceAli (sketchfab.com/3d-models/alpha-wolf-eabfb1220f3d4c4c88f3216bcf3d3bd0), &ldquo;Zombie Walk Test&rdquo; by OSCAR CREATIVO (sketchfab.com/3d-models/zombie-walk-test-165fd9342c364216bfdd8c2f1102223c), &ldquo;.fuse female zombie 1&rdquo; by Leonardo Carvalho (sketchfab.com/3d-models/fuse-female-zombie-1-98415df5d3124381a46ccef5c2e02b71), &ldquo;animated EAGLE&rdquo; by Asim3d (sketchfab.com/3d-models/animated-eagle-8fb150270adb45aa9653e857f3fa351b), &ldquo;Animated Deer&rdquo; by igor-lir (sketchfab.com/3d-models/animated-deer-4cff1e63f4e941198b3d56300b3393b9) and &ldquo;Dolphin&rdquo; by Alex_Pfe (sketchfab.com/3d-models/dolphin-c24dc835a6aa4d3c827450513525cdb8), all CC BY 4.0 and converted to particles.</p>
        <p>Creatures and machines of the living worlds: Sketchfab models &ldquo;Animated Sperm Whale&rdquo; by Anees Animates (sketchfab.com/3d-models/animated-sperm-whale-3076676b30294c119ec2065c3bf3dc47), &ldquo;Manta_new&rdquo; by yaniu03 (sketchfab.com/3d-models/manta-new-a87dcc1af76a464892c60540979274b5), &ldquo;Female Great White Shark - Rigged, 9 Animations&rdquo; and &ldquo;Akhal-Teke Stallion &mdash; Rigged &amp; Animated 3D Model&rdquo; by Animal Animator (sketchfab.com/3d-models/female-great-white-shark-rigged-9-animations-9f61db4db17b4d14918d25c404af01fb, sketchfab.com/3d-models/akhal-teke-stallion-rigged-animated-3d-model-3d6e93ffd4154c308ee2e35cfde3bc42), &ldquo;Anglerfish&rdquo; by Abby_Holzworth1 (sketchfab.com/3d-models/anglerfish-5e2f4b2d2e1a4613a008b6caaf40d50c), &ldquo;Waltz of the sharks&rdquo; by Eques_inferno (sketchfab.com/3d-models/waltz-of-the-sharks-a2120785dd7e43b797301413ba109c37), &ldquo;Eagle stingray&rdquo;, &ldquo;Flamingosf&rdquo;, &ldquo;Jaguarsf&rdquo; and &ldquo;Gazella&rdquo; by kenchoo (sketchfab.com/3d-models/eagle-stingray-4d615971858940f38703a1f1ffb370be, sketchfab.com/3d-models/flamingosf-1e3177972173413c9533f59395bd4910, sketchfab.com/3d-models/jaguarsf-194775ef066e41cf8f4e6f69608f3310, sketchfab.com/3d-models/gazella-b2c70a0821ef4c6ca0c096e33bc97593), &ldquo;Seagull&rdquo; by Dayvable (sketchfab.com/3d-models/seagull-dc42ffc81c86480e9e7f7752fa134174), &ldquo;Quetzal Animation &amp; Texture Test&rdquo; by Christian-Gomez (sketchfab.com/3d-models/quetzal-animation-texture-test-b55517c209d74762b371bc6ce0d1e56f), &ldquo;Realistic Animated Bear 3D Model&rdquo;, &ldquo;Realistic Animated Doe 3D Model&rdquo; and &ldquo;Realistic Animated Donkey 3D Model&rdquo; by WildMesh 3D (sketchfab.com/3d-models/realistic-animated-bear-3d-model-bffc3c87d2d148ff8533e1cc8a11c9f1, sketchfab.com/3d-models/realistic-animated-doe-3d-model-b6172618aa304473a4cf7b9246c0a218, sketchfab.com/3d-models/realistic-animated-donkey-3d-model-2b4086035df94d9e88fd0f18d34b3872), &ldquo;Farm Cow Animated Dairy cattle&rdquo; by Rukh3D (sketchfab.com/3d-models/farm-cow-animated-dairy-cattle-0e780cb5ab6d457198ded7d4e191a03e), &ldquo;Whooping Crane &ndash; Flying Rigged Bird&rdquo; and &ldquo;Snowy Owl - Gliding 3D Bird Model&rdquo; by Pigcraft (sketchfab.com/3d-models/whooping-crane-flying-rigged-bird-c207f839b5ad4f8eb5605c166fe6d790, sketchfab.com/3d-models/snowy-owl-gliding-3d-bird-model-22ccf3e782484f968e4c1be1e78deffa), &ldquo;Industrial robot arm&rdquo; by olofunot (sketchfab.com/3d-models/industrial-robot-arm-b4b5931851754747a734f72234c87e38), &ldquo;Bat&rdquo; by ice9 (credited as Dzimge in the download; sketchfab.com/3d-models/bat-8719886cf8f645ca9d53d766976baf9c) and &ldquo;Crow&rdquo; by Alexei Ostapenko (sketchfab.com/3d-models/crow-d5a9b0df4da3493688b63ce42c8a83e2), all CC BY 4.0; simplified and optimised for the game.</p>
        <p>Built with three.js (MIT), React (MIT), Zustand (MIT), Zod (MIT) and idb (ISC). Interface type is Unbounded and Atkinson Hyperlegible Next, both under the SIL Open Font License 1.1.</p>
        <p>The complete asset and licence record lives in ASSET_LICENSES.md in the project folder.</p>
      </div>
      <MenuList>
        <MenuItem label="Back" onSelect={() => goBack()} autoFocus />
      </MenuList>
    </MenuScreen>
  );
}
