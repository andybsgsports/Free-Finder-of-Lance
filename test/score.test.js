import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFeed, parseListing, stripHtml, decode, withinHours, dedupe, collect, hostOf, label, order, selectSources, unseen, urlKey } from '../src/feeds.js';
import { compileHunt, scoreItem, rank, misses, tally } from '../src/score.js';
import { buildReport, urlsFromReport } from '../src/report.js';

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
  const skill = compiled.signals.find((g) => g.name === 'skill');
  const skillHits = skill.regexes.filter((re) => re.test(`${stuffed.title} ${stuffed.body}`)).length;
  assert.ok(skillHits >= 6, 'this fixture is supposed to stuff the skill group');

  // Each group contributes at most 2x its weight no matter how many of its
  // patterns fire, so the cap is derived from the config rather than hardcoded.
  const cap = compiled.signals
    .filter((g) => stuffed.matched.includes(g.name))
    .reduce((sum, g) => sum + g.weight * 2, 0);
  assert.ok(stuffed.score <= cap, `group caps should bound the score, got ${stuffed.score}`);
  assert.ok(stuffed.score < skill.weight * skillHits, 'uncapped scoring would score far higher');
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

// Every one of these actually showed up in a live run and was reported as a lead.
test('real hiring posts that are not your line of work are rejected', async () => {
  const compiled = compileHunt(await hunt('freelance'));

  const junk = [
    {
      title: '[Hiring] Chicago - butcher to cut steaks from a 17lb dry-aged standing rib roast',
      body: 'One-off job in Chicago. Saturday at 3pm. Paid, DM me for details.',
    },
    {
      title: '[Hiring] Virtual Assistant/Chatter $20 Per Hour USD',
      body: 'We are hiring a Virtual Assistant / Chatter for an intense remote position. $20 per hour.',
    },
    {
      title: '[Hiring] Short Paid Online Task - US Only',
      body: 'Around 20-30 minutes. Pay: $30 one-time. Basic computer skills required.',
    },
    {
      title: '[Hiring] Staff Software Engineer (IC4a) - TX, MD, SC, IN',
      body: 'Seeking a Staff Software Engineer, full-time position with benefits package and 401k, to drive our front-end platform and architecture.',
    },
    {
      // Survived three runs by matching "script" — as in cursive lettering.
      title: '[Hiring] Lf artist to design assets for my personal hoodie project',
      body: 'Budget is 350$, but flexible. I am in search of an artist to commission. Requirements: bold script lettering across the chest, no thin fonts.',
    },
  ];

  for (const [i, post] of junk.entries()) {
    const scored = scoreItem({ ...post, url: `https://example.com/junk${i}` }, compiled);
    assert.equal(scored.excluded, true, `should have been rejected: ${post.title}`);
  }
});

// Advice forums are full of "looking for" and "need a" — none of it means hiring.
test('people asking for advice or seeking work themselves are rejected', async () => {
  const compiled = compileHunt(await hunt('freelance'));

  const notLeads = [
    {
      title: 'I need an advice: SEO is already working a little for me BUT what is moving the needle in 2026?',
      body: 'Small service business on the automation side. SEO is not brand new for us, we have done the basics. Looking for what actually works now.',
    },
    {
      title: 'How to scale a high-quality cloud kitchen despite local pricing pushback?',
      body: "I'm looking for strategic advice on helping my mom launch a cloud kitchen. Our background and offering: specialty high-end bakery.",
    },
    {
      title: 'Looking to work for a small business',
      body: 'I am looking for a virtual freelance job on the side, 20 hrs a week. I work full time in corporate. I have dual bachelors degrees and can do data entry, spreadsheets and automation.',
    },
    {
      title: '[Hiring] Staff Software Engineer (IC4a) - TX, MD, SC, IN',
      body: "We are seeking a Staff Software Engineer to drive our client's front-end platform and architecture. This role is ideal for a hands-on technical leader. 8+ years of experience.",
    },
  ];

  for (const [i, post] of notLeads.entries()) {
    const scored = scoreItem({ ...post, url: `https://example.com/advice${i}` }, compiled);
    assert.equal(scored.excluded, true, `should have been rejected: ${post.title}`);
  }
});

test('a genuine automation request still gets through', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  const scored = scoreItem({
    title: '[Hiring] Need someone to sync our orders into QuickBooks automatically',
    body: 'Staff currently re-enter every order by hand, it takes hours. Budget $2,500.',
    url: 'https://example.com/good',
  }, compiled);
  assert.equal(scored.excluded, false);
  assert.ok(scored.matched.includes('skill'), 'skill is required');
  assert.ok(scored.score >= compiled.minScore);
});

test('every configured source is one the fetcher knows how to handle', async () => {
  const cfg = await hunt('freelance');
  const known = new Set(['reddit', 'redditsearch', 'craigslist', 'hackernews']);
  for (const s of cfg.sources) {
    assert.ok(known.has(s.type), `unknown source type: ${s.type}`);
    assert.ok(s.name || s.query, `source needs a name or a query: ${JSON.stringify(s)}`);
  }
  assert.ok(
    cfg.sources.some((s) => s.type === 'redditsearch' && /netsuite consultant/i.test(s.query)),
    'NetSuite consultant work is searched for by name',
  );
});

test('NetSuite work is a lead, and outranks the same request without it', async () => {
  const compiled = compileHunt(await hunt('freelance'));

  const netsuite = scoreItem({
    title: 'Looking for a NetSuite consultant to sync our orders',
    body: 'We need a saved search exported into our warehouse every night. Staff re-enter it by hand today. Budget around $4,000.',
    url: 'https://example.com/netsuite',
  }, compiled);

  assert.equal(netsuite.excluded, false, netsuite.reason);
  assert.ok(netsuite.matched.includes('specialty'), 'NetSuite should register as specialty work');
  assert.ok(netsuite.score >= compiled.minScore);

  const generic = scoreItem({
    title: 'Looking for a developer to sync our orders',
    body: 'We need a report exported into our warehouse every night. Staff re-enter it by hand today. Budget around $4,000.',
    url: 'https://example.com/generic',
  }, compiled);

  assert.equal(generic.excluded, false, generic.reason);
  assert.ok(netsuite.score > generic.score, 'specialty work should rank above generic work');
});

test('a NetSuite job ad from a recruiter is still not a lead', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  const scored = scoreItem({
    title: 'Hiring a NetSuite Developer — full-time, remote',
    body: "Our client is seeking a NetSuite developer with 8+ years of experience. Salary DOE, benefits package and 401k.",
    url: 'https://example.com/recruiter',
  }, compiled);
  assert.equal(scored.excluded, true);
});

test('Reddit searches queue behind subreddit feeds — same host, same rate limit', async () => {
  assert.equal(hostOf({ type: 'redditsearch', query: 'netsuite consultant' }), 'reddit');
  assert.equal(hostOf({ type: 'reddit', name: 'Netsuite' }), 'reddit');

  let inflight = 0;
  let peak = 0;
  const fetcher = async (s) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight -= 1;
    return [{ title: label(s), url: `https://x.com/${encodeURIComponent(label(s))}` }];
  };

  const { items, errors } = await collect([
    { type: 'reddit', name: 'Netsuite' },
    { type: 'redditsearch', query: 'netsuite consultant' },
    { type: 'redditsearch', query: 'netsuite integration' },
  ], { delayMs: 0, fetcher });

  assert.equal(peak, 1, 'search.rss hits reddit.com too — it must share the queue');
  assert.equal(items.length, 3);
  assert.deepEqual(errors, []);
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

test('parses the authenticated JSON listing the same way as the public feed', () => {
  const items = parseListing({
    data: {
      children: [
        {
          data: {
            title: '[Hiring] NetSuite consultant for an order sync',
            selftext: 'Budget around $4,000.',
            permalink: '/r/Netsuite/comments/abc123/hiring_netsuite/',
            author: 'opsmanager',
            created_utc: 1789000000,
          },
        },
        { data: { title: '', permalink: '/r/x/y/' } },
      ],
    },
  }, 'r/Netsuite');

  assert.equal(items.length, 1, 'a post with no title is not an item');
  assert.equal(items[0].url, 'https://www.reddit.com/r/Netsuite/comments/abc123/hiring_netsuite/');
  assert.equal(items[0].author, '/u/opsmanager');
  assert.equal(items[0].source, 'r/Netsuite');
  assert.match(items[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('the queue rotates daily so the throttled tail is not always the same sources', () => {
  const group = [
    { type: 'redditsearch', query: 'netsuite consultant', pin: true },
    { type: 'reddit', name: 'a' },
    { type: 'reddit', name: 'b' },
    { type: 'reddit', name: 'c' },
  ];
  const on = (day) => order(group, day).map((s) => s.name || s.query);

  assert.deepEqual(on(0), ['netsuite consultant', 'a', 'b', 'c']);
  assert.deepEqual(on(1), ['netsuite consultant', 'b', 'c', 'a']);
  assert.deepEqual(on(2), ['netsuite consultant', 'c', 'a', 'b']);
  assert.deepEqual(on(3), on(0), 'the rotation comes back around');

  // Whatever the day, nothing is dropped and the pinned source leads.
  for (const day of [0, 1, 2, 5, 11, 40]) {
    const names = on(day);
    assert.equal(names[0], 'netsuite consultant');
    assert.equal(new Set(names).size, group.length);
  }
});

test('the hunt config pins NetSuite to the front of the queue', async () => {
  const cfg = await hunt('freelance');
  const reddit = cfg.sources.filter((s) => hostOf(s) === 'reddit');
  const leading = order(reddit, 0).slice(0, 3).map((s) => s.name || s.query);
  for (const name of leading) {
    assert.match(name, /netsuite/i, `expected NetSuite sources to lead, got ${leading.join(', ')}`);
  }
});

test('a persistently throttled source is retried twice, then reported', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    throw new Error('429 Too Many Requests');
  };

  const { items, errors } = await collect(
    [{ type: 'reddit', name: 'msp' }],
    { delayMs: 0, retryMs: 0, fetcher },
  );

  assert.equal(calls, 3, 'one attempt plus two backoffs');
  assert.deepEqual(items, []);
  assert.deepEqual(errors, ['reddit:msp — 429 Too Many Requests (after 2 retries)']);
});

test('backoff grows between retries rather than hammering a throttled host', async () => {
  const waited = [];
  const realSleep = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waited.push(ms); return realSleep(fn, 0); };
  try {
    await collect([{ type: 'reddit', name: 'msp' }], {
      delayMs: 0,
      retryMs: 10,
      fetcher: async () => { throw new Error('429 Too Many Requests'); },
    });
  } finally {
    globalThis.setTimeout = realSleep;
  }
  assert.deepEqual(waited, [10, 30], 'second wait should be longer than the first');
});

test('a quiet run still explains itself', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  const items = [
    {
      // Scores on intent and budget but has no skill signal — the require gate.
      title: '[Hiring] Someone to walk my dog on Tuesdays',
      body: 'Paid, $40 a week.',
      url: 'https://example.com/dog',
    },
    {
      // Excluded outright by a pattern, so it is noise rather than a near miss.
      title: '[For Hire] Full stack developer, API and automation work',
      body: 'My rates are $60/hr.',
      url: 'https://example.com/forhire',
    },
    {
      title: '[Hiring] Need someone to sync our orders into QuickBooks automatically',
      body: 'Staff re-enter every order by hand. Budget $2,500.',
      url: 'https://example.com/real',
    },
  ];

  const counts = tally(items, compiled);
  assert.equal(counts.leads, 1);
  assert.equal(counts.gated, 1, 'the dog walker is gated, not excluded');
  assert.equal(counts.excluded, 1, '[For Hire] is excluded outright');

  const near = misses(items, compiled);
  assert.equal(near.length, 1, 'only the gated post is a near miss');
  assert.match(near[0].title, /dog/);
  assert.match(near[0].reason, /no skill signal/);
  assert.ok(!near.some((m) => /For Hire/.test(m.title)), 'excluded noise is not a near miss');
});

test('the report shows near misses so a zero-lead run is still readable', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  const near = misses([{
    title: '[Hiring] Someone to walk my dog on Tuesdays',
    body: 'Paid, $40 a week.',
    url: 'https://example.com/dog',
  }], compiled);

  const md = buildReport([], { hunt: { title: 'Leads' }, hours: 26, scanned: 189, misses: near });
  assert.match(md, /Nothing cleared the score threshold/);
  assert.match(md, /Closest misses \(1\)/);
  assert.match(md, /no skill signal/);
  assert.match(md, /example\.com\/dog/);
});

test('Craigslist only runs where the request comes from a residential IP', async () => {
  const cfg = await hunt('freelance');
  const craigslist = cfg.sources.filter((s) => s.type === 'craigslist');
  assert.ok(craigslist.length, 'Craigslist should be configured');
  assert.ok(craigslist.every((s) => s.local), 'every Craigslist source must be marked local');

  const hosted = selectSources(cfg.sources, { local: false });
  assert.ok(!hosted.some((s) => s.type === 'craigslist'), 'hosted runners would only get a 403');
  assert.equal(hosted.length, cfg.sources.length - craigslist.length, 'nothing else is dropped');

  const own = selectSources(cfg.sources, { local: true });
  assert.deepEqual(own, cfg.sources, 'your own machine runs everything');
});

test('HUNT_LOCAL opts in through the environment', () => {
  const sources = [{ type: 'reddit', name: 'forhire' }, { type: 'craigslist', name: 'milwaukee', local: true }];
  const was = process.env.HUNT_LOCAL;
  try {
    for (const [value, expected] of [['1', 2], ['true', 2], ['', 1], ['0', 1], ['no', 1]]) {
      process.env.HUNT_LOCAL = value;
      assert.equal(selectSources(sources).length, expected, `HUNT_LOCAL=${value}`);
    }
    delete process.env.HUNT_LOCAL;
    assert.equal(selectSources(sources).length, 1, 'unset means hosted');
  } finally {
    if (was === undefined) delete process.env.HUNT_LOCAL;
    else process.env.HUNT_LOCAL = was;
  }
});

test('the added searches carry buyer language, not job-board language', async () => {
  const cfg = await hunt('freelance');
  const queries = cfg.sources.filter((s) => s.type === 'redditsearch').map((s) => s.query);
  assert.ok(queries.length >= 5, `expected several searches, got ${queries.length}`);
  for (const q of queries) {
    assert.ok(q.trim().length > 3 && !/\n/.test(q), `malformed query: ${q}`);
    // Balanced quotes, or the OR syntax silently searches for the wrong thing.
    assert.equal((q.match(/"/g) || []).length % 2, 0, `unbalanced quotes: ${q}`);
  }
  assert.ok(queries.some((q) => /quickbooks/i.test(q)));
  assert.ok(queries.some((q) => /zapier|n8n/i.test(q)));
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

// Every one of these showed up as a "lead" in a live digest between 2026-09-16
// and 2026-09-24 and was not real work: recruiter listings with a leveling tag,
// self-ads phrased as buyer intent, and a rhetorical-question ad that reposted
// itself across subreddits three separate days.
test('three weeks of live false positives are rejected', async () => {
  const compiled = compileHunt(await hunt('freelance'));

  const junk = [
    {
      title: '[Hiring] Lead Monitoring and Observability Engineer (IC3) -Remote US',
      body: 'Our client is looking for a Lead Monitoring and Observability Engineer. This role is remote, US only. 8+ years of experience required.',
    },
    {
      title: 'PHP/Symfony developer looking for projects',
      body: "I'm a freelance PHP/Symfony developer with 6 years of experience, looking for projects. Portfolio and rates available on request.",
    },
    {
      title: 'Is there a retool alternative that doesnt need a developer?',
      body: 'We want an internal tool for our support team but nobody on staff can code. Looking for a no-code option, not looking to hire anyone.',
    },
    {
      title: 'Need a Developer? Too Expensive or Taking Too Long?',
      body: 'Check out our platform that matches you with vetted developers in 48 hours. Sign up free today.',
    },
    {
      title: 'Can a complete non-technical person build and publish a rating/review website using Replit',
      body: "I don't know how to code at all. Is it realistic to build something like this myself, or should I just accept I need a developer eventually?",
    },
  ];

  for (const [i, post] of junk.entries()) {
    const scored = scoreItem({ ...post, url: `https://example.com/live-junk${i}` }, compiled);
    assert.equal(scored.excluded, true, `should have been rejected: ${post.title}`);
  }
});

test('a genuine "hiring developer" post from the broad search still gets through', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  const scored = scoreItem({
    title: 'Hiring developer for below role',
    body: 'We need a developer to build a small internal dashboard syncing data from our API. Budget $3,000, paid on completion.',
    url: 'https://example.com/live-good',
  }, compiled);
  assert.equal(scored.excluded, false, scored.reason);
  assert.ok(scored.score >= compiled.minScore);
});

test('a mid-level contract role is not excluded just for saying "lead" once', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  // "leads" here is a noun (sales leads), not a job-title prefix — should not
  // trip the widened staff/senior/principal/lead exclude pattern.
  const scored = scoreItem({
    title: '[Hiring] Need a developer to build an internal dashboard tracking our sales leads',
    body: 'Small business, budget around $2,000. Paid gig, not a job posting.',
    url: 'https://example.com/live-leads-noun',
  }, compiled);
  assert.equal(scored.excluded, false, scored.reason);
});

test('the same post cross-posted to several subreddits is one lead, not several', () => {
  // This is the actual 2026-09-24 digest: one self-promo post, four subreddits,
  // four different URLs, listed as four separate "leads".
  const crossPosted = [
    { title: 'I built an app that finds freelance clients', author: '/u/Normal_Display_9541', url: 'https://www.reddit.com/r/buildinpublic/comments/1wof93r/x/' },
    { title: 'I built an app that finds freelance clients', author: '/u/Normal_Display_9541', url: 'https://www.reddit.com/r/betatests/comments/1wof7vd/x/' },
    { title: 'I built an app that finds freelance clients', author: '/u/Normal_Display_9541', url: 'https://www.reddit.com/r/SideProject/comments/1wof5jx/x/' },
  ];
  assert.equal(dedupe(crossPosted).length, 1);

  // Two different people who happen to share a title are not the same post.
  const coincidence = [
    { title: 'Need a Developer? Too Expensive or Taking Too Long?', author: '/u/alice', url: 'https://x.com/a' },
    { title: 'Need a Developer? Too Expensive or Taking Too Long?', author: '/u/bob', url: 'https://x.com/b' },
  ];
  assert.equal(dedupe(coincidence).length, 2);

  // No author on either side (e.g. Craigslist) falls back to the URL alone.
  const noAuthor = [
    { title: 'a', url: 'https://x.com/1' },
    { title: 'a', url: 'https://x.com/1?utm=rss' },
  ];
  assert.equal(dedupe(noAuthor).length, 1);
});

test('a post already reported in a past digest does not run again', async () => {
  const previousReport = await fixture('past-digest.md').catch(() => null);
  const seen = previousReport
    ? urlsFromReport(previousReport)
    : ['https://www.reddit.com/r/Netsuite/comments/abc/netsuite_help/'];

  assert.ok(seen.length > 0);
  const items = [
    { title: 'NetSuite help', url: 'https://www.reddit.com/r/Netsuite/comments/abc/netsuite_help/' },
    { title: 'Something brand new', url: 'https://www.reddit.com/r/forhire/comments/def/new/' },
  ];
  const left = unseen(items, seen);
  assert.deepEqual(left.map((i) => i.title), ['Something brand new']);
});

test('urlsFromReport pulls lead URLs but not near-misses or source failures', () => {
  const md = [
    '# Freelance leads',
    '',
    '## A real lead',
    '**9** · r/forhire · 1h ago',
    '',
    'https://example.com/lead1',
    '',
    '<details><summary>Closest misses (1)</summary>',
    '',
    '- **8** — no intent signal — [Not a lead](https://example.com/miss1)',
    '',
    '</details>',
    '',
    '**Sources that failed this run:**',
    '',
    '- reddit:forhire — 429 Too Many Requests for https://example.com/should-not-count',
  ].join('\n');

  assert.deepEqual(urlsFromReport(md), ['https://example.com/lead1']);
});

test('urlKey ignores query strings, trailing slashes, and case', () => {
  assert.equal(urlKey('https://x.com/a/?utm=rss'), urlKey('https://X.com/a'));
});

// 2026-09-25 verification run: a completely unrelated AR/VR headset review
// ("I decided not to wait for Phoenix", r/Xreal) scored 8 and made the digest.
// Reddit's own search confirms the literal phrase "need a developer" or "hire
// a developer" was somewhere in that long post — probably a tangential aside,
// not the post's topic — combined with the bare "dashboard" and generic
// "manually" both being common in any consumer-tech review. The post's actual
// text isn't reproduced here (Reddit isn't reachable to fetch it), so this
// synthesizes the same shape confirmed by the digest's own "why it matched"
// diagnostic: an intent phrase used off-topic, plus bare skill words that a
// product review would use for unrelated reasons.
test('an off-topic product review does not qualify just for a stray "need a developer" aside', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  const scored = scoreItem({
    title: 'I decided not to wait for Phoenix',
    body: 'With meta vr\'s 2.5k res per eye, extra fine detail may be lost. The heads-up dashboard '
      + 'overlay is nice once you adjust it manually. Honestly reddit would need a developer to fix '
      + 'search on this sub, it never finds anything.',
    url: 'https://example.com/live-offtopic-vr',
  }, compiled);
  assert.equal(scored.excluded, true, scored.reason);
});

test('bare "dashboard" and "database" still need a business qualifier, but real asks keep working', async () => {
  const compiled = compileHunt(await hunt('freelance'));
  const skill = compiled.signals.find((g) => g.name === 'skill');
  const fires = (text) => skill.regexes.some((re) => re.test(text));

  assert.ok(!fires('the in-headset dashboard is smooth and responsive'), 'a product-UI dashboard is not a business signal');
  assert.ok(!fires('exported everything into a local database for testing'), 'a bare database mention is not a business signal');
  assert.ok(fires('sync orders into our database automatically'), '"our database" is the real phrasing seen in live leads');
  assert.ok(fires('build us an internal dashboard for support tickets'), '"internal dashboard" is the real phrasing seen in live leads');
});
