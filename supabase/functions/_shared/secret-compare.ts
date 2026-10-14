// Compare a presented secret with the expected one without an early exit on
// the first differing character. An empty expected secret never matches, so
// an unset env var refuses every request instead of accepting an empty header.
export function secretMatches(presented: string | null | undefined, expected: string | null | undefined): boolean {
  const a = new TextEncoder().encode(String(presented ?? ""));
  const b = new TextEncoder().encode(String(expected ?? ""));
  if (b.length === 0) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i % (a.length || 1)] ?? 0) ^ b[i];
  return diff === 0 && a.length === b.length;
}
