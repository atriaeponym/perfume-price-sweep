// Minimal robots.txt reader: groups for our user agent or '*', longest match
// wins, Allow beats Disallow on equal length, '*' and '$' wildcards.

export interface Robots {
  allowed(url: string): boolean;
  crawlDelaySeconds: number | null;
  refused?: boolean; // the shop refused its robots.txt itself (a shop read with a browser): nothing is read
}

interface Rule {
  allow: boolean;
  pattern: string;
}

function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export function parseRobots(text: string, agent: string): Robots {
  const token = agent.split('/')[0].toLowerCase();
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((key === 'allow' || key === 'disallow') && value) current.rules.push({ allow: key === 'allow', pattern: value });
    if (key === 'crawl-delay') current.delay = Number(value) || null;
  }

  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && (token.includes(a) || a.startsWith(token))));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== null);

  return {
    crawlDelaySeconds: delays.length ? Math.max(...delays) : null,
    allowed(url: string) {
      const u = new URL(url);
      const path = u.pathname + u.search;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!toRegExp(r.pattern).test(path)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) {
          best = r;
        }
      }
      return best ? best.allow : true;
    },
  };
}
