import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFeed, stripHtml, decode, withinHours, dedupe, collect } from '../src/feeds.js';
import { compileHunt, scoreItem, rank } from '../src/score.js';

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const hunt = async (name) => JSON.parse(await readFile(new URL(`../hunts/${name}.json`, import.meta.url), 'utf8'));

const find = (items, fragment) => items.find((i) => i.title.includes(fragment));

test('decodes entities and strips markup', () => {
  assert.equal(decode('Tom &amp; Jerry &#39;96'), "Tom & Jerry '96");
  assert.equal(stripHtml('<div>hello <b>there</b></div>'), 'hello there');
  assert.equal(stripHtml('<![CDATA[raw text]]>'), 'raw text');
});

test('parses Atom feeds (Reddit)', async () => {
  const items = parseFeed(await fixture('reddit.xml'), 'r/forhire');
  assert.equal(items.length, 4);
  const hiring = find(items, 'Shopify to QuickBooks');
  assert.equal(hiring.author, '/u/shopowner22');
  assert.equal(hiring.url, 'https://www.reddit.com/r/forhire/comments/aaa111/hiring_shopify_quickbooks/');
  assert.match(hiring.body, /re-entered into QuickBooks manually/);
  assert.equal(hiring.at, '2026-09-14T15:04:00.000Z');
});

test('parses RSS/RDF feeds (Craigslist)', async () => {
  const items = parseFeed(await fixture('craigslist.xml'), 'craigslist/milwaukee');
  assert.equal(items.length, 2);
  const gig = find(items, 'automate our data entry');
  assert.equal(gig.url, 'https://milwaukee.craigslist.org/cpg/d/data-entry-automation/7777777.html');
  assert.match(gig.body, /copying orders from email/);
});

test('a real hiring post with budget and pain scores high', async () => {
  const items = parseFeed(await fixture('reddit.xml'), 'r/forhire');
  const compiled = compileHunt(await hunt('freelance'));
  const scored = scoreItem(find(items, 'Shopify to QuickBooks'), compiled);
  assert.equal(scored.excluded, false);
  assert.ok(scored.score >= 10, `expected a strong score, got ${scored.score}`);
  assert.deepEqual(scored.matched.sort(), ['budget', 'intent', 'pain', 'skill']);
});

test('[For Hire] posts are excluded even though they mention the right skills', async () => {
  const items = parseFeed(await fixture('reddit.xml'), 'r/forhire');
  const compiled = compileHunt(await hunt('freelance'));
  const scored = scoreItem(find(items, 'Full stack dev'), compiled);
  assert.equal(scored.excluded, true);
  assert.equal(scored.score, 0);
});

test('crypto and revenue-share work is excluded', async () => {
  const items = parseFeed(await fixture('reddit.xml'), 'r/forhire');
  const compiled = compileHunt(await hunt('freelance'));
  const scored = scoreItem(find(items, 'Crypto trading bot'), compiled);
  assert.equal(scored.excluded, true);
});

test('ranking keeps only relevant posts, best first', async () => {
  const reddit = parseFeed(await fixture('reddit.xml'), 'r/forhire');
  const craigslist = parseFeed(await fixture('craigslist.xml'), 'craigslist/milwaukee');
  const compiled = compileHunt(await hunt('freelance'));
  const hits = rank([...reddit, ...craigslist], compiled);

  const titles = hits.map((h) => h.title);
  assert.ok(titles.some((t) => t.includes('Shopify to QuickBooks')));
  assert.ok(titles.some((t) => t.includes('automate our data entry')));
  assert.ok(!titles.some((t) => t.includes('Dog walker')), 'dog walking is not a lead');
  assert.ok(!titles.some((t) => t.includes('Espresso')), 'off-topic chatter is not a lead');
  assert.ok(!titles.some((t) => t.includes('For Hire')), 'service offers are not leads');
  assert.ok(hits[0].score >= hits[hits.length - 1].score, 'sorted by score descending');
});

test('keyword stuffing cannot run away with the score', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  const stuffed = scoreItem({
    title: '[Hiring] api api api integration sync webhook automation zapier n8n airtable etl csv',
    body: 'api integration sync webhook automation zapier scraping script migrate quickbooks shopify netsuite salesforce dashboard database',
    url: 'https://example.com/1',
  }, compiled);
  const skillGroupMax = 3 * 2;
  const intentGroupMax = 3 * 2;
  assert.ok(stuffed.score <= skillGroupMax + intentGroupMax, `group caps should bound the score, got ${stuffed.score}`);
});

test('time window and dedupe', () => {
  const now = Date.now();
  const items = [
    { title: 'fresh', url: 'https://x.com/1', at: new Date(now - 3600_000).toISOString() },
    { title: 'stale', url: 'https://x.com/2', at: new Date(now - 90 * 3600_000).toISOString() },
    { title: 'undated', url: 'https://x.com/3', at: null },
  ];
  const recent = withinHours(items, 26);
  assert.deepEqual(recent.map((i) => i.title), ['fresh', 'undated']);

  const dupes = [
    { title: 'a', url: 'https://x.com/1?utm=reddit' },
    { title: 'b', url: 'https://x.com/1?utm=twitter' },
    { title: 'c', url: 'https://x.com/2' },
  ];
  assert.equal(dedupe(dupes).length, 2);
});

test('requests to one host never overlap, but different hosts start together', async () => {
  const inflight = { reddit: 0, hackernews: 0 };
  const peak = { reddit: 0, hackernews: 0 };
  const started = [];

  const fetcher = async (s) => {
    const key = s.name || s.query;
    started.push(s.type);
    inflight[s.type] += 1;
    peak[s.type] = Math.max(peak[s.type], inflight[s.type]);
    await new Promise((r) => setTimeout(r, 5));
    inflight[s.type] -= 1;
    return [{ title: key, url: `https://x.com/${key}` }];
  };

  const { items, errors } = await collect([
    { type: 'reddit', name: 'forhire' },
    { type: 'reddit', name: 'jobbit' },
    { type: 'reddit', name: 'msp' },
    { type: 'hackernews', query: 'SEEKING FREELANCER' },
  ], { delayMs: 0, fetcher });

  assert.equal(peak.reddit, 1, 'reddit requests must be serialized — this is what caused the 429s');
  assert.deepEqual(new Set(started.slice(0, 2)), new Set(['reddit', 'hackernews']), 'hosts run in parallel');
  assert.equal(items.length, 4);
  assert.deepEqual(errors, []);
});

test('a 429 is retried once, then succeeds quietly', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) throw new Error('429 Too Many Requests for https://www.reddit.com/r/forhire/new.rss');
    return [{ title: 'recovered', url: 'https://x.com/ok' }];
  };

  const { items, errors } = await collect(
    [{ type: 'reddit', name: 'forhire' }],
    { delayMs: 0, retryMs: 0, fetcher },
  );
  assert.equal(calls, 2);
  assert.deepEqual(items.map((i) => i.title), ['recovered']);
  assert.deepEqual(errors, []);
});

test('a non-429 failure is reported without retry and never sinks the run', async () => {
  let calls = 0;
  const fetcher = async (s) => {
    calls += 1;
    if (s.name === 'dead') throw new Error('403 Forbidden');
    return [{ title: s.name, url: `https://x.com/${s.name}` }];
  };

  const { items, errors } = await collect([
    { type: 'reddit', name: 'dead' },
    { type: 'reddit', name: 'alive' },
  ], { delayMs: 0, retryMs: 0, fetcher });

  assert.equal(calls, 2, '403 should not be retried');
  assert.deepEqual(items.map((i) => i.title), ['alive']);
  assert.deepEqual(errors, ['reddit:dead — 403 Forbidden']);
});

test('invalid regex in a config is skipped, not fatal', () => {
  const compiled = compileHunt({
    name: 'broken',
    minScore: 1,
    signals: { intent: { weight: 3, patterns: ['valid', '((('] } },
    exclude: [],
  });
  assert.equal(compiled.signals[0].regexes.length, 1);
  assert.ok(scoreItem({ title: 'valid request', body: '', url: 'https://x.com/1' }, compiled).score > 0);
});
