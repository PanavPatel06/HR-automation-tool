/**
 * Zoho's Mail API expects address fields to contain an email address, not an
 * RFC-style display name such as `Hiring Team <hiring@example.com>`.
 * Accept that friendly form in configuration, but send only the mailbox.
 */
export function normalizeEmailAddress(value: unknown): string | null {
  const input = String(value ?? '').trim();
  if (!input) return null;

  const displayAddress = input.match(/<\s*([^<>]+?)\s*>/);
  const address = (displayAddress?.[1] ?? input).trim();
  const valid = /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
  return valid.test(address) ? address : null;
}
