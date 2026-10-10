/**
 * Client-side search tokens.
 *
 * Firestore has no full-text index, and this app has no server key for a
 * hosted search service. Each save writes a short list of lowercase words
 * and title prefixes. A query then uses one array-contains lookup (the
 * longest word) and checks the remaining words on the small result set.
 * A sheriff's first visit to Search backfills records that predate the field.
 */

const MAX_TOKENS = 80;
const MAX_TITLE_WORDS = 24;
const MAX_BODY_WORDS = 40;
const MAX_PREFIX = 12;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && word.length <= 40);
}

function addWord(tokens: Set<string>, word: string, prefixes: boolean) {
  if (tokens.size >= MAX_TOKENS) return;
  tokens.add(word);
  if (!prefixes) return;
  const cap = Math.min(word.length, MAX_PREFIX);
  for (let length = 3; length < cap; length += 1) {
    if (tokens.size >= MAX_TOKENS) return;
    tokens.add(word.slice(0, length));
  }
}

export function searchTokensFrom(input: { title?: string; body?: string }): string[] {
  const tokens = new Set<string>();
  for (const word of words(input.title || "").slice(0, MAX_TITLE_WORDS)) {
    addWord(tokens, word, true);
  }
  for (const word of words((input.body || "").slice(0, 600)).slice(0, MAX_BODY_WORDS)) {
    addWord(tokens, word, false);
  }
  if (tokens.size === 0) tokens.add("z");
  return [...tokens].slice(0, MAX_TOKENS);
}

export function queryWords(raw: string): string[] {
  return words(raw.trim());
}

/** Longest word is the most selective array-contains probe. */
export function queryProbe(raw: string): string | null {
  const list = queryWords(raw);
  if (list.length === 0) return null;
  return list.reduce((best, word) => (word.length > best.length ? word : best));
}

export function matchesQuery(raw: string, haystack: string, tokens: string[] = []): boolean {
  const list = queryWords(raw);
  if (list.length === 0) return false;
  const blob = haystack.toLowerCase();
  return list.every(
    (word) => blob.includes(word) || tokens.some((token) => token.startsWith(word) || word.startsWith(token))
  );
}
