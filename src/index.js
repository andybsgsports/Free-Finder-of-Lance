#!/usr/bin/env node
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { collect, withinHours, dedupe, selectSources } from './feeds.js';
import { compileHunt, rank, misses, tally } from './score.js';
import { buildReport } from './report.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const huntName = arg('hunt', 'freelance');
const hours = Number(arg('hours', '26'));
const out = arg('out');

const hunt = JSON.parse(await readFile(new URL(`../hunts/${huntName}.json`, import.meta.url), 'utf8'));
const sources = selectSources(hunt.sources);
const skipped = hunt.sources.length - sources.length;
const { items, errors } = await collect(sources);
const fresh = dedupe(withinHours(items, hours));
const compiled = compileHunt(hunt);
const hits = rank(fresh, compiled);
const nearMisses = misses(fresh, compiled);
const report = buildReport(hits, { hunt, hours, errors, scanned: fresh.length, misses: nearMisses });

if (out) {
  await writeFile(out, report);
  console.log(`${huntName}: ${hits.length} leads from ${fresh.length} posts → ${out}`);
} else {
  console.log(report);
}

if (skipped) {
  console.log(`skipped ${skipped} source${skipped === 1 ? '' : 's'} that need a residential IP (set HUNT_LOCAL=1 to include them)`);
}

const counts = tally(fresh, compiled);
console.log(
  `breakdown: ${counts.leads} leads · ${counts.gated} missing a required signal`
  + ` · ${counts.tooLow} below minScore ${compiled.minScore} · ${counts.excluded} excluded outright`,
);
for (const miss of nearMisses.slice(0, 5)) {
  console.log(`  near: ${miss.score} — ${miss.reason || 'below threshold'} — ${miss.title.slice(0, 80)}`);
}

for (const err of errors) console.warn(`warn: ${err}`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `hits=${hits.length}\n`);
}
