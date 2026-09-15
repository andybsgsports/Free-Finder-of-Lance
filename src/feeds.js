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

export async function fetchReddit(subreddit, { sort = 'new' } = {}) {
  const xml = await get(`https://www.reddit.com/r/${subreddit}/${sort}.rss?limit=100`);
  return parseFeed(xml, `r/${subreddit}`);
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
  if (s.type === 'craigslist') return fetchCraigslist(s.name, s.section);
  if (s.type === 'hackernews') return fetchHackerNews(s.query, s);
  return Promise.reject(new Error(`unknown source type: ${s.type}`));
}

// Reddit rate-limits anonymous traffic hard, so requests to one host go one at a
// time with a gap between them. Different hosts still run in parallel.
export async function collect(sources, { delayMs = 1500, retryMs = 5000, fetcher = fetchSource } = {}) {
  const byHost = new Map();
  for (const s of sources) {
    if (!byHost.has(s.type)) byHost.set(s.type, []);
    byHost.get(s.type).push(s);
  }

  const items = [];
  const errors = [];

  await Promise.all([...byHost.values()].map(async (group) => {
    for (const [i, source] of group.entries()) {
      if (i > 0) await sleep(delayMs);
      try {
        items.push(...await fetcher(source));
      } catch (err) {
        if (!/429/.test(err.message)) {
          errors.push(`${label(source)} — ${err.message}`);
          continue;
        }
        try {
          await sleep(retryMs);
          items.push(...await fetcher(source));
        } catch (retryErr) {
          errors.push(`${label(source)} — ${retryErr.message} (after retry)`);
        }
      }
    }
  }));

  return { items, errors };
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
