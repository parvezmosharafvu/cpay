// Lightning address names (the part before @). The server accepts more
// (any RFC 5322 unquoted local part, lowercased); the wallet offers a plain
// subset that reads the same everywhere and cannot look like a path or a
// different address.
export const LIGHTNING_NAME_MAX = 32;

export function lightningName(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return { ok: false, why: 'Type a name.' };
  if (value.length > LIGHTNING_NAME_MAX) return { ok: false, why: `Use at most ${LIGHTNING_NAME_MAX} characters.` };
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value) || /[._-]{2}/.test(value)) {
    return { ok: false, why: 'Use lowercase letters and digits, with single dots, dashes or underscores between them.' };
  }
  return { ok: true, value };
}
