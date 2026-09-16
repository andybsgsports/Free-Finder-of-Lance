// Public, no-auth feeds only. Atom (Reddit), RSS/RDF (Craigslist), JSON (HN Algolia).

const UA = 'free-finder-of-lance/1.0 (personal daily digest; contact via GitHub)';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decode(text = '') {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e]);
}

export function stripHtml(html = '') {
  return decode(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
}

function linkOf(block) {
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (href) return decode(href[1]);
  return tag(block, 'link');
}

// Handles both <entry> (Atom) and <item> (RSS/RDF) in one pass.
export function parseFeed(xml, source) {
  const blocks = xml.match(/<(entry|item)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  return blocks.map((block) => {
    const body = tag(block, 'content') || tag(block, 'description') || tag(block, 'summary');
    const when = tag(block, 'updated') || tag(block, 'dc:date') || tag(block, 'pubDate') || tag(block, 'published');
    return {
      source,
      title: stripHtml(tag(block, 'title')),
      body: stripHtml(body).slice(0, 2000),
      url: linkOf(block),
      author: stripHtml(tag(block, 'name') || tag(block, 'dc:creator')),
      at: when ? new Date(when).toISOString() : null,
    };
  }).filter((it) => it.title && it.url);
}

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return as === 'json' ? res.json() : res.text();
}

// Reddit's logged-in API allows 100 requests a minute per app; anonymous traffic
// from a datacenter IP gets a far smaller share, and Actions runners share their
// reputation with every other scraper on the range. Set REDDIT_CLIENT_ID and
// REDDIT_CLIENT_SECRET and the throttling stops. Without them this still works,
// it just loses sources to 429s.
let tokenPromise = null;

async function requestToken(id, secret) {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('no access_token in the response');
  return data.access_token;
}

// One token per run, and a failed login degrades to anonymous rather than
// taking every Reddit source down with it.
function redditToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return Promise.resolve(null);
  if (!tokenPromise) {
    tokenPromise = requestToken(id, secret).catch((err) => {
      console.warn(`warn: Reddit login failed (${err.message}) — falling back to anonymous feeds`);
      return null;
    });
  }
  return tokenPromise;
}

// The authenticated host answers the same paths with JSON; the public host wants
// `.rss` on the end and answers with Atom. Same paths either way.
async function redditGet(path, params, source) {
  const token = await redditToken();
  const qs = new URLSearchParams({ ...params, limit: 100 }).toString();
  if (!token) return parseFeed(await get(`https://www.reddit.com${path}.rss?${qs}`), source);

  const url = `https://oauth.reddit.com${path}?${qs}`;
  const res = await fetch(url, { headers: { authorization: `bearer ${token}`, 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return parseListing(await res.json(), source);
}

export function parseListing(json, source) {
  return (json?.data?.children || []).map(({ data: d = {} }) => ({
    source,
    title: stripHtml(d.title || ''),
    body: stripHtml(d.selftext || '').slice(0, 2000),
    url: d.permalink ? `https://www.reddit.com${d.permalink}` : d.url || '',
    author: d.author ? `/u/${d.author}` : '',
    at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
  })).filter((it) => it.title && it.url);
}

export function fetchReddit(subreddit, { sort = 'new' } = {}) {
  return redditGet(`/r/${subreddit}/${sort}`, {}, `r/${subreddit}`);
}

// Searches all of Reddit rather than one subreddit — catches a request for a
// niche skill wherever it happens to get posted.
export function fetchRedditSearch(query, { sort = 'new', time = 'week' } = {}) {
  return redditGet('/search', { q: query, sort, t: time }, `reddit:"${query}"`);
}

export async function fetchCraigslist(city, section = 'cpg') {
  const xml = await get(`https://${city}.craigslist.org/search/${section}?format=rss`);
  return parseFeed(xml, `craigslist/${city}`);
}

// Algolia indexes every HN comment, so searching the phrase finds the posts directly.
export async function fetchHackerNews(query, { hitsPerPage = 100 } = {}) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}`
    + `&tags=comment&hitsPerPage=${hitsPerPage}`;
  const data = await get(url, 'json');
  return (data.hits || []).map((hit) => ({
    source: 'hackernews',
    title: stripHtml(hit.story_title || 'HN comment'),
    body: stripHtml(hit.comment_text || '').slice(0, 2000),
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    author: hit.author || '',
    at: hit.created_at || null,
  })).filter((it) => it.body);
}

export const label = (s) => `${s.type}:${s.name || s.query}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fetchSource(s) {
  if (s.type === 'reddit') return fetchReddit(s.name, s);
  if (s.type === 'redditsearch') return fetchRedditSearch(s.query, s);
  if (s.type === 'craigslist') return fetchCraigslist(s.name, s.section);
  if (s.type === 'hackernews') return fetchHackerNews(s.query, s);
  return Promise.reject(new Error(`unknown source type: ${s.type}`));
}

// Throttling is per *host*, not per source type — subreddit feeds and Reddit
// searches hit the same server and share the same rate limit.
export const hostOf = (s) => (s.type === 'redditsearch' ? 'reddit' : s.type);

// A serialized queue always burns its tail: the last sources in the list are the
// ones Reddit throttles, run after run, so they never contribute. Rotating the
// order by the day gives every source a turn at the front. Sources marked `pin`
// stay there — those are the ones you actually care about.
export function order(group, day = Math.floor(Date.now() / 86_400_000)) {
  const pinned = group.filter((s) => s.pin);
  const rest = group.filter((s) => !s.pin);
  if (rest.length < 2) return [...pinned, ...rest];
  const at = ((day % rest.length) + rest.length) % rest.length;
  return [...pinned, ...rest.slice(at), ...rest.slice(0, at)];
}

// Retry only on 429, with a longer wait each time — a throttled host needs more
// than a moment, and hammering it is what got us throttled in the first place.
async function attempt(fetcher, source, waits) {
  for (let i = 0; ; i += 1) {
    try {
      return { items: await fetcher(source) };
    } catch (err) {
      if (!/429/.test(err.message) || i >= waits.length) {
        const tail = i ? ` (after ${i} ${i === 1 ? 'retry' : 'retries'})` : '';
        return { error: `${label(source)} — ${err.message}${tail}` };
      }
      await sleep(waits[i]);
    }
  }
}

// Reddit rate-limits anonymous traffic hard, so requests to one host go one at a
// time with a gap between them. Different hosts still run in parallel.
export async function collect(sources, { delayMs = 4000, retryMs = 12000, fetcher = fetchSource, day } = {}) {
  const byHost = new Map();
  for (const s of sources) {
    const host = hostOf(s);
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(s);
  }

  const items = [];
  const errors = [];
  const waits = [retryMs, retryMs * 3];

  await Promise.all([...byHost.values()].map(async (group) => {
    for (const [i, source] of order(group, day).entries()) {
      if (i > 0) await sleep(delayMs);
      const result = await attempt(fetcher, source, waits);
      if (result.error) errors.push(result.error);
      else items.push(...result.items);
    }
  }));

  return { items, errors };
}

// Craigslist blocks datacenter IPs, so sources marked `local` only run where the
// request leaves from a residential address — your own machine, or a self-hosted
// Actions runner. On GitHub's hosted runners they would just 403 every morning
// and clutter the report with the same failure.
export function selectSources(sources, { local } = {}) {
  const enabled = local ?? /^(1|true|yes)$/i.test(process.env.HUNT_LOCAL || '');
  return sources.filter((s) => !s.local || enabled);
}

export function withinHours(items, hours) {
  const cutoff = Date.now() - hours * 3600_000;
  return items.filter((it) => !it.at || new Date(it.at).getTime() >= cutoff);
}

export function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = it.url.split('?')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
