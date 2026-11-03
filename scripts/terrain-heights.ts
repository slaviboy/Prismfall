/** Height percentiles of a stage terrain layer near the playfield (tuning water and lava levels).
 *  Usage: node scripts/terrain-heights.ts <stage-id> <layer-id> */
import { readFileSync } from 'node:fs';
import { createHeightfield, heightfieldSchema } from '../src/rendering/environments/terrain/heightfield.ts';

const [stage, layer] = process.argv.slice(2);
const m = JSON.parse(readFileSync(`content/stages/${stage}/stage.json`, 'utf8'));
const l = m.environment.layers.find((x: { id: string }) => x.id === layer);
const h = createHeightfield(heightfieldSchema.parse(l.params.height));
const vals: number[] = [];
for (let z = -20; z > -260; z -= 4) for (let x = -200; x < 200; x += 4) vals.push(h(x, z));
vals.sort((a, b) => a - b);
const q = (p: number) => vals[Math.floor(p * (vals.length - 1))]!.toFixed(2);
console.log(`min ${q(0)} p10 ${q(0.1)} p25 ${q(0.25)} p50 ${q(0.5)} p75 ${q(0.75)} max ${q(1)}`);
