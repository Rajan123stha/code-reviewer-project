// Formatting for display. Pure functions, unit-tested.

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');

/** 1,284 below ten thousand, 12.9K above. */
export function count(value: number): string {
  return Math.abs(value) < 10_000 ? whole.format(value) : compact.format(value);
}

/** Share as a percentage; "—" when there is no denominator. */
export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function ratio(part: number, whole: number, digits = 0): string {
  return whole > 0 ? percent(part / whole, digits) : '—';
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** 850 ms, 12.4 s, 3 min 5 s. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

export function tokens(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : count(value);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 14 * 86_400) return `${Math.floor(seconds / 86_400)} d ago`;
  return shortDate(iso);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function dateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** snake_case or kebab-case to words: "resolved_with_change" -> "Resolved with change". */
export function humanize(value: string): string {
  const words = value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\bapi\b/gi, 'API');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
