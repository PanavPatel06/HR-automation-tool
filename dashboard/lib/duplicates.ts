import type { Row } from './contract';

/**
 * Redundancy checks on the Applicants tab.
 *
 * The sheet is maintained by hand and pasted into in bulk, so the same person
 * arriving twice is a matter of when, not if. Two kinds matter, and they are
 * not equally bad:
 *
 *   - A repeated `email` means somebody gets the same email twice. Annoying,
 *     visible, recoverable.
 *
 *   - A repeated `applicant_id` is worse and completely silent. Every action
 *     resolves a row with `applicants.find(a => a.applicant_id === id)`, which
 *     returns the *first* match — so approving or emailing the second row
 *     actually acts on the first one. You would see a success banner naming
 *     the right person and the wrong row would move. Nothing in the sheet
 *     enforces uniqueness, so this is the check that earns its keep.
 *
 * Deliberately not treated as duplicates: two people at the same company, or
 * the same name twice (Priya Shah is not a rare name). Only the two fields the
 * code actually keys on.
 */

export type DuplicateKind = 'applicant_id' | 'email';

export type DuplicateGroup = {
  kind: DuplicateKind;
  /** The repeated value, normalised — lower-cased and trimmed for email. */
  value: string;
  /** Every row sharing it, in sheet order. Always length >= 2. */
  rows: Row[];
};

function groupBy(rows: Row[], key: (r: Row) => string): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}

/** Every repeated applicant_id and email, worst kind first. */
export function findDuplicates(applicants: Row[]): DuplicateGroup[] {
  const rows = (applicants || []).filter((a) => a.applicant_id);
  const out: DuplicateGroup[] = [];

  for (const [value, group] of groupBy(rows, (r) => String(r.applicant_id ?? '').trim())) {
    if (group.length > 1) out.push({ kind: 'applicant_id', value, rows: group });
  }
  for (const [value, group] of groupBy(rows, (r) => String(r.email ?? '').trim().toLowerCase())) {
    if (group.length > 1) out.push({ kind: 'email', value, rows: group });
  }

  return out;
}

/**
 * The applicant_ids caught up in any duplicate group, for flagging rows in a
 * list. A Set because the list renders this per row.
 */
export function duplicateIds(groups: DuplicateGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) for (const r of g.rows) ids.add(r.applicant_id);
  return ids;
}

/** One line for a banner or a preflight check. */
export function describeDuplicates(groups: DuplicateGroup[]): string {
  if (!groups.length) return 'no repeated ids or addresses';
  return groups
    .map((g) => `${g.kind === 'applicant_id' ? 'id' : 'email'} "${g.value}" on ${g.rows.length} rows (sheet rows ${g.rows.map((r) => r._row).join(', ')})`)
    .join('; ');
}
