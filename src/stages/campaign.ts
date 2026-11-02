import { z } from 'zod';

/** Voyage difficulty: scales every leg's line goal and shifts its speed level. */
const difficultySchema = z.object({
  linesScale: z.number().min(0.25).max(3),
  levelOffset: z.number().int().min(-10).max(10),
});

export const VOYAGE_DIFFICULTIES = ['relaxed', 'standard', 'intense'] as const;
export type VoyageDifficulty = (typeof VOYAGE_DIFFICULTIES)[number];

export const campaignSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  areas: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        name: z.string(),
        description: z.string().default(''),
        legs: z
          .array(
            z.object({
              /** Stage id; each stage appears at most once in a campaign (its leg id). */
              stage: z.string(),
              /** Lines to clear in this leg at Standard difficulty. */
              lines: z.number().int().min(1).max(200),
              /** Speed level while in this leg at Standard difficulty. */
              level: z.number().int().min(1).max(30),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  difficulties: z.object({ relaxed: difficultySchema, standard: difficultySchema, intense: difficultySchema }),
});
export type Campaign = z.infer<typeof campaignSchema>;

export interface VoyageLeg {
  readonly areaId: string;
  readonly areaIndex: number;
  readonly legIndex: number;
  readonly stage: string;
  readonly lines: number;
  readonly level: number;
  /** Total lines at which this leg starts and ends (cumulative over the run). */
  readonly startLines: number;
  readonly endLines: number;
}

export interface VoyagePlan {
  readonly startAreaId: string;
  readonly difficulty: VoyageDifficulty;
  readonly legs: readonly VoyageLeg[];
  readonly totalLines: number;
}

/** A run from the start of one area to the end of the campaign, scaled for the difficulty. */
export function planVoyage(campaign: Campaign, startAreaId: string, difficulty: VoyageDifficulty): VoyagePlan {
  const startIndex = Math.max(0, campaign.areas.findIndex((a) => a.id === startAreaId));
  const d = campaign.difficulties[difficulty];
  const legs: VoyageLeg[] = [];
  let total = 0;
  campaign.areas.slice(startIndex).forEach((area, i) => {
    area.legs.forEach((leg, legIndex) => {
      const lines = Math.max(1, Math.round(leg.lines * d.linesScale));
      legs.push({ areaId: area.id, areaIndex: startIndex + i, legIndex, stage: leg.stage, lines, level: Math.max(1, Math.min(30, leg.level + d.levelOffset)), startLines: total, endLines: total + lines });
      total += lines;
    });
  });
  return { startAreaId: campaign.areas[startIndex]?.id ?? startAreaId, difficulty, legs, totalLines: total };
}

/** Progress through a planned run; pure, so it can be tested without a game. */
export class VoyageRun {
  index = 0;
  readonly completed: VoyageLeg[] = [];
  constructor(readonly plan: VoyagePlan) {}

  get current(): VoyageLeg {
    return this.plan.legs[this.index] as VoyageLeg;
  }

  get finished(): boolean {
    return this.completed.length === this.plan.legs.length;
  }

  /** Fraction of the current leg done at `lines` total cleared lines. */
  progress(lines: number): number {
    const leg = this.current;
    return Math.max(0, Math.min(1, (lines - leg.startLines) / Math.max(1, leg.lines)));
  }

  /**
   * Accounts for `lines` total cleared lines: returns legs completed by it and the leg entered
   * (null if still in the same leg, or after the final leg).
   */
  advance(lines: number): { completed: VoyageLeg[]; entered: VoyageLeg | null } {
    const done: VoyageLeg[] = [];
    while (!this.finished && lines >= this.current.endLines) {
      done.push(this.current);
      this.completed.push(this.current);
      if (this.index < this.plan.legs.length - 1) this.index++;
      else break;
    }
    const entered = done.length > 0 && !this.finished ? this.current : null;
    return { completed: done, entered };
  }

  /** Areas whose every leg was completed in this run. */
  completedAreas(): string[] {
    const ids = [...new Set(this.plan.legs.map((l) => l.areaId))];
    return ids.filter((id) => this.plan.legs.filter((l) => l.areaId === id).every((l) => this.completed.includes(l)));
  }
}
