#!/usr/bin/env node
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { collect, withinHours, dedupe } from './feeds.js';
import { compileHunt, rank } from './score.js';
import { buildReport } from './report.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const huntName = arg('hunt', 'freelance');
const hours = Number(arg('hours', '26'));
const out = arg('out');

const hunt = JSON.parse(await readFile(new URL(`../hunts/${huntName}.json`, import.meta.url), 'utf8'));
const { items, errors } = await collect(hunt.sources);
const fresh = dedupe(withinHours(items, hours));
const hits = rank(fresh, compileHunt(hunt));
const report = buildReport(hits, { hunt, hours, errors, scanned: fresh.length });

if (out) {
  await writeFile(out, report);
  console.log(`${huntName}: ${hits.length} leads from ${fresh.length} posts → ${out}`);
} else {
  console.log(report);
}

for (const err of errors) console.warn(`warn: ${err}`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `hits=${hits.length}\n`);
}
