import { useState, type ReactNode } from 'react';
import { shell } from '../../app/GameShell';
import { goBack, toast } from '../../app/stores';
import { useProgress } from '../../app/progressStore';
import { getMode, getVariant, highScoreKey } from '../../game/modes/modes';
import { planVoyage, VOYAGE_DIFFICULTIES, type Campaign, type VoyageDifficulty } from '../../stages/campaign';
import { getCampaign, getStage } from '../../stages/registry';
import type { Progress } from '../../storage/repositories';
import { getSettings, updateSection, useSettings } from '../../settings/store';
import { ChoiceRow, MenuList } from '../components/controls';
import { formatScore } from '../format';
import { useConfirmBackLabels } from '../hints';
import { ControlHints, MenuScreen } from './MenuScreen';
import { StageArt } from './StageSelect';
import { hoverFocus } from '../navigation/hoverFocus';

type Area = Campaign['areas'][number];

/** The first area is always open; each later one opens when the area before it is completed. */
export function isAreaUnlocked(campaign: Campaign, index: number, progress: Progress, unlockAll: boolean): boolean {
  if (unlockAll || index === 0) return true;
  const prev = campaign.areas[index - 1];
  return prev ? progress.voyage.completedAreas.includes(prev.id) : true;
}

function difficultyOf(variantId: string | undefined): VoyageDifficulty {
  return (VOYAGE_DIFFICULTIES as readonly string[]).includes(variantId ?? '') ? (variantId as VoyageDifficulty) : 'standard';
}

function AreaDetails(props: { campaign: Campaign; area: Area | undefined; difficulty: VoyageDifficulty; locked: boolean }): ReactNode {
  const { area, campaign } = props;
  if (!area) return null;
  const plan = planVoyage(campaign, area.id, props.difficulty);
  const own = plan.legs.filter((l) => l.areaId === area.id);
  const later = plan.legs.length - own.length;
  return (
    <div className="world-details" data-testid="area-details">
      <h2 className="world-details-name">{area.name}</h2>
      <p className="world-details-desc">{area.description}</p>
      <ol className="area-legs">
        {own.map((leg) => (
          <li key={leg.stage}>
            {getStage(leg.stage)?.manifest?.name ?? leg.stage}: {leg.lines} lines at speed {leg.level}
          </li>
        ))}
      </ol>
      <p className="world-details-music">
        {later > 0 ? `Then ${later} more ${later === 1 ? 'world' : 'worlds'}, ${plan.totalLines} lines in all.` : `${plan.totalLines} lines to the end of the journey.`}
      </p>
      {props.locked ? <p className="world-details-lock">Complete the area before this one to start here.</p> : null}
    </div>
  );
}

/** Voyage: choose a difficulty and an area to start from; the run continues to the final world. */
export function VoyageScreen(): ReactNode {
  const info = getCampaign('voyage');
  const campaign = info.campaign;
  const progress = useProgress((s) => s.progress);
  const unlockAll = useSettings((s) => s.setup.unlockAll);
  const difficulty = difficultyOf(useSettings((s) => s.setup.variants.voyage));
  const [focus, setFocus] = useState(0);
  const { confirm, back } = useConfirmBackLabels();
  const mode = getMode('voyage');

  if (!campaign) {
    return (
      <MenuScreen title="Voyage" onBack={() => goBack()} testId="voyage-screen">
        <p className="menu-note">The Voyage campaign could not be loaded: {info.errors.join('; ')}</p>
      </MenuScreen>
    );
  }

  const start = (index: number): void => {
    const area = campaign.areas[index];
    if (!area) return;
    if (!isAreaUnlocked(campaign, index, progress, unlockAll)) {
      toast(`Complete ${campaign.areas[index - 1]?.name ?? 'the previous area'} to start from ${area.name}.`, 'warning');
      return;
    }
    shell.startGame({ modeId: 'voyage', variantId: `${difficulty}@${area.id}`, stageId: area.legs[0]?.stage ?? '', voyage: { areaId: area.id, difficulty } });
  };

  return (
    <MenuScreen
      title="Voyage"
      subtitle={mode.tagline}
      onBack={() => goBack()}
      testId="voyage-screen"
      aside={<AreaDetails campaign={campaign} area={campaign.areas[focus]} difficulty={difficulty} locked={!isAreaUnlocked(campaign, focus, progress, unlockAll)} />}
      footer={
        <ControlHints
          hints={[
            { keys: confirm, label: 'Set out' },
            { keys: back, label: 'Back' },
          ]}
        />
      }
    >
      <ChoiceRow
        label="Difficulty"
        description={getVariant(mode, difficulty).description}
        value={difficulty}
        options={mode.variants.map((v) => ({ value: v.id, label: v.label }))}
        onChange={(v) => updateSection('setup', { variants: { ...getSettings().setup.variants, voyage: v } })}
        testId="voyage-difficulty"
      />
      <MenuList className="world-list">
        {campaign.areas.map((area, i) => {
          const locked = !isAreaUnlocked(campaign, i, progress, unlockAll);
          const done = progress.voyage.completedAreas.includes(area.id);
          const best = progress.voyage.bestScores[highScoreKey('voyage', `${difficulty}@${area.id}`)];
          const meta = locked ? 'Locked' : done ? `Completed${best ? `, best ${formatScore(best)}` : ''}` : best ? `Best ${formatScore(best)}` : 'Not reached yet';
          return (
            <button
              key={area.id}
              type="button"
              className={`world-card area-card${locked ? ' is-locked' : ''}`}
              data-focusable
              data-autofocus={i === 0 ? '' : undefined}
              data-testid={`area-${area.id}`}
              onFocus={() => {
                setFocus(i);
                const first = area.legs[0]?.stage;
                if (first) shell.stageManager?.preview(first);
              }}
              onMouseEnter={hoverFocus}
              onClick={() => start(i)}
            >
              <span className="area-card-art">
                {area.legs.map((leg) => (
                  <StageArt key={leg.stage} info={getStage(leg.stage)} className="area-leg-art" />
                ))}
              </span>
              <span className="world-card-text">
                <span className="world-card-name">{area.name}</span>
                <span className="world-card-meta">{meta}</span>
              </span>
            </button>
          );
        })}
      </MenuList>
    </MenuScreen>
  );
}
