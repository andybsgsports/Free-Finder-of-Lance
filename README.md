# Free Finder of Lance

Scans public feeds every morning for people who need integration, automation, or
internal-tool work, scores them, and files the good ones as a GitHub issue — which
emails you for free.

No API keys. No paid services. No dependencies.

**Sources:** r/forhire, r/jobbit, r/smallbusiness, r/Entrepreneur, r/nocode, r/shopify,
r/msp, r/webdev, r/Netsuite, Hacker News "SEEKING FREELANCER" threads, site-wide Reddit
searches (NetSuite, QuickBooks, Zapier/n8n, "hire a developer"), and Craigslist computer
gigs when you run it somewhere Craigslist will talk to — see below.

Job boards are deliberately absent. Indeed retired its Publisher API and ZipRecruiter's is
partner-only, but the real reason is that both list *employment* — employers with reqs and
staffing agencies with placements. The `exclude` list here is already most of a description
of a job board (`full-time`, `W2`, `401k`, `benefits package`, `salary`, `our client's`,
`ideal candidate`, `years of experience`). Feeding it job boards adds volume, not leads.

## Setup

1. Create an empty GitHub repo called `free-finder-of-lance` and push this folder to it.
2. That's it. The workflow runs daily at 8am Central and opens an issue when it finds
   anything. Watch the repo so issues email you.

Run it by hand any time:

```sh
npm run hunt                                          # today's leads in the terminal
node src/index.js --hunt freelance --hours 72 --out leads.md
```

Or trigger it in GitHub: **Actions → Daily hunt → Run workflow**.

### Optional: stop Reddit throttling the run (2 minutes, free)

Anonymous Reddit traffic from a datacenter IP gets a small rate-limit budget,
shared with every other scraper on GitHub's runners — a long queue loses its tail
to `429`s every run. A logged-in app gets 100 requests a minute of its own.

1. Go to <https://www.reddit.com/prefs/apps> → **create another app**.
2. Pick **script**, give it any name, put `http://localhost` as the redirect URI.
3. Copy the client ID (the string under the app name) and the secret.
4. In this repo: **Settings → Secrets and variables → Actions → New repository
   secret**. Add `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`.

Nothing else changes. The code uses the authenticated API when those exist and
falls back to the public feeds when they don't — including when the login itself
fails, which is logged rather than taking the run down.

### Optional: run it on your own machine to unlock Craigslist

Craigslist blocks datacenter IPs outright, so it 403s from GitHub's runners every
time. Craigslist computer gigs is worth having — it is one of the few places a
small business owner directly posts "I will pay someone to fix this" — so those
sources are marked `"local": true` and skipped unless the run comes from a
residential address.

To get them, point the workflow at a runner on a machine you leave on:

1. Repo **Settings → Actions → Runners → New self-hosted runner**, and follow the
   platform instructions. Run it as a service so it survives a reboot.
2. Repo **Settings → Secrets and variables → Actions → Variables → New repository
   variable**: name `HUNT_RUNNER`, value `self-hosted`.

That is the whole switch. `runs-on` picks up the variable, `HUNT_LOCAL` turns on
the `local` sources, and the Reddit throttling largely goes away too — it is the
same datacenter-IP problem. Leave the variable unset and everything runs on
GitHub exactly as it does today.

Edit the `craigslist` entries in `hunts/freelance.json` to your own metro — they
ship pointed at Milwaukee and Chicago. The city is the subdomain in a Craigslist
URL, and `cpg` is the computer-gigs section.

To run it locally by hand instead, `HUNT_LOCAL=1 npm run hunt`.

## How scoring works

Each post is matched against signal groups defined in `hunts/freelance.json` — intent,
skill, specialty, pain, budget. A group scores its full weight on the first match, then half-weight
for each additional distinct pattern, capped at 2× — so a post stuffed with keywords
can't outrank a genuine request. Anything matching an `exclude` pattern is dropped
outright, which is how `[For Hire]` service offers, crypto work, and equity-only
"opportunities" stay out of your digest.

Signals listed in `require` are mandatory — a post must show both hiring **intent** and
a **skill** match to qualify, no matter how high it scores otherwise. Without that gate
the digest fills up with people hiring for things you don't do; the first live run
proudly surfaced a butcher.

The **specialty** group is the thumb on the scale: NetSuite, SuiteScript, SuiteFlow,
RESTlets, saved searches, Celigo/Boomi/Workato. It isn't required, so general automation
work still gets through — but a NetSuite request outscores an otherwise identical generic
one and lands at the top of the digest.

Posts scoring at or above `minScore` make the report, best first.

A run that finds nothing still says why: the log prints a breakdown (leads, gated
for a missing required signal, below `minScore`, excluded outright) and the report
carries a collapsed **Closest misses** list. A silent run and a broken one look
identical otherwise, and they need opposite fixes.

## Tuning it

Everything lives in `hunts/freelance.json` — no code changes needed.

- **Not enough results?** Lower `minScore`, or add subreddits to `sources`.
- **Chasing a specific skill?** Add `{ "type": "redditsearch", "query": "your phrase" }`
  to `sources`. That searches all of Reddit rather than one subreddit, so a request gets
  found wherever it happens to get posted. Searches count against the same Reddit rate
  limit as subreddit feeds, so add them a couple at a time.
- **Something you never want to miss?** Add `"pin": true` to that source. Reddit requests
  go one at a time, and a throttled run loses whatever is at the back of the queue —
  pinned sources are always at the front. Everything else rotates by the day, so over a
  week each source gets its turn leading instead of the same ones losing every time.
- **Too much noise?** Raise `minScore`, or add patterns to `exclude`.
- **Different trade entirely?** Copy `hunts/freelance.json`, swap the keywords and
  sources, run `--hunt yourname`.
- **Craigslist?** The fetcher supports it (`{ "type": "craigslist", "name": "milwaukee",
  "section": "cpg" }`) but Craigslist blocks datacenter IPs, so it 403s from GitHub
  Actions. Add it only if you run the hunt from your own machine.

Patterns are JavaScript regular expressions, case-insensitive. An invalid one is skipped
with a warning rather than crashing the run.

## Limits worth knowing

- **It reads public feeds only** — Reddit's `.rss` endpoints and the free Hacker News
  Algolia API. No logins, no scraping behind auth, no ToS games.
- **Reddit rate-limits anonymous requests hard.** Requests to a single host go one at a
  time with a 1.5s gap, and a 429 gets one retry after a pause — without that, firing
  all the subreddits at once gets most of them throttled. If a source still fails the
  run degrades gracefully: every other source reports, and the failure is listed at the
  bottom of the digest.
- **Scoring is heuristic, not clever.** It will miss oddly-worded requests and
  occasionally surface junk. Treat the digest as a shortlist to skim, not a verdict.
  Tune the patterns as you learn what actually converts.
- **Speed matters more than volume.** Most of these posts get answered within hours —
  a same-morning reply beats a better-written one two days later.
