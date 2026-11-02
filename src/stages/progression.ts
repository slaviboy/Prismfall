import type { Progress } from '../storage/repositories';
import type { StageManifest } from './schema';

/** Whether a stage is playable outside Voyage. Progression is independent of the game rules. */
export function isStageUnlocked(manifest: StageManifest, progress: Progress, unlockAll: boolean): boolean {
  if (unlockAll) return true;
  const rule = manifest.unlock;
  switch (rule.type) {
    case 'always':
      return true;
    case 'voyageLeg':
      return progress.voyage.completedLegs.includes(rule.leg) || progress.stages[manifest.id]?.unlocked === true;
    case 'stageCompleted':
      return progress.stages[rule.stage]?.completed === true;
    case 'score':
      return (progress.bestByMode[rule.mode] ?? 0) >= rule.score;
  }
}

/** Human-readable unlock requirement for locked stages. */
export function unlockHint(manifest: StageManifest, stageName: (id: string) => string): string {
  const rule = manifest.unlock;
  switch (rule.type) {
    case 'always':
      return '';
    case 'voyageLeg':
      return 'Reach this world in Voyage to unlock it.';
    case 'stageCompleted':
      return `Complete ${stageName(rule.stage)} in Voyage to unlock it.`;
    case 'score':
      return `Score ${rule.score.toLocaleString('en-US')} in ${rule.mode[0]?.toUpperCase()}${rule.mode.slice(1)} to unlock it.`;
  }
}
