/**
 * Writes MUSIC_REACTIVE_ENVIRONMENTS.md: every world's music reaction profile (living.json) as a
 * readable table, with the measured drive statistics of its default track (docs/living/drives.json,
 * from scripts/living-survey.ts) beside it.
 *
 * Usage: node scripts/living-report.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const stagesDir = join(ROOT, 'content', 'stages');
const drivesPath = join(ROOT, 'docs', 'living', 'drives.json');
const drives = existsSync(drivesPath) ? (JSON.parse(readFileSync(drivesPath, 'utf8')) as Record<string, DriveReport>) : {};

interface Stats {
  readonly mean: Record<string, number>;
  readonly p90: Record<string, number>;
  readonly cues: Record<string, number>;
}
interface DriveReport extends Stats {
  readonly title: string;
  readonly bpm: number;
  readonly seconds: number;
  readonly sections: (Stats & { name: string; kind: string; intensity: number; startS: number; endS: number })[];
}
interface Reaction {
  layer: string;
  target: string;
  drive: string;
  amount: number;
  mode?: string;
  role?: string;
}
interface Event {
  layer: string;
  on: string;
  action: string;
  every?: [number, number];
  group?: string;
  chance?: number;
  cooldown?: number;
  params?: Record<string, unknown>;
}

const ROLE_ORDER = ['large', 'mid', 'fine', 'beat', 'section'];
const ROLE_LABEL: Record<string, string> = { large: 'Large (bass, slow)', mid: 'Medium (mids)', fine: 'Fine (treble)', beat: 'Beat', section: 'Song structure' };

function eventText(e: Event): string {
  const when = e.on === 'ambient' ? `every ${e.every?.[0]}–${e.every?.[1]} s` : e.on.replace('music:', 'music ');
  const what = e.action === 'pulse' ? `${e.layer}.${String(e.params?.target)} swells ×${String(e.params?.amount)}` : e.action === 'wave' ? `a wave through the world (${String(e.params?.strength)})` : `${e.layer} ${e.action}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ''}`;
  const extra = [e.group ? `group ${e.group}` : '', e.chance !== undefined && e.chance < 1 ? `chance ${e.chance}` : '', e.cooldown !== undefined ? `cooldown ${e.cooldown} s` : ''].filter(Boolean).join(', ');
  return `| ${when} | ${what.replace(/\|/g, '\\|')} | ${extra} |`;
}

const out: string[] = [];
out.push('# Music-reactive environments');
out.push('');
out.push("How each world answers its music (brief §40.5–§40.9). Every world has its own reaction profile in `content/stages/<id>/living.json`, read by the one Environment Music Director (LIVING_ENVIRONMENT_ARCHITECTURE.md). This page is generated from those files and from the drive measurements of each world's default track (`node scripts/living-report.ts` after `node scripts/living-survey.ts`); do not edit the per-world sections by hand.");
out.push('');
out.push('## How the profiles were tuned');
out.push('');
out.push("- **The measurements.** Each world's default track was rendered offline by the game's own synthesiser, analysed by the game's DSP with the composition's real beat grid and sections, and fed to the director at 60 Hz (`src/audio/lab/driveReport.ts`). The tables give the mean / 90th percentile of the main drives over the first pass, and per section.");
out.push('- **The amounts.** Amounts are multipliers on top of the authored look. A `mul` amount of 0.3 on a drive averaging 0.5 adds about 15 % on average and 20–25 % at the drive\'s peaks.');
out.push('- **Shared rules for every world.**');
out.push('  - The bass drives (`body`, `swell`) go on the largest, slowest elements, the mids (`motion`) on medium ones, and the treble (`detail`, `shimmer`) on fine particles and small lights.');
out.push('  - The song\'s structure (`intensity`, `tension`) goes on density and activity.');
out.push('  - Drops and peaks get the world\'s big moments (pulses, a wave, a creature or a set piece).');
out.push('  - Ambient timers keep visitors coming in quiet play.');
out.push('- **Never on the beat.** Nothing pulses global light on the beat.');
out.push('- **On top of the old bindings.** The worlds\' earlier `stage.json` bindings (raw bass, treble and game signals) are kept: the profiles add to them.');
out.push('');
out.push('Drives: `body` sub-bass+bass · `swell` slow bass/loudness · `motion` mids · `detail` treble · `shimmer` treble rising · `intensity` section · `tension` builds · `calm` quiet passages · `accent` governed onsets.');
out.push('');

const ids = readdirSync(stagesDir).filter((id) => existsSync(join(stagesDir, id, 'living.json'))).sort();
const manifests = ids.map((id) => ({ id, m: JSON.parse(readFileSync(join(stagesDir, id, 'stage.json'), 'utf8')) as { name: string; order: number } })).sort((a, b) => a.m.order - b.m.order);
for (const { id, m } of manifests) {
  const living = JSON.parse(readFileSync(join(stagesDir, id, 'living.json'), 'utf8')) as { description: string; music: Reaction[]; events: Event[]; classes?: Record<string, string> };
  out.push(`## ${m.name} (\`${id}\`)`);
  out.push('');
  out.push(living.description);
  out.push('');
  if (living.music.length > 0) {
    out.push('| Role | Layer target | Drive | Amount |');
    out.push('|---|---|---|---|');
    const sorted = [...living.music].sort((a, b) => ROLE_ORDER.indexOf(a.role ?? '') - ROLE_ORDER.indexOf(b.role ?? ''));
    for (const r of sorted) out.push(`| ${ROLE_LABEL[r.role ?? ''] ?? ''} | ${r.layer}.${r.target} | ${r.drive} | ${r.mode === 'add' ? '+' : '×'}${r.amount} |`);
    out.push('');
  }
  if (living.events.length > 0) {
    out.push('| When | What | Limits |');
    out.push('|---|---|---|');
    for (const e of living.events) out.push(eventText(e));
    out.push('');
  }
  if (living.classes && Object.keys(living.classes).length > 0) out.push(`Class overrides: ${Object.entries(living.classes).map(([k, v]) => `\`${k}\` → ${v}`).join(', ')}.\n`);
  const d = drives[id];
  if (d) {
    const f = (s: Stats, k: string) => `${(s.mean[k] ?? 0).toFixed(2)} / ${(s.p90[k] ?? 0).toFixed(2)}`;
    out.push(`Measured on "${d.title}" (${d.bpm} BPM, first ${d.seconds} s):`);
    out.push('');
    out.push('| Section | Kind | Composed | body | motion | detail | intensity | tension | calm | accents/min |');
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const s of d.sections) out.push(`| ${s.name} | ${s.kind} | ${s.intensity.toFixed(2)} | ${f(s, 'body')} | ${f(s, 'motion')} | ${f(s, 'detail')} | ${f(s, 'intensity')} | ${f(s, 'tension')} | ${f(s, 'calm')} | ${s.cues.accent ?? 0} |`);
    out.push(`| **whole track** | | | ${f(d, 'body')} | ${f(d, 'motion')} | ${f(d, 'detail')} | ${f(d, 'intensity')} | ${f(d, 'tension')} | ${f(d, 'calm')} | ${d.cues.accent ?? 0} |`);
    out.push('');
  }
}
out.push('## Worlds named in the brief that do not exist yet');
out.push('');
out.push('The brief also names Tempest, The Simulation and The Arcane Academy. None of them exists in this build, so there is no profile for them. When one is built, it gets a `living.json` like the ones above; the brief\'s mappings for them are the starting point:');
out.push('');
out.push('- **Tempest:** bass on the storm clouds, mids on the wind, treble on the rain and the electrical details, major sections calling distant lightning.');
out.push('- **The Simulation:** bass on the large digital structures, mids on the data streams, treble on fine digital particles, beats on selected streams, transitions calling anomalies.');
out.push('- **The Arcane Academy:** bass on the large magical structures, mids on the floating objects, treble on magical particles, sections on the magical light and distant lightning.');
out.push('');
writeFileSync(join(ROOT, 'MUSIC_REACTIVE_ENVIRONMENTS.md'), `${out.join('\n')}\n`);
console.log(`MUSIC_REACTIVE_ENVIRONMENTS.md: ${manifests.length} worlds, ${Object.keys(drives).length} with drive measurements`);
