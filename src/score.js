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

export function rank(items, compiled) {
  return items
    .map((it) => scoreItem(it, compiled))
    .filter((it) => !it.excluded && it.score >= compiled.minScore)
    .sort((a, b) => b.score - a.score || (b.at || '').localeCompare(a.at || ''));
}
