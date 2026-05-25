// Minimal cron expression parser supporting the standard 5-field form:
//   minute  hour  day-of-month  month  day-of-week
// Each field: '*', integer, comma list, range a-b, step */n or a-b/n.
// Returns the next firing Date after `from` (UTC interpretation).

type FieldSpec = number[];

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month
  [0, 6],  // dow (0 = Sun)
];

function expandField(token: string, idx: number): FieldSpec {
  const [min, max] = RANGES[idx]!;
  const all: number[] = [];
  for (const part of token.split(',')) {
    let step = 1;
    let core = part;
    if (part.includes('/')) {
      const [a, b] = part.split('/');
      core = a ?? '*';
      step = parseInt(b ?? '1', 10) || 1;
    }
    let from = min;
    let to = max;
    if (core === '*' || core === '') {
      // full range
    } else if (core.includes('-')) {
      const [a, b] = core.split('-');
      from = parseInt(a ?? `${min}`, 10);
      to = parseInt(b ?? `${max}`, 10);
    } else {
      from = parseInt(core, 10);
      to = from;
    }
    for (let v = from; v <= to; v += step) {
      if (v >= min && v <= max) all.push(v);
    }
  }
  return Array.from(new Set(all)).sort((a, b) => a - b);
}

export function parseCron(expr: string): FieldSpec[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields, got ${parts.length}`);
  return parts.map((p, i) => expandField(p, i));
}

export function nextCronFire(expr: string, from: Date = new Date()): Date {
  const fields = parseCron(expr);
  // Search up to ~4 years (covers leap edge cases)
  const start = new Date(from.getTime() + 60_000 - (from.getTime() % 60_000));
  for (let mins = 0; mins < 60 * 24 * 366 * 4; mins++) {
    const d = new Date(start.getTime() + mins * 60_000);
    const m = d.getUTCMinutes();
    const h = d.getUTCHours();
    const dom = d.getUTCDate();
    const mon = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();
    if (
      fields[0]!.includes(m) &&
      fields[1]!.includes(h) &&
      fields[2]!.includes(dom) &&
      fields[3]!.includes(mon) &&
      fields[4]!.includes(dow)
    ) {
      return d;
    }
  }
  throw new Error(`no cron fire within 4 years: ${expr}`);
}
