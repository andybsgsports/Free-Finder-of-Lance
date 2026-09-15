# lead-finder

Scans public feeds every morning for people who need integration, automation, or
internal-tool work, scores them, and files the good ones as a GitHub issue — which
emails you for free.

No API keys. No paid services. No dependencies.

**Sources:** r/forhire, r/jobbit, r/smallbusiness, r/Entrepreneur, r/nocode, r/shopify,
r/msp, Hacker News "SEEKING FREELANCER" threads, and Craigslist computer gigs in
Milwaukee, Chicago and Madison.

## Setup

1. Create an empty GitHub repo called `lead-finder` and push this folder to it.
2. That's it. The workflow runs daily at 8am Central and opens an issue when it finds
   anything. Watch the repo so issues email you.

Run it by hand any time:

```sh
npm run hunt                                          # today's leads in the terminal
node src/index.js --hunt freelance --hours 72 --out leads.md
```

Or trigger it in GitHub: **Actions → Daily hunt → Run workflow**.

## How scoring works

Each post is matched against signal groups defined in `hunts/freelance.json` — intent,
skill, pain, budget. A group scores its full weight on the first match, then half-weight
for each additional distinct pattern, capped at 2× — so a post stuffed with keywords
can't outrank a genuine request. Anything matching an `exclude` pattern is dropped
outright, which is how `[For Hire]` service offers, crypto work, and equity-only
"opportunities" stay out of your digest.

Posts scoring at or above `minScore` make the report, best first.

## Tuning it

Everything lives in `hunts/freelance.json` — no code changes needed.

- **Not enough results?** Lower `minScore`, or add subreddits to `sources`.
- **Too much noise?** Raise `minScore`, or add patterns to `exclude`.
- **Different city?** Change the Craigslist `name` fields to your metro's subdomain.
- **Different trade entirely?** Copy `hunts/freelance.json`, swap the keywords and
  sources, run `--hunt yourname`.

Patterns are JavaScript regular expressions, case-insensitive. An invalid one is skipped
with a warning rather than crashing the run.

## Limits worth knowing

- **It reads public feeds only** — Reddit's `.rss` endpoints, Craigslist's `?format=rss`,
  and the free Hacker News Algolia API. No logins, no scraping behind auth, no ToS games.
- **Reddit rate-limits anonymous requests.** If a source gets throttled the run degrades
  gracefully: every other source still reports, and the failure is listed at the bottom
  of the digest.
- **Scoring is heuristic, not clever.** It will miss oddly-worded requests and
  occasionally surface junk. Treat the digest as a shortlist to skim, not a verdict.
  Tune the patterns as you learn what actually converts.
- **Speed matters more than volume.** Most of these posts get answered within hours —
  a same-morning reply beats a better-written one two days later.
