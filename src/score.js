// Pure scoring. No network, no DOM — everything here is unit-tested.

function compile(patterns, label) {
  return patterns.flatMap((p) => {
    try {
      return [new RegExp(p, 'i')];
    } catch {
      console.warn(`skipping invalid pattern in ${label}: ${p}`);
      return [];
    }
  });
}

export function compileHunt(hunt) {
  const signals = Object.entries(hunt.signals || {}).map(([name, cfg]) => ({
    name,
    weight: cfg.weight ?? 1,
    regexes: compile(cfg.patterns || [], `signals.${name}`),
  }));
  return {
    ...hunt,
    signals,
    excludeRegexes: compile(hunt.exclude || [], 'exclude'),
    minScore: hunt.minScore ?? 4,
    require: hunt.require || [],
  };
}

// A group scores its full weight on first hit, then half-weight per additional
// distinct pattern, capped at 2x. Stops keyword-stuffed posts from dominating.
function groupScore(text, group) {
  const hits = group.regexes.filter((re) => re.test(text));
  if (!hits.length) return { points: 0, patterns: [] };
  return {
    points: Math.min(group.weight * (1 + 0.5 * (hits.length - 1)), group.weight * 2),
    patterns: hits.map((re) => re.source),
  };
}

export function scoreItem(item, compiled) {
  const text = `${item.title}\n${item.body}`;
  const excluded = compiled.excludeRegexes.find((re) => re.test(text));
  if (excluded) {
    return { ...item, score: 0, excluded: true, reason: `excluded by ${excluded.source}`, matched: [] };
  }

  let score = 0;
  const matched = [];
  const why = {};
  for (const group of compiled.signals) {
    const { points, patterns } = groupScore(text, group);
    if (points > 0) {
      score += points;
      matched.push(group.name);
      why[group.name] = patterns;
    }
  }

  // "Someone is hiring, and money exists" is not a lead — it has to be work you
  // could actually do. Required signals gate the result no matter how high it scores.
  const missing = compiled.require.filter((name) => !matched.includes(name));
  if (missing.length) {
    return {
      ...item,
      score: Number(score.toFixed(1)),
      excluded: true,
      reason: `no ${missing.join('/')} signal`,
      matched,
    };
  }

  return { ...item, score: Number(score.toFixed(1)), excluded: false, matched, why };
}

// Everything that scored but did not make the cut, best first. Without this a
// quiet run is indistinguishable from a broken one: "0 leads from 189 posts"
// could mean the filter is working or that it rejects everything.
export function misses(items, compiled, limit = 8) {
  return items
    .map((it) => scoreItem(it, compiled))
    .filter((it) => (it.excluded || it.score < compiled.minScore) && it.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// How each post was disposed of, for the one-line summary in the run log.
export function tally(items, compiled) {
  const counts = { leads: 0, gated: 0, tooLow: 0, excluded: 0 };
  for (const it of items) {
    const scored = scoreItem(it, compiled);
    if (scored.excluded) counts[/^excluded by/.test(scored.reason) ? 'excluded' : 'gated'] += 1;
    else if (scored.score < compiled.minScore) counts.tooLow += 1;
    else counts.leads += 1;
  }
  return counts;
}

export function rank(items, compiled) {
  return items
    .map((it) => scoreItem(it, compiled))
    .filter((it) => !it.excluded && it.score >= compiled.minScore)
    .sort((a, b) => b.score - a.score || (b.at || '').localeCompare(a.at || ''));
}
