function age(at) {
  if (!at) return 'unknown';
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// Shows the exact patterns that fired, so a bad match points straight at the
// keyword to fix instead of leaving you guessing.
function whyLines(hit) {
  return Object.entries(hit.why || {})
    .map(([group, patterns]) => `- **${group}**: \`${patterns.slice(0, 3).join('`, `')}\``)
    .join('\n');
}

function snippet(item, chars = 260) {
  const body = item.body || '';
  if (body.length <= chars) return body;
  return `${body.slice(0, chars).trimEnd()}…`;
}

export function buildReport(hits, { hunt, hours, errors = [], scanned = 0, misses = [] }) {
  const lines = [];
  lines.push(`# ${hunt.title}`);
  lines.push('');
  lines.push(`_${hits.length} lead${hits.length === 1 ? '' : 's'} from ${scanned} posts in the last ${hours}h · ${new Date().toUTCString()}_`);
  lines.push('');

  if (!hits.length) {
    lines.push('Nothing cleared the score threshold this run.');
    lines.push('');
  }

  for (const hit of hits) {
    lines.push(`## ${hit.title}`);
    lines.push('');
    lines.push(`**${hit.score}** · ${hit.source} · ${age(hit.at)}${hit.author ? ` · ${hit.author}` : ''}`);
    lines.push('');
    if (hit.body) {
      lines.push(`> ${snippet(hit).replace(/\n/g, ' ')}`);
      lines.push('');
    }
    lines.push(`${hit.url}`);
    lines.push('');
    lines.push(`<details><summary>why it matched</summary>\n\n${whyLines(hit)}\n</details>`);
    lines.push('');
  }

  if (misses.length) {
    lines.push('---');
    lines.push('');
    lines.push(`<details><summary>Closest misses (${misses.length})</summary>`);
    lines.push('');
    for (const miss of misses) {
      lines.push(`- **${miss.score}** — ${miss.reason || 'below threshold'} — [${miss.title}](${miss.url})`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  if (errors.length) {
    lines.push('---');
    lines.push('');
    lines.push('**Sources that failed this run:**');
    lines.push('');
    for (const err of errors) lines.push(`- ${err}`);
    lines.push('');
  }

  return lines.join('\n');
}

// The lead URLs a digest reported — each sits alone on its own line under its
// heading. Near misses and failed sources are left out: only leads count as seen.
export function urlsFromReport(md = '') {
  const leads = md.split(/<details><summary>Closest misses|^\*\*Sources that failed/m)[0];
  return [...leads.matchAll(/^(https?:\/\/\S+)$/gm)].map((m) => m[1]);
}
