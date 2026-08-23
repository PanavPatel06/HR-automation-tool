/** Presentation helpers shared across pages. */

export function timeAgo(iso: string | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 0) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // A fixed locale, not `undefined`: the server (Node's ICU default) and the
  // browser (the visitor's locale) can otherwise pick different formats for
  // the same Date — 24-hour vs. 12-hour is exactly what happened here — which
  // React then flags as a hydration mismatch and re-renders the whole tree.
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}

export function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
