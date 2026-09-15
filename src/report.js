function age(at) {
  if (!at) return 'unknown';
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function snippet(item, chars = 260) {
  const body = item.body || '';
  if (body.length <= chars) return body;
  return `${body.slice(0, chars).trimEnd()}…`;
}

export function buildReport(hits, { hunt, hours, errors = [], scanned = 0 }) {
  const lines = [];
  lines.push(`# ${hunt.title}`);
  lines.push('');
  lines.push(`_${hits.length} lead${hits.length === 1 ? '' : 's'} from ${scanned} posts in the last ${hours}h · ${new Date().toUTCString()}_`);
  lines.push('');

  if (!hits.length) {
    lines.push('Nothing cleared the score threshold this run.');
  }

  for (const hit of hits) {
    lines.push(`## ${hit.title}`);
    lines.push('');
    lines.push(`**${hit.score}** · ${hit.source} · ${age(hit.at)}${hit.author ? ` · ${hit.author}` : ''} · matched: ${hit.matched.join(', ')}`);
    lines.push('');
    if (hit.body) {
      lines.push(`> ${snippet(hit).replace(/\n/g, ' ')}`);
      lines.push('');
    }
    lines.push(`${hit.url}`);
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
